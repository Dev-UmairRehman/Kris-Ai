'use strict';

/* ---------------------------------------------------------------------------
   End-to-end embed test.

   Stands up a fake Uscreen parent page on a DIFFERENT origin (127.0.0.1 vs
   localhost are separate origins to the browser), iframes /embed into it,
   runs the real identity bridge from uscreen/head-code.html, and checks the
   widget boots, authenticates and answers - i.e. the whole integration path,
   not just the app in isolation.

   Usage: node scripts/test-embed.js [widgetOrigin] [parentPort]
   --------------------------------------------------------------------------- */

const fs = require('fs');
const path = require('path');
const http = require('http');
const puppeteer = require('puppeteer-core');

const WIDGET = process.argv[2] || 'http://127.0.0.1:8080';
const PARENT_PORT = Number(process.argv[3] || 8099);
const PARENT = 'http://localhost:' + PARENT_PORT;
const OUT = path.join(__dirname, '..', '.shots');

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find((p) => fs.existsSync(p));

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  if (ok) {
    pass++;
    console.log('  PASS  ' + label);
  } else {
    fail++;
    console.log('  FAIL  ' + label + (detail ? '  -> ' + detail : ''));
  }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* A stand-in for the Uscreen /delphi page: the iframe plus the bridge that
   answers the widget's request for the signed-in member. */
const PARENT_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Fake Uscreen /delphi</title>
<style>body{margin:0;font-family:system-ui}header{background:#16323f;color:#fff;padding:14px 20px}
.embed{width:100%;height:78vh;border:0;display:block}</style></head>
<body>
<header>STRATEGY TRAINING &mdash; fake storefront</header>
<iframe id="frame" class="embed" src="${WIDGET}/embed"
        allow="microphone ${WIDGET}" referrerpolicy="strict-origin-when-cross-origin"></iframe>
<script>
  var WIDGET_ORIGIN = ${JSON.stringify(WIDGET)};
  window.__events = [];
  window.addEventListener('message', function (event) {
    if (event.origin !== WIDGET_ORIGIN) return;
    window.__events.push(event.data);
    if (event.data && event.data.type === 'kris-ai:ready') {
      event.source.postMessage(
        /* signedIn is what the gate actually turns on - a Uscreen landing page
           is public, so the frame alone is not enough. */
        {
          type: 'st-kris:identity',
          signedIn: true,
          email: 'member@strategytraining.com',
          uscreenId: '4242',
        },
        WIDGET_ORIGIN
      );
    }
  });
<\/script>
</body></html>`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  const parent = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PARENT_HTML);
  });
  await new Promise((r) => parent.listen(PARENT_PORT, r));
  console.log('fake storefront on ' + PARENT + '  ->  widget ' + WIDGET);

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 900 });

  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(PARENT, { waitUntil: 'networkidle2', timeout: 30000 });

  /* Wait for the iframe document, then for its boot to settle. */
  const handle = await page.waitForSelector('#frame', { timeout: 10000 });
  const frame = await handle.contentFrame();
  check('the widget iframe loaded', !!frame);

  await frame
    .waitForFunction(() => !document.getElementById('app').classList.contains('is-booting'), {
      timeout: 20000,
    })
    .catch(() => {});

  const state = await frame.evaluate(() => {
    const app = document.getElementById('app');
    return {
      mode: app.dataset.mode,
      gated: app.classList.contains('is-gated'),
      booting: app.classList.contains('is-booting'),
      noOwnNav: !document.querySelector('.stnav'),
      noOwnFooter: !document.querySelector('.stfoot'),
      composerUsable: !document.getElementById('input').disabled,
    };
  });
  console.log('        ' + JSON.stringify(state));

  check('the widget rendered in embed mode', state.mode === 'embed', state.mode);
  check('boot completed', !state.booting);
  check('the member was NOT gated', !state.gated);
  check(
    'the widget ships no chrome of its own (Uscreen supplies it)',
    state.noOwnNav && state.noOwnFooter
  );
  check('the composer is usable', state.composerUsable);

  /* The bridge handshake should have happened in both directions. */
  const events = await page.evaluate(() => window.__events || []);
  const types = events.map((e) => e && e.type);
  console.log('        parent received: ' + JSON.stringify(types));
  check('widget announced itself to the parent', types.indexOf('kris-ai:ready') !== -1);
  check(
    'widget handed back a full-page link',
    types.indexOf('kris-ai:session') !== -1,
    JSON.stringify(types)
  );

  const fullPage = events.find((e) => e && e.type === 'kris-ai:session');
  if (fullPage) {
    check(
      'the full-page link carries a handoff token',
      /\/\?t=[\w%.-]+$/.test(fullPage.fullPageUrl || ''),
      fullPage.fullPageUrl
    );
  }

  await page.screenshot({ path: path.join(OUT, 'embed-in-storefront.png') });

  /* A logged-out visitor on the same public page must be refused. */
  const loggedOut = await page.evaluate(async (widget) => {
    const res = await fetch(widget + '/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signedIn: false }),
    });
    return res.status;
  }, WIDGET);
  check('a logged-out visitor is refused', loggedOut === 401, 'status=' + loggedOut);

  /* A real question, through the iframe, cross-origin, bearer-authenticated. */
  console.log('\n  asking a question through the embed (live BuddyPro)…');
  await frame.type('#input', 'In one sentence: what is strategy?');
  await frame.click('#sendBtn');
  await frame.waitForSelector('.turn--kris', { timeout: 15000 }).catch(() => {});
  await frame
    .waitForFunction(() => !document.querySelector('.dots:not([hidden])'), { timeout: 90000 })
    .catch(() => {});
  await wait(500);

  const answer = await frame.evaluate(() => {
    const kris = document.querySelectorAll('.turn--kris');
    const last = kris[kris.length - 1];
    return {
      text: last ? last.textContent.trim().slice(0, 100) : '',
      length: last ? last.textContent.trim().length : 0,
      isError: last ? last.classList.contains('turn--error') : true,
    };
  });
  console.log('        reply: ' + JSON.stringify(answer));
  check('Kris answered through the cross-origin embed', answer.length > 0 && !answer.isError);

  await page.screenshot({ path: path.join(OUT, 'embed-chat.png') });

  console.log('\njs errors: ' + (errors.length ? errors.join(' | ') : 'none'));
  check('no page errors', errors.length === 0, errors.join(' | '));

  await browser.close();
  parent.close();

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
