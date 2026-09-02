'use strict';

/* ---------------------------------------------------------------------------
   The Head Code snippet, exercised in a real browser.

   uscreen/head-code.html is five blocks that go into one box in the Uscreen
   admin, and a mistake there is invisible until a member hits it. This serves a
   stand-in storefront with that exact file in its <head> and checks each block:

     2  the page and link markers, on both Kris pages and on an unrelated page
     3  the sub-nav hider and the nav highlight
     4  routing a logged-out click to /join
     5  the identity bridge answering the widget

   It spends nothing: the widget is a stub that records the reply, so BuddyPro
   is never called.

   Usage: node scripts/test-headcode.js
   --------------------------------------------------------------------------- */

const fs = require('fs');
const path = require('path');
const http = require('http');
const puppeteer = require('puppeteer-core');

const PORT = 8123;
const ORIGIN = 'http://127.0.0.1:' + PORT;

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
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

const HEAD = fs.readFileSync(
  path.join(__dirname, '..', 'uscreen', 'head-code.html'),
  'utf8'
);

/* The real widget origin the snippet is pinned to. The stub has to be served
   from it for the bridge to answer, so requests to it are intercepted. */
const WIDGET_ORIGIN = (HEAD.match(/widgetOrigin: '([^']+)'/) || [])[1];
const MEMORY_PATH = (HEAD.match(/memory: '([^']+)'/) || [])[1];
const DELPHI_PATH = (HEAD.match(/delphi: '([^']+)'/) || [])[1];

/* A stand-in for the storefront. `signedIn` controls whether Uscreen's
   logged-out marker (the /sign_in link) is rendered, which is the signal both
   block 4 and block 5 read. */
function storefront(pathname, signedIn, withWidget) {
  const signInLink = signedIn ? '' : '<a href="/sign_in">Sign in</a>';
  const frame = withWidget
    ? '<iframe id="w" src="' + WIDGET_ORIGIN + '/embed"></iframe>'
    : '';
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<title>Fake StrategyTraining</title>' +
    HEAD +
    '</head><body>' +
    '<header>header</header>' +
    /* the catalog sub-nav block 3 hides */
    '<div class="w-full border-b border-ds-default bg-ds-main overflow-x-auto z-[20]">' +
    'Browse Favorites Playlists</div>' +
    '<nav>' +
    signInLink +
    /* the nav stores an absolute URL, as the real one does */
    '<a id="navDelphi" href="https://www.strategytraining.com' + DELPHI_PATH + '">Kris AI</a>' +
    '<a id="navMemory" href="https://www.strategytraining.com' + MEMORY_PATH + '">Kris AI Memory</a>' +
    '<a id="navOther" href="/courses">Courses</a>' +
    '</nav>' +
    frame +
    '</body></html>'
  );
}

/* The widget stub. Speaks the widget's half of the protocol and records what
   comes back, so no real request is ever made. */
const WIDGET_STUB =
  '<!doctype html><html><head><meta charset="utf-8"></head><body>' +
  '<script>' +
  'window.__got = null;' +
  "window.addEventListener('message', function (e) { window.__got = e.data; });" +
  "parent.postMessage({ type: 'kris-ai:ready' }, '*');" +
  '<\/script></body></html>';

function serve() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, ORIGIN);
    const p = url.pathname.replace(/\/+$/, '') || '/';

    if (p === '/embed') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(WIDGET_STUB);
    }
    if (p === '/join') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<!doctype html><title>Join</title><h1>Join</h1>');
    }

    const signedIn = url.searchParams.get('signedIn') === '1';
    const withWidget = p === MEMORY_PATH;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(storefront(p, signedIn, withWidget));
  });
}

