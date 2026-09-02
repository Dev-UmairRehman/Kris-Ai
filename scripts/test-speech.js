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

  /* speechSynthesis is a read-only getter, so it must be redefined. */
  Object.defineProperty(window, 'speechSynthesis', {
    configurable: true,
    value: {
      speak: function (u) {
        setTimeout(function () {
          if (u && u.onend) u.onend();
        }, 400);
      },
      cancel: function () {},
      getVoices: function () {
        return [];
      },
    },
  });

  /* Follow the call status pill so the state machine can be asserted. */
  window.__states = [];
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

  let page = await browser.newPage();
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
  console.log('\ncomposer recorder (tap to record, then send)');

  const micVisible = await page.evaluate(
    () => getComputedStyle(document.getElementById('micBtn')).display !== 'none'
  );
  check('the microphone is offered when speech is supported', micVisible);

  await page.click('#micBtn');
  await wait(500);

  const mid = await page.evaluate(() => ({
    recordingUi: document.getElementById('form').classList.contains('is-recording'),
    inputHidden: getComputedStyle(document.getElementById('input')).display === 'none',
    sendShown: getComputedStyle(document.getElementById('recSend')).display !== 'none',
    cancelShown: getComputedStyle(document.getElementById('recCancel')).display !== 'none',
    timer: document.getElementById('recTime').textContent,
    bars: document.querySelectorAll('#recWave i').length,
    started: window.__speech.started,
    noticeShown: document.getElementById('notice').classList.contains('is-shown'),
    turns: document.querySelectorAll('.turn--me').length,
  }));
  console.log('        ' + JSON.stringify(mid));
  check('recognition actually started', mid.started === 1, 'started=' + mid.started);
  check('the composer becomes the recorder', mid.recordingUi && mid.inputHidden);
  check('send and cancel are offered', mid.sendShown && mid.cancelShown);
  check('a level trace is drawn', mid.bars > 0, 'bars=' + mid.bars);
  check('no instruction text is shown', !mid.noticeShown);

  /* A pause must NOT send it - the member decides, like a messenger. */
  await wait(2200);
  const paused = await page.evaluate(() => ({
    stillRecording: document.getElementById('form').classList.contains('is-recording'),
    turns: document.querySelectorAll('.turn--me').length,
    timer: document.getElementById('recTime').textContent,
  }));
  console.log('        after a 2.2s pause: ' + JSON.stringify(paused));
  check('a pause does not send it', paused.stillRecording && paused.turns === 0, JSON.stringify(paused));
  check('the timer is running', paused.timer !== '0:00', paused.timer);

  /* Cancel throws it away. */
  await page.click('#recCancel');
  await wait(400);
  const cancelled = await page.evaluate(() => ({
    recording: document.getElementById('form').classList.contains('is-recording'),
    turns: document.querySelectorAll('.turn--me').length,
    inputBack: getComputedStyle(document.getElementById('input')).display !== 'none',
  }));
  check('cancel discards the recording', !cancelled.recording && cancelled.turns === 0, JSON.stringify(cancelled));
  check('the text input comes back', cancelled.inputBack);

  /* Record again and send it. */
  await page.click('#micBtn');
  await wait(500);
  await page.click('#recSend');

  await page.waitForFunction(() => document.querySelectorAll('.turn--me').length > 0, {
    timeout: 8000,
  }).catch(() => {});

  const after = await page.evaluate(() => ({
    armed: document.getElementById('form').classList.contains('is-recording'),
    sentTurns: document.querySelectorAll('.turn--me').length,
    voiceBubbles: document.querySelectorAll('.turn--me .voicebubble').length,
    caption: (document.querySelector('.turn--me .voicebubble__text') || {}).textContent || '',
    meta: (document.querySelector('.turn--me .voicebubble__meta') || {}).textContent || '',
    stopped: window.__speech.stopped,
  }));
  console.log('        ' + JSON.stringify(after));
  check('send posts the voice message', after.sentTurns === 1, JSON.stringify(after));
  check('it renders as a voice note, not plain text', after.voiceBubbles === 1);
  check('no transcript is shown on a voice note', after.caption === '', after.caption);
  check('the recorder closed', !after.armed);

  await page.screenshot({ path: path.join(OUT, 'speech-dictation.png') });

  /* The call has its own script - scripts/test-call.js - because a browser
     that has already used the fake microphone here cannot re-acquire it. */

  console.log('\njs errors: ' + (errors.length ? errors.join(' | ') : 'none'));
  check('no page errors', errors.length === 0, errors.join(' | '));

  await browser.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
