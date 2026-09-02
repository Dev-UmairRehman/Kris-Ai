'use strict';

/* ---------------------------------------------------------------------------
   Captures and asserts the views that the plain viewport sweep cannot reach:
   the chat thread with a real answer, the collapsible suggestions, the call
   screens in each state, the history drawer, and the embed chrome rules.
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

async function ready(page) {
  await page
    .waitForFunction(() => !document.getElementById('app').classList.contains('is-booting'), {
      timeout: 15000,
    })
    .catch(() => {});
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars'],
  });

  const errors = [];

  /* ---- embed chrome ---------------------------------------------------- */
  console.log('\nembed mode');
  const embed = await browser.newPage();
  embed.on('pageerror', (e) => errors.push('embed: ' + e.message));
  await embed.setViewport({ width: 900, height: 820 });
  await embed.goto(BASE + '/embed', { waitUntil: 'networkidle2' });
  await ready(embed);
  /* Uscreen renders the StrategyTraining nav and footer around the widget, so
     the widget must not ship any of its own - in either mode. */
  const chromeState = await embed.evaluate(() => ({
    nav: !!document.querySelector('.stnav'),
    foot: !!document.querySelector('.stfoot'),
    legal: !!document.querySelector('.legal'),
    mode: document.getElementById('app').dataset.mode,
  }));
  check('no duplicated storefront nav', !chromeState.nav);
  check('no duplicated storefront footer', !chromeState.foot);
  check('no legal small print', !chromeState.legal);
  await embed.screenshot({ path: path.join(OUT, 'embed.png') });
  await embed.close();

  /* ---- landing --------------------------------------------------------- */
  console.log('\nlanding');
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.setViewport({ width: 900, height: 900 });
  await page.goto(BASE + '/', { waitUntil: 'networkidle2' });
  await ready(page);
  await page.evaluate(() => localStorage.clear());

  const landing = await page.evaluate(() => {
    const badge = document.querySelector('.name__badge');
    return {
      badge: (badge && badge.textContent.trim().replace(/\s+/g, '')) || '',
      badgeTitle: badge && badge.getAttribute('aria-label'),
      whoVisible: getComputedStyle(document.querySelector('.chatbar__who')).display !== 'none',
      callIconVisible: getComputedStyle(document.querySelector('.chatbar__call')).display !== 'none',
      dockVisible: getComputedStyle(document.getElementById('suggestDock')).display !== 'none',
      chips: document.querySelectorAll('#suggestList .chip').length,
    };
  });
  check('badge reads StrategyTraining', /StrategyTraining/i.test(landing.badge), landing.badge);
  check('badge title is StrategyTraining', landing.badgeTitle === 'StrategyTraining', landing.badgeTitle);
  check('header identity hidden on landing', !landing.whoVisible);
  check('header call icon hidden on landing', !landing.callIconVisible);
  check('docked suggestions hidden on landing', !landing.dockVisible);
  check('three suggestion cards', landing.chips === 3, String(landing.chips));
  await page.screenshot({ path: path.join(OUT, 'page-desktop.png') });

  /* ---- chat with a real answer ---------------------------------------- */
  console.log('\nchat (live BuddyPro call)');
  await page.click('#suggestList .chip');
  await page.waitForSelector('.turn--kris', { timeout: 10000 });

  const entered = await page.evaluate(() => ({
    inThread: document.getElementById('app').classList.contains('in-thread'),
    introHidden: getComputedStyle(document.getElementById('intro')).display === 'none',
    whoVisible: getComputedStyle(document.querySelector('.chatbar__who')).display !== 'none',
    callIconVisible: getComputedStyle(document.querySelector('.chatbar__call')).display !== 'none',
    dockVisible: getComputedStyle(document.getElementById('suggestDock')).display !== 'none',
    welcome: (document.querySelector('.turn--kris .bubble') || {}).textContent || '',
  }));
  check('entering chat hides the landing', entered.inThread && entered.introHidden);
  check('header shows identity in chat', entered.whoVisible);
  check('header shows the call icon in chat', entered.callIconVisible);
  check('docked suggestions appear in chat', entered.dockVisible);
  check(
    'a welcome message opens the conversation',
    /Welcome to StrategyTraining/.test(entered.welcome),
    entered.welcome.slice(0, 60)
  );

  await page.screenshot({ path: path.join(OUT, 'chat-thinking.png') });

  await page
    .waitForFunction(() => !document.querySelector('.dots:not([hidden])'), { timeout: 90000 })
    .catch(() => {});
  await wait(600);

  const answered = await page.evaluate(() => {
    const kris = document.querySelectorAll('.turn--kris');
    const last = kris[kris.length - 1];
    const me = document.querySelector('.turn--me .bubble');
    const style = (el) => getComputedStyle(el);
    return {
      turns: document.querySelectorAll('.turn').length,
      bubblesInLastAnswer: last ? last.querySelectorAll('.bubble').length : 0,
      answerLength: last ? last.textContent.trim().length : 0,
      krisBg: last ? style(last.querySelector('.bubble')).backgroundColor : '',
      meBg: me ? style(me).backgroundColor : '',
      krisAlign: last ? style(last).alignItems : '',
      meAlign: me ? style(me.parentElement).alignItems : '',
      noPerMessageAvatar: document.querySelectorAll('.turn .msg__avatar').length === 0,
      isError: last ? last.classList.contains('turn--error') : true,
    };
  });
  console.log('        ' + JSON.stringify(answered));
  check('Kris answered', answered.answerLength > 0 && !answered.isError);
  check(
    'the answer is split across several bubbles',
    answered.bubblesInLastAnswer >= 2,
    'bubbles=' + answered.bubblesInLastAnswer
  );
  check('Kris bubbles are grey', answered.krisBg === 'rgb(234, 235, 236)', answered.krisBg);
  check('user bubbles are cyan', /43, 192, 227|rgb\(43, 192, 227\)/.test(answered.meBg), answered.meBg);
  check('Kris is left aligned', answered.krisAlign === 'flex-start', answered.krisAlign);
  check('the user is right aligned', answered.meAlign === 'flex-end', answered.meAlign);
  check('no per-message avatars', answered.noPerMessageAvatar);
  await page.screenshot({ path: path.join(OUT, 'chat-answer.png') });

  /* ---- docked suggestions toggle -------------------------------------- */
  console.log('\ndocked suggestions');
  await page.click('#suggestToggle');
  await wait(200);
  const opened = await page.evaluate(
    () => getComputedStyle(document.getElementById('suggestDockList')).display !== 'none'
  );
  check('the toggle opens the list', opened);
  await page.screenshot({ path: path.join(OUT, 'chat-suggestions.png') });
  await page.click('#suggestToggle');

  /* ---- markdown rendering + history restore --------------------------- */
  console.log('');
  console.log('markdown and history');

  /* A crafted answer covering every inline form the renderer supports, with a
     blank line so the bubble split is exercised too. */
  const BREAK = String.fromCharCode(10) + String.fromCharCode(10);
  await page.evaluate((brk) => {
    localStorage.setItem(
      'kris_ai_conversations_v1',
      JSON.stringify([
        {
          id: 'seed1',
          kind: 'chat',
          title: 'Where should I start?',
          at: Date.now() - 60000,
          turns: [
            { role: 'me', text: 'Where should I start?', at: Date.now() - 60000 },
            {
              role: 'kris',
              text:
                'Start with **the architecture** at [strategytraining.com](https://strategytraining.com).' +
                brk +
                'It matters [1] and so does https://firmsconsulting.com - *really*.',
              at: Date.now() - 59000,
            },
          ],
        },
      ])
    );
  }, BREAK);
  await page.reload({ waitUntil: 'networkidle2' });
  await ready(page);
  await page.click('#historyBtn');
  await wait(250);
  const histCount = await page.$$eval('.history__item', (e) => e.length);
  check('history lists the stored conversation', histCount === 1, 'items=' + histCount);
  await page.screenshot({ path: path.join(OUT, 'history.png') });

  await page.click('.history__item');
  await wait(300);
  const rendered = await page.evaluate(() => {
    const kris = document.querySelector('.turn--kris');
    return {
      turns: document.querySelectorAll('.turn').length,
      bold: kris ? kris.querySelectorAll('strong').length : 0,
      chips: kris ? kris.querySelectorAll('.linkchip').length : 0,
      cites: kris ? kris.querySelectorAll('.cite').length : 0,
      italics: kris ? kris.querySelectorAll('em').length : 0,
      leakedStars: kris ? /\*\*/.test(kris.textContent) : true,
      bubbles: kris ? kris.querySelectorAll('.bubble').length : 0,
    };
  });
  console.log('        ' + JSON.stringify(rendered));
  check('clicking history restores the transcript', rendered.turns >= 2, 'turns=' + rendered.turns);
  check('bold renders', rendered.bold >= 1, String(rendered.bold));
  check('links render as chips', rendered.chips >= 2, String(rendered.chips));
  check('citations render', rendered.cites >= 1, String(rendered.cites));
  check('italics render', rendered.italics >= 1, String(rendered.italics));
  check('no leaked ** markers', !rendered.leakedStars);
  check('the answer splits into bubbles', rendered.bubbles >= 2, String(rendered.bubbles));
  await page.screenshot({ path: path.join(OUT, 'markdown.png') });

  /* ---- new chat -------------------------------------------------------- */
  console.log('');
  console.log('new chat');

  await page.click('#historyBtn');
  await wait(250);
  const newBtn = await page.evaluate(() => {
    const el = document.getElementById('historyNew');
    return { present: !!el, label: el ? el.textContent.trim() : '' };
  });
  check('the drawer offers New chat', newBtn.present && /New chat/.test(newBtn.label), newBtn.label);

  const kept = await page.evaluate(
    () => JSON.parse(localStorage.getItem('kris_ai_conversations_v1') || '[]').length
  );

  await page.click('#historyNew');
  await wait(400);
  const fresh = await page.evaluate(() => ({
    turns: document.querySelectorAll('.turn').length,
    inThread: document.getElementById('app').classList.contains('in-thread'),
    introVisible: getComputedStyle(document.getElementById('intro')).display !== 'none',
    drawerOpen: document.getElementById('history').classList.contains('is-open'),
    stored: JSON.parse(localStorage.getItem('kris_ai_conversations_v1') || '[]').length,
  }));
  console.log('        ' + JSON.stringify(fresh));

  check('New chat clears the thread', fresh.turns === 0 && !fresh.inThread);
  check('New chat returns to the landing', fresh.introVisible);
  check('New chat closes the drawer', !fresh.drawerOpen);
  check(
    'New chat keeps the earlier conversation in history',
    fresh.stored === kept,
    'before=' + kept + ' after=' + fresh.stored
  );

  /* ---- call view ------------------------------------------------------- */
  console.log('\ncall view');
  /* New chat returned us to the landing, where the Call pill is the way in -
     the header phone icon only exists once a conversation is open. */
  await page.click('#callBtn');
  await page.waitForSelector('.app.in-call', { timeout: 5000 });
  const callIdle = await page.evaluate(() => {
    const style = (s) => getComputedStyle(document.querySelector(s));
    return {
      viewShown: style('.callview').display !== 'none',
      startShown: style('.callstart').display !== 'none',
      ctlHidden: style('.callctl').display === 'none',
      meterHidden: style('.callview__meter').display === 'none',
      startLabel: document.getElementById('callStart').textContent.trim(),
      budget: document.getElementById('callBudget').textContent,
    };
  });
  console.log('        ' + JSON.stringify(callIdle));
  check('the call view opens', callIdle.viewShown);
  check('Start a call is offered', /Start a call|Chrome or Edge/.test(callIdle.startLabel));
  check('call controls hidden before connecting', callIdle.ctlHidden);
  check('the meter is hidden before connecting', callIdle.meterHidden);
  check('a minutes budget is shown', /minutes left/.test(callIdle.budget), callIdle.budget);
  await page.screenshot({ path: path.join(OUT, 'call-idle.png') });

  /* Force the connecting and live states so both are captured and asserted
     without needing a real speech service in headless Chrome. */
  await page.evaluate(() => {
    document.getElementById('app').classList.add('call-connecting');
    document.getElementById('callStatusText').textContent = 'Connecting';
  });
  await wait(150);
  await page.screenshot({ path: path.join(OUT, 'call-connecting.png') });
  const connecting = await page.evaluate(() => ({
    ctlShown: getComputedStyle(document.querySelector('.callctl')).display !== 'none',
    startHidden: getComputedStyle(document.querySelector('.callstart')).display === 'none',
  }));
  check('connecting shows mic and end call', connecting.ctlShown);
  check('connecting hides Start a call', connecting.startHidden);

  await page.evaluate(() => {
    const app = document.getElementById('app');
    app.classList.remove('call-connecting');
    app.classList.add('call-live');
    document.getElementById('callClock').textContent = '00:05';
    document.getElementById('callStatusText').textContent = 'Talking';
    document.getElementById('callStatus').classList.add('is-speaking');
    document.getElementById('callBars').hidden = false;
    document.getElementById('callDots').hidden = true;
  });
  await wait(200);
  const live = await page.evaluate(() => ({
    meterShown: getComputedStyle(document.querySelector('.callview__meter')).display !== 'none',
    barsShown: getComputedStyle(document.getElementById('callBars')).display !== 'none',
    clock: document.getElementById('callClock').textContent,
  }));
  check('the live meter appears', live.meterShown);
  check('the talking level meter appears', live.barsShown);
  check('the clock is shown', live.clock === '00:05', live.clock);
  await page.screenshot({ path: path.join(OUT, 'call-live.png') });

  console.log('\njs errors: ' + (errors.length ? errors.join(' | ') : 'none'));
  check('no page errors', errors.length === 0, errors.join(' | '));

  await browser.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