(async () => {
  if (!CHROME) {
    console.error('No Chrome found.');
    process.exit(1);
  }
  if (!WIDGET_ORIGIN || !MEMORY_PATH || !DELPHI_PATH) {
    console.error('Could not read widgetOrigin / page slugs out of head-code.html.');
    process.exit(1);
  }

  const server = serve();
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars'],
  });

  const errors = [];

  async function open(pathname, signedIn) {
    const page = await browser.newPage();
    page.on('pageerror', (e) => errors.push(pathname + ': ' + e.message));
    /* Serve the widget origin from the local stub, so the bridge's pinned
       origin check is exercised for real rather than relaxed. */
    await page.setRequestInterception(true);
    page.on('request', (r) => {
      if (r.url().startsWith(WIDGET_ORIGIN)) {
        return r.respond({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: WIDGET_STUB,
        });
      }
      r.continue();
    });
    await page.goto(ORIGIN + pathname + (signedIn ? '?signedIn=1' : ''), {
      waitUntil: 'networkidle2',
      timeout: 20000,
    });
    return page;
  }

  const probe = () => ({
    hasApi: !!window.ST_KRIS,
    cls: document.documentElement.className,
    subnavHidden:
      getComputedStyle(
        document.querySelector('div.w-full.border-b.bg-ds-main.overflow-x-auto')
      ).display === 'none',
    memoryLink: document.getElementById('navMemory').className,
    delphiLink: document.getElementById('navDelphi').className,
    otherLink: document.getElementById('navOther').className,
    highlight: getComputedStyle(document.getElementById('navMemory')).boxShadow,
    /* absolute and relative hrefs must both resolve */
    pageOf: window.ST_KRIS
      ? [
          window.ST_KRIS.pageOf('https://www.strategytraining.com' + '/kris-ai-memory'),
          window.ST_KRIS.pageOf('/delphi/'),
          window.ST_KRIS.pageOf('/courses'),
        ]
      : null,
  });

  /* ---- block 2 and 3, on the new page --------------------------------- */
  console.log('\nblocks 2 + 3: the Kris AI Memory page (signed in)');
  let page = await open(MEMORY_PATH, true);
  let r = await page.evaluate(probe);

  check('the shared API is exposed', r.hasApi);
  check('<html> is marked st-kris', /\bst-kris\b/.test(r.cls), r.cls);
  check('<html> is marked st-kris-memory', /st-kris-memory/.test(r.cls), r.cls);
  check('it is NOT marked st-delphi', !/\bst-delphi\b/.test(r.cls), r.cls);
  check('the catalog sub-nav is hidden', r.subnavHidden);
  check('the Memory nav link is current', /is-current/.test(r.memoryLink), r.memoryLink);
  check('the Delphi nav link is not current', !/is-current/.test(r.delphiLink), r.delphiLink);
  check('an unrelated nav link is untouched', r.otherLink === '', r.otherLink);
  check('the current tab is highlighted', r.highlight !== 'none', r.highlight);
  check(
    'pageOf resolves absolute and relative hrefs',
    JSON.stringify(r.pageOf) === JSON.stringify(['memory', 'delphi', '']),
    JSON.stringify(r.pageOf)
  );

  /* ---- block 5, the bridge -------------------------------------------- */
  console.log('\nblock 5: the identity bridge');
  const frameHandle = await page.$('#w');
  const inner = await frameHandle.contentFrame();
  const answered = await inner
    .waitForFunction(() => window.__got !== null, { timeout: 8000 })
    .then(() => inner.evaluate(() => window.__got))
    .catch(() => null);

  check('the widget gets an answer', !!answered, JSON.stringify(answered));
  check(
    'it is the identity message',
    answered && answered.type === 'st-kris:identity',
    JSON.stringify(answered)
  );
  check('a signed-in member is reported', answered && answered.signedIn === true, JSON.stringify(answered));
  await page.close();

  /* ---- block 5 again, logged out -------------------------------------- */
  console.log('\nblock 5: the same page, logged out');
  page = await open(MEMORY_PATH, false);
  const outFrame = await (await page.$('#w')).contentFrame();
  const loggedOutAnswer = await outFrame
    .waitForFunction(() => window.__got !== null, { timeout: 8000 })
    .then(() => outFrame.evaluate(() => window.__got))
    .catch(() => null);

  check(
    'signedIn is false for a visitor',
    loggedOutAnswer && loggedOutAnswer.signedIn === false,
    JSON.stringify(loggedOutAnswer)
  );
  check(
    'no email leaks when logged out',
    loggedOutAnswer && !loggedOutAnswer.email && !loggedOutAnswer.uscreenId,
    JSON.stringify(loggedOutAnswer)
  );
  await page.close();

  /* ---- block 2, the Delphi page is unaffected ------------------------- */
  console.log('\nblock 2: the existing Delphi page still behaves');
  page = await open(DELPHI_PATH, true);
  r = await page.evaluate(probe);
  check('<html> is marked st-delphi', /\bst-delphi\b/.test(r.cls), r.cls);
  check('...and st-kris, so the sub-nav still hides', r.subnavHidden, r.cls);
  check('the Delphi nav link is current', /is-current/.test(r.delphiLink), r.delphiLink);
  check('the Memory nav link is not', !/is-current/.test(r.memoryLink), r.memoryLink);
  await page.close();

  /* ---- block 2, an unrelated page ------------------------------------- */
  console.log('\nblock 2: an unrelated page is left alone');
  page = await open('/courses', true);
  r = await page.evaluate(probe);
  check('no Kris class is set', !/st-kris|st-delphi/.test(r.cls), r.cls || '(none)');
  check('the sub-nav is visible', !r.subnavHidden);
  check('no nav link is current', !/is-current/.test(r.memoryLink + r.delphiLink));
  await page.close();

  /* ---- block 4, routing ----------------------------------------------- */
  console.log('\nblock 4: a logged-out click goes to /join');
  page = await open('/courses', false);
  await page.click('#navMemory');
  await page.waitForFunction(() => location.pathname === '/join', { timeout: 8000 }).catch(() => {});
  check('logged out -> /join', new URL(page.url()).pathname === '/join', page.url());
  await page.close();

  console.log('\nblock 4: a signed-in click is left alone');
  page = await open('/courses', true);
  await page.click('#navMemory');
  await page
    .waitForFunction((p) => location.pathname.replace(/\/+$/, '') === p, { timeout: 8000 }, MEMORY_PATH)
    .catch(() => {});
  check(
    'signed in -> the Kris AI Memory page',
    new URL(page.url()).pathname.replace(/\/+$/, '') === MEMORY_PATH,
    page.url()
  );
  await page.close();

  console.log('\njs errors: ' + (errors.length ? errors.join(' | ') : 'none'));
  check('no page errors', errors.length === 0, errors.join(' | '));

  await browser.close();
  await new Promise((r) => server.close(r));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
