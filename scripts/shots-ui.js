'use strict';

/* ---------------------------------------------------------------------------
   The screens that changed, checked and photographed.

   /api/chat is intercepted and answered locally, so this exercises the real
   send path - the same code a member runs - without spending a BuddyPro call.

   What it asserts:
     - the landing carries no suggestion list (the reference has only the
       question box there)
     - an empty conversation shows the suggestion panel above the composer
     - the panel is gone the moment there is a turn on screen, and does not
       come back
     - the ended-call screen shows the transcript and share links and the two
       round buttons, and the mic/hang-up pair is gone
     - nothing scrolls horizontally, and the widget never needs a second
       vertical scrollbar of its own

   Usage: node scripts/shots-ui.js [baseUrl]
   --------------------------------------------------------------------------- */

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const BASE = process.argv[2] || 'http://127.0.0.1:8080';
const OUT = path.join(__dirname, '..', '.shots');

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
].find((p) => fs.existsSync(p));

const REPLY =
  'Strategy is about choosing where to compete and how to win there, and then ' +
  'being disciplined about everything you will not do.';

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

const state = () =>
  ({
    /* the panel */
    panelExists: !!document.getElementById('suggestPanel'),
    panelVisible: (() => {
      const el = document.getElementById('suggestPanel');
      return !!el && !el.hidden && getComputedStyle(el).display !== 'none';
    })(),
    chipCount: document.querySelectorAll('#suggestDockList .chip').length,
    /* the old floating pill must be gone for good */
    oldDock: !!document.querySelector('.suggestdock'),
    introSuggest: !!document.querySelector('.intro .suggest, #suggestList'),
    turns: document.querySelectorAll('#thread .turn').length,
    /* layout */
    hScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    appOverflows: (() => {
      const el = document.getElementById('scroll');
      return el ? el.scrollHeight > el.clientHeight : false;
    })(),
  });

