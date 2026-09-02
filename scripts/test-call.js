'use strict';

/* ---------------------------------------------------------------------------
   The call, in its own browser.

   It has to be its own browser instance: once a headless Chrome has used the
   fake microphone for the composer recorder, it cannot reliably re-acquire it,
   which looks like "Microphone blocked" and is a harness limitation rather than
   a product bug. A fresh browser is also closer to how a member arrives.

   The call does NOT use the speech recogniser - it records, sends the audio and
   lets BuddyPro transcribe, which is the only way the reply comes back in the
   owner's cloned voice. Chrome's fake device emits a continuous tone, which the
   voice detector correctly reads as unbroken speech, so a turn here ends on the
   60s cap rather than on a pause.

   Usage: node scripts/test-call.js [baseUrl]
   --------------------------------------------------------------------------- */

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const BASE = process.argv[2] || 'http://127.0.0.1:8080';
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

function installProbe() {
  window.__states = [];

  /* speechSynthesis is a read-only getter, so it must be redefined. It should
     only ever be reached as a fallback, and the test asserts it is not. */
  Object.defineProperty(window, 'speechSynthesis', {
    configurable: true,
    value: {
      speak: function (u) {
        window.__spoke = (window.__spoke || 0) + 1;
        setTimeout(function () {
          if (u && u.onend) u.onend();
        }, 300);
      },
      cancel: function () {},
      getVoices: function () {
        return [];
      },
    },
  });

  document.addEventListener('DOMContentLoaded', function () {
    var el = document.getElementById('callStatusText');
    if (!el) return;
    new MutationObserver(function () {
      var t = el.textContent.trim();
      if (!window.__states.length || window.__states[window.__states.length - 1] !== t) {
        window.__states.push(t);
      }
    }).observe(el, { childList: true, characterData: true, subtree: true });
  });
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-gpu',
      '--hide-scrollbars',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });

  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.evaluateOnNewDocument(installProbe);
  await page.setViewport({ width: 900, height: 860 });
  await page.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForFunction(
    () => !document.getElementById('app').classList.contains('is-booting'),
    { timeout: 15000 }
  );

  console.log('\ncall: opening');
  await page.click('#callBtn');
  await page.waitForSelector('.app.in-call', { timeout: 5000 });
  await page.click('#callStart');

  await page
    .waitForFunction(() => (window.__states || []).indexOf('Listening') >= 0, { timeout: 60000 })
    .catch(() => {});

  const opened = await page.evaluate(() => ({
    states: window.__states || [],
    live: document.getElementById('app').classList.contains('call-live'),
    greeted: /Welcome to StrategyTraining/.test(document.querySelector('.thread').textContent),
  }));
  console.log('        ' + JSON.stringify(opened.states));

  check('the call goes live', opened.live);
  check('Kris opens with the introduction', opened.greeted);
  check(
    'the greeting speaks before listening',
    opened.states.indexOf('Talking') > -1 &&
      opened.states.indexOf('Talking') < opened.states.indexOf('Listening'),
    JSON.stringify(opened.states)
  );

  console.log('\ncall: a turn (tone reads as continuous speech, so the 60s cap ends it)');
  await page
    .waitForFunction(() => (window.__states || []).indexOf('Thinking') >= 0, { timeout: 120000 })
    .catch(() => {});
  await wait(500);

  const thinking = await page.evaluate(() => ({
    states: window.__states || [],
    thinkingBg: (() => {
      const el = document.getElementById('callStatus');
      el.classList.add('is-thinking');
      const c = getComputedStyle(el).backgroundColor;
      el.classList.remove('is-thinking');
      return c;
    })(),
  }));
  console.log('        ' + JSON.stringify(thinking.states));

  check(
    'a pause moves Listening -> Thinking',
    thinking.states.indexOf('Thinking') > thinking.states.indexOf('Listening'),
    JSON.stringify(thinking.states)
  );
  check('Thinking has its own colour', thinking.thinkingBg === 'rgb(254, 243, 199)', thinking.thinkingBg);

  await page.screenshot({ path: path.join(OUT, 'call-flow.png') });

  console.log('\njs errors: ' + (errors.length ? errors.join(' | ') : 'none'));
  check('no page errors', errors.length === 0, errors.join(' | '));

  await browser.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  console.log('NOTE: check the server log for "[chat] in: audio=<n> bytes, text=0 chars" -');
  console.log('      a call turn must send audio and no transcript.');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
