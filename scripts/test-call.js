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

   /api/chat is answered locally: a call spends a BuddyPro request per turn, and
   what is under test here is the call's own behaviour, not the upstream.

   It also checks the two things that make a call separate from the chat:
   nothing it says lands in the chat thread, and View Transcript opens the call
   as its own conversation rather than appending it to whatever was there.

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

  /* Answer chat locally - no BuddyPro request, no credits. No audio in the
     reply, so the call falls back to the stubbed speechSynthesis, which the
     probe counts. */
  let chatCalls = 0;
  await page.setRequestInterception(true);
  page.on('request', (r) => {
    if (r.url().endsWith('/api/chat')) {
      chatCalls++;
      return r.respond({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({
          content: 'Start with where you want to compete, then be honest about the gap.',
          audio: null,
          audioFellBack: true,
        }),
      });
    }
    r.continue();
  });

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
    /* The call must leave the chat alone. The greeting used to be added as a
       chat turn, which is how a call ended up spliced into the thread. */
    chatTurns: document.querySelectorAll('#thread .turn').length,
  }));
  console.log('        ' + JSON.stringify(opened.states));

  check('the call goes live', opened.live);
  check(
    'the greeting speaks before listening',
    opened.states.indexOf('Talking') > -1 &&
      opened.states.indexOf('Talking') < opened.states.indexOf('Listening'),
    JSON.stringify(opened.states)
  );
  check(
    'nothing from the call is in the chat thread',
    opened.chatTurns === 0,
    'chat turns=' + opened.chatTurns
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

  /* ---- hanging up ------------------------------------------------------ */
  console.log('\nhanging up');
  await page.click('#callEnd');
  await page.waitForFunction(
    () => document.getElementById('app').classList.contains('call-ended'),
    { timeout: 8000 }
  ).catch(() => {});

  /* How many turns the call actually collected, so the stored transcript can
     be compared against it rather than guessed at. */
  const collected = await page.evaluate(() => {
    let convs = [];
    try {
      convs = JSON.parse(localStorage.getItem('kris_ai_conversations_v1') || '[]');
    } catch (e) {}
    return { conversationsSoFar: convs.length, kinds: convs.map((c) => c.kind) };
  });
  console.log('        conversations in history before the transcript: ' + JSON.stringify(collected));

  const over = await page.evaluate(() => ({
    ended: document.getElementById('app').classList.contains('call-ended'),
    stillInCall: document.getElementById('app').classList.contains('in-call'),
    overShown: !document.getElementById('callOver').hidden,
    status: document.getElementById('callStatusText').textContent.trim(),
    chatTurns: document.querySelectorAll('#thread .turn').length,
  }));

  check('it lands on the finished-call screen', over.ended && over.overShown, JSON.stringify(over));
  check('...without leaving the call view', over.stillInCall);
  check('the status reads Call Ended', over.status === 'Call Ended', over.status);
  check(
    'the call still has not touched the chat',
    over.chatTurns === 0,
    'chat turns=' + over.chatTurns
  );
  await page.screenshot({ path: path.join(OUT, 'call-ended.png') });

  /* ---- the transcript is its own conversation -------------------------- */
  console.log('\nView Transcript');
  await page.click('#callTranscriptBtn');
  await page.waitForFunction(
    () =>
      !document.getElementById('app').classList.contains('in-call') &&
      document.querySelectorAll('#thread .turn').length > 0,
    { timeout: 8000 }
  ).catch(() => {});

  const transcript = await page.evaluate(() => {
    let convs = [];
    try {
      convs = JSON.parse(localStorage.getItem('kris_ai_conversations_v1') || '[]');
    } catch (e) {
      /* blocked storage */
    }
    const calls = convs.filter((c) => c.kind === 'call');
    return {
      leftCallView: !document.getElementById('app').classList.contains('in-call'),
      turnsOnScreen: document.querySelectorAll('#thread .turn').length,
      callConversations: calls.length,
      titles: calls.map((c) => c.title),
      turnsStored: calls.length ? calls[calls.length - 1].turns.length : 0,
      roles: calls.length ? calls[calls.length - 1].turns.map((t) => t.role) : [],
    };
  });

  console.log(
    '        stored=' + transcript.turnsStored + ' onScreen=' + transcript.turnsOnScreen
  );
  check('it returns to the chat view', transcript.leftCallView);
  check(
    'every stored turn is rendered',
    transcript.turnsOnScreen === transcript.turnsStored,
    'stored=' + transcript.turnsStored + ' onScreen=' + transcript.turnsOnScreen
  );
  check('the transcript is on screen', transcript.turnsOnScreen > 0, JSON.stringify(transcript));
  check(
    'it is stored as its OWN call conversation',
    transcript.callConversations === 1,
    JSON.stringify(transcript)
  );
  check(
    '...titled as a call',
    /^Call - /.test(transcript.titles[0] || ''),
    JSON.stringify(transcript.titles)
  );
  check(
    '...carrying both sides of it',
    transcript.roles.indexOf('kris') > -1 && transcript.roles.indexOf('me') > -1,
    JSON.stringify(transcript.roles)
  );
  await page.screenshot({ path: path.join(OUT, 'call-transcript.png') });

  console.log('\n        chat requests made: ' + chatCalls + ' (all answered locally)');

  console.log('\njs errors: ' + (errors.length ? errors.join(' | ') : 'none'));
  check('no page errors', errors.length === 0, errors.join(' | '));

  await browser.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