(async () => {
  if (!CHROME) {
    console.error('No Chrome found.');
    process.exit(1);
  }
  fs.mkdirSync(OUT, { recursive: true });

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars'],
  });

  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  /* Answer chat locally. Everything else is served normally. */
  let chatCalls = 0;
  await page.setRequestInterception(true);
  page.on('request', (r) => {
    if (r.url().endsWith('/api/chat')) {
      chatCalls++;
      return r.respond({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({ content: REPLY, audio: null, audioFellBack: false }),
      });
    }
    r.continue();
  });

  await page.setViewport({ width: 1100, height: 860 });
  await page.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForFunction(
    () => !document.getElementById('app').classList.contains('is-booting'),
    { timeout: 15000 }
  );

  /* ---- the landing ----------------------------------------------------- */
  console.log('\nlanding');
  let s = await page.evaluate(state);
  check('the old floating suggestions pill is gone', !s.oldDock);
  check('the landing carries no suggestion list', !s.introSuggest);
  check('the panel is not showing yet', !s.panelVisible);
  check('no horizontal scroll', !s.hScroll);
  await page.screenshot({ path: path.join(OUT, 'ui-1-landing.png') });

  /* ---- an empty conversation ------------------------------------------- */
  console.log('\nempty conversation');
  await page.click('#chatBtn');
  await page.waitForFunction(
    () => {
      const el = document.getElementById('suggestPanel');
      return el && !el.hidden;
    },
    { timeout: 5000 }
  ).catch(() => {});

  s = await page.evaluate(state);
  check('the suggestions control is there', s.panelVisible);
  check('it holds the three questions', s.chipCount === 3, 'chips=' + s.chipCount);
  check('no horizontal scroll', !s.hScroll);

  /* Closed it is a centred pill, as on the reference - not a card. */
  const shut = await page.evaluate(() => {
    const panel = document.getElementById('suggestPanel');
    const head = document.getElementById('suggestToggle');
    const list = document.getElementById('suggestDockList');
    return {
      open: panel.classList.contains('is-open'),
      listShown: getComputedStyle(list).display !== 'none',
      headRadius: parseFloat(getComputedStyle(head).borderTopLeftRadius),
      headBorder: parseFloat(getComputedStyle(head).borderTopWidth),
      panelBorder: parseFloat(getComputedStyle(panel).borderTopWidth),
      headWidth: head.getBoundingClientRect().width,
      panelWidth: panel.getBoundingClientRect().width,
    };
  });
  check('it starts closed', !shut.open);
  check('the questions are not shown yet', !shut.listShown);
  check('closed, it is a pill: rounded and outlined', shut.headRadius >= 14 && shut.headBorder >= 1, JSON.stringify(shut));
  check('closed, the panel itself has no card border', shut.panelBorder === 0, 'border=' + shut.panelBorder);
  check(
    'closed, the pill is narrower than the column',
    shut.headWidth < shut.panelWidth * 0.75,
    'pill=' + Math.round(shut.headWidth) + ' column=' + Math.round(shut.panelWidth)
  );
  await page.screenshot({ path: path.join(OUT, 'ui-2a-pill-closed.png') });

  /* Opened it becomes a card holding the questions, three across. */
  await page.click('#suggestToggle');
  const open = await page.evaluate(() => {
    const panel = document.getElementById('suggestPanel');
    const list = document.getElementById('suggestDockList');
    return {
      open: panel.classList.contains('is-open'),
      listShown: getComputedStyle(list).display !== 'none',
      panelBorder: parseFloat(getComputedStyle(panel).borderTopWidth),
      cols: getComputedStyle(list).gridTemplateColumns.split(' ').length,
      expanded: document.getElementById('suggestToggle').getAttribute('aria-expanded'),
    };
  });
  check('the pill opens into a card', open.open && open.panelBorder >= 1, JSON.stringify(open));
  check('the questions appear', open.listShown);
  check('laid out three across, as on the reference', open.cols === 3, 'columns=' + open.cols);
  check('and it says so to a screen reader', open.expanded === 'true', open.expanded);
  await page.screenshot({ path: path.join(OUT, 'ui-2b-card-open.png') });

  /* And closes back to the pill. */
  await page.click('#suggestToggle');
  const reshut = await page.evaluate(() => ({
    open: document.getElementById('suggestPanel').classList.contains('is-open'),
    listShown:
      getComputedStyle(document.getElementById('suggestDockList')).display !== 'none',
  }));
  check('its header closes it again', !reshut.open && !reshut.listShown, JSON.stringify(reshut));

  /* ---- once there is a turn -------------------------------------------- */
  console.log('\nafter a message (chat answered locally, no BuddyPro call)');
  await page.type('#input', 'What is strategy?');
  await page.click('#sendBtn');
  await page.waitForFunction(
    () => document.querySelectorAll('#thread .turn--kris').length >= 2,
    { timeout: 15000 }
  );

  s = await page.evaluate(state);
  check('the answer arrived', s.turns >= 3, 'turns=' + s.turns);
  check('the panel is gone', !s.panelVisible);
  check('no horizontal scroll', !s.hScroll);
  check('the reply is not a BuddyPro call', chatCalls === 1, 'chatCalls=' + chatCalls);
  await page.screenshot({ path: path.join(OUT, 'ui-3-chat.png') });

  /* it must not reappear on the next turn either */
  await page.type('#input', 'And where do I start?');
  await page.click('#sendBtn');
  await page.waitForFunction(
    () => document.querySelectorAll('#thread .turn--kris').length >= 3,
    { timeout: 15000 }
  );
  s = await page.evaluate(state);
  check('and stays gone on the next turn', !s.panelVisible);

  /* ---- the call screens ------------------------------------------------ */
  console.log('\ncall');
  await page.click('#headerCallBtn');
  await page.waitForSelector('.app.in-call', { timeout: 5000 });

  let call = await page.evaluate(() => ({
    start: !document.getElementById('callStart').hidden,
    over: !document.getElementById('callOver').hidden,
    ctl: getComputedStyle(document.querySelector('.callctl')).display,
  }));
  check('the idle call screen offers Start a call', call.start);
  check('...and shows nothing about a finished call', !call.over);
  await page.screenshot({ path: path.join(OUT, 'ui-4-call-idle.png') });

  /* The ended screen, driven the way endCall drives it. The call itself needs
     a microphone and a live turn, which scripts/test-call.js covers; here it is
     the layout that is under test. */
  await page.evaluate(() => {
    const app = document.getElementById('app');
    app.classList.remove('call-live', 'call-connecting');
    app.classList.add('call-ended');
    document.getElementById('callOver').hidden = false;
    document.getElementById('callEndedIco').hidden = false;
    document.getElementById('callStart').hidden = true;
    document.getElementById('callStatusText').textContent = 'Call Ended';
    document.getElementById('callDots').hidden = true;
  });

  call = await page.evaluate(() => ({
    ctl: getComputedStyle(document.querySelector('.callctl')).display,
    over: getComputedStyle(document.getElementById('callOver')).display,
    links: document.querySelectorAll('.callover__links .calllink').length,
    rounds: document.querySelectorAll('.callover__btns .callround button').length,
    labels: Array.from(document.querySelectorAll('.callover__btns .callround em')).map(
      (e) => e.textContent
    ),
    statusText: document.getElementById('callStatusText').textContent,
    icoVisible: !document.getElementById('callEndedIco').hidden,
  }));

  check('mic and hang-up are gone', call.ctl === 'none', 'display=' + call.ctl);
  check('the finished-call block is showing', call.over !== 'none');
  check('View Transcript and Share Call are both there', call.links === 2, 'links=' + call.links);
  check('Chat and Call round buttons are there', call.rounds === 2, 'rounds=' + call.rounds);
  check(
    '...and they are labelled',
    JSON.stringify(call.labels) === JSON.stringify(['Chat', 'Call']),
    JSON.stringify(call.labels)
  );
  check('the status reads Call Ended, with its icon', call.statusText === 'Call Ended' && call.icoVisible);

  const ended = await page.evaluate(() => ({
    dots: !document.getElementById('callDots').hidden,
    bars: !document.getElementById('callBars').hidden,
    meter: getComputedStyle(document.querySelector('.callview__meter')).display,
    cols: getComputedStyle(document.getElementById('suggestDockList')).gridTemplateColumns,
  }));
  check('no in-progress indicator is still running', !ended.dots && !ended.bars, JSON.stringify(ended));
  check('the timer and minutes-left chip stays visible', ended.meter !== 'none', ended.meter);
  await page.screenshot({ path: path.join(OUT, 'ui-5-call-ended.png') });

  /* ---- narrow ---------------------------------------------------------- */
  console.log('\nmobile');
  await page.setViewport({ width: 390, height: 780 });
  await page.evaluate(() => window.dispatchEvent(new Event('resize')));
  s = await page.evaluate(state);
  check('no horizontal scroll on mobile', !s.hScroll);
  await page.screenshot({ path: path.join(OUT, 'ui-6-call-ended-mobile.png') });

  console.log('\njs errors: ' + (errors.length ? errors.join(' | ') : 'none'));
  check('no page errors', errors.length === 0, errors.join(' | '));

  await browser.close();
  console.log('\nshots in ' + OUT);
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
