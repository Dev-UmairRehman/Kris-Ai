'use strict';

/* ---------------------------------------------------------------------------
   Drives the speech endpointing with a stubbed SpeechRecognition, so the
   "listens forever" bug can be reproduced and proven fixed without a
   microphone or Google's speech service.

   The stub reproduces exactly what Chrome does in the failing case:
   it emits INTERIM results only, never marks anything final, and never fires
   `onend` on its own. The old code waited for a final result and for `onend`,
   so it hung on "Listening" - which is what was reported.

   Usage: node scripts/test-speech.js
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

/* Installed before app.js runs. */
function installStub() {
  window.__speech = { started: 0, aborted: 0, stopped: 0, instances: [] };

  function FakeRecognition() {
    this.lang = '';
    this.interimResults = false;
    this.continuous = false;
    this.onresult = null;
    this.onerror = null;
    this.onend = null;
    window.__speech.instances.push(this);
  }

  FakeRecognition.prototype.start = function () {
    window.__speech.started++;
    var self = this;
    /* Interim-only, in two chunks, then silence for ever. No isFinal, no
       onend - the exact Chrome behaviour that used to hang. */
    setTimeout(function () {
      if (self.onresult) {
        self.onresult({
          resultIndex: 0,
          results: [Object.assign([{ transcript: 'what should I' }], { 0: { transcript: 'what should I' }, isFinal: false, length: 1 })],
        });
      }
    }, 60);
    setTimeout(function () {
      if (self.onresult) {
        self.onresult({
          resultIndex: 0,
          results: [Object.assign([{ transcript: 'what should I focus on' }], { 0: { transcript: 'what should I focus on' }, isFinal: false, length: 1 })],
        });
      }
    }, 220);
  };

  FakeRecognition.prototype.stop = function () {
    window.__speech.stopped++;
  };
  FakeRecognition.prototype.abort = function () {
    window.__speech.aborted++;
  };

  window.SpeechRecognition = FakeRecognition;
  window.webkitSpeechRecognition = FakeRecognition;

  /* Keep the call off the network and out of the speakers. */
  window.speechSynthesis = {
    speak: function (u) {
      window.__spoke = (window.__spoke || 0) + 1;
      setTimeout(function () {
        if (u && u.onend) u.onend();
      }, 30);
    },
    cancel: function () {},
    getVoices: function () {
      return [];
    },
  };
  window.SpeechSynthesisUtterance = function (text) {
    this.text = text;
  };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars'],
  });

  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.setViewport({ width: 900, height: 860 });
  await page.evaluateOnNewDocument(installStub);
  await page.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 30000 });
  await page
    .waitForFunction(() => !document.getElementById('app').classList.contains('is-booting'), {
      timeout: 15000,
    })
    .catch(() => {});

  /* ---- composer microphone -------------------------------------------- */
  console.log('\ncomposer microphone (interim-only, no onend - the failing case)');

  const micVisible = await page.evaluate(
    () => getComputedStyle(document.getElementById('micBtn')).display !== 'none'
  );
  check('the microphone is offered when speech is supported', micVisible);

  await page.click('#micBtn');
  await wait(400);

  const mid = await page.evaluate(() => ({
    armed: document.getElementById('micBtn').classList.contains('is-armed'),
    input: document.getElementById('input').value,
    started: window.__speech.started,
  }));
  check('recognition actually started', mid.started === 1, 'started=' + mid.started);
  check('the button shows it is listening', mid.armed);
  check(
    'interim speech reaches the composer',
    /what should I/i.test(mid.input),
    JSON.stringify(mid.input)
  );

  /* The silence timer is 1500ms. Before the fix nothing happened here, ever. */
  await page.waitForFunction(() => document.querySelectorAll('.turn--me').length > 0, {
    timeout: 6000,
  }).catch(() => {});

  const after = await page.evaluate(() => ({
    armed: document.getElementById('micBtn').classList.contains('is-armed'),
    sentTurns: document.querySelectorAll('.turn--me').length,
    sentText: (document.querySelector('.turn--me .bubble') || {}).textContent || '',
    stopped: window.__speech.stopped,
  }));
  console.log('        ' + JSON.stringify(after));
  check('the turn ends on silence instead of hanging', after.sentTurns === 1, JSON.stringify(after));
  check(
    'the interim text is what got sent',
    /what should I focus on/i.test(after.sentText),
    after.sentText
  );
  check('the recogniser was stopped', after.stopped >= 1, 'stopped=' + after.stopped);
  check('the microphone is no longer armed', !after.armed);

  await page.screenshot({ path: path.join(OUT, 'speech-dictation.png') });

  /* ---- call loop ------------------------------------------------------- */
  console.log('\ncall loop');

  /* Let the composer's answer land first. A request in flight legitimately
     defers listening, and starting the call on top of it would be testing the
     BuddyPro round-trip time, not the endpointing. */
  await page
    .waitForFunction(() => !document.querySelector('.dots'), { timeout: 90000 })
    .catch(() => {});

  await page.evaluate(() => {
    window.__speech.started = 0;
    /* getUserMedia is not available in headless without a device; stub it so
       beginCall() can proceed. */
    navigator.mediaDevices = navigator.mediaDevices || {};
    navigator.mediaDevices.getUserMedia = function () {
      return Promise.resolve({ getTracks: () => [] });
    };
  });

  await page.click('#headerCallBtn');
  await page.waitForSelector('.app.in-call', { timeout: 5000 });
  await page.click('#callStart');
  await page.waitForSelector('.app.call-live', { timeout: 8000 }).catch(() => {});

  await page
    .waitForFunction(() => document.querySelectorAll('.turn--me').length >= 2, { timeout: 45000 })
    .catch(() => {});

  const call = await page.evaluate(() => ({
    live: document.getElementById('app').classList.contains('call-live'),
    status: document.getElementById('callStatusText').textContent,
    turns: document.querySelectorAll('.turn--me').length,
    started: window.__speech.started,
  }));
  console.log('        ' + JSON.stringify(call));
  check('the call went live', call.live);
  check('the spoken turn was submitted, not left hanging', call.turns >= 2, JSON.stringify(call));
  check(
    'the call did not spin restarting the recogniser',
    call.started <= 3,
    'starts=' + call.started
  );
  await page.screenshot({ path: path.join(OUT, 'speech-call.png') });

  console.log('\njs errors: ' + (errors.length ? errors.join(' | ') : 'none'));
  check('no page errors', errors.length === 0, errors.join(' | '));

  await browser.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
