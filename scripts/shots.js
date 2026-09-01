'use strict';

/* ---------------------------------------------------------------------------
   QA capture. Drives the installed Chrome through puppeteer-core so the
   layout viewport is genuinely the size asked for - plain `chrome
   --screenshot --window-size` crops a wider layout instead of resizing it,
   which silently hides responsive bugs.

   Usage:  node scripts/shots.js [baseUrl] [outDir]
   --------------------------------------------------------------------------- */

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const BASE = process.argv[2] || 'http://127.0.0.1:8080';
const OUT = process.argv[3] || path.join(__dirname, '..', '.shots');

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('No Chrome or Edge binary found. Pass one via CHROME_PATH.');
}

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 1000 },
  { name: 'tablet', width: 820, height: 1100 },
  { name: 'mobile', width: 414, height: 900, mobile: true },
  { name: 'mobile-narrow', width: 360, height: 820, mobile: true },
];

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || findChrome(),
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars'],
  });

  const report = [];

  for (const vp of VIEWPORTS) {
    const page = await browser.newPage();
    await page.setViewport({
      width: vp.width,
      height: vp.height,
      deviceScaleFactor: 1,
      isMobile: !!vp.mobile,
      hasTouch: !!vp.mobile,
    });

    await page.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 30000 });
    /* Wait for boot to resolve into either the chat or the gate. */
    await page
      .waitForFunction(
        () => {
          const app = document.getElementById('app');
          return app && !app.classList.contains('is-booting');
        },
        { timeout: 15000 }
      )
      .catch(() => {});

    /* The real test: does anything stick out sideways? */
    const overflow = await page.evaluate(() => {
      const docWidth = document.documentElement.clientWidth;
      const offenders = [];
      document.querySelectorAll('*').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return;
        if (r.right > docWidth + 1 || r.left < -1) {
          offenders.push({
            tag: el.tagName.toLowerCase(),
            cls: (typeof el.className === 'string' ? el.className : '') || '(none)',
            left: Math.round(r.left),
            right: Math.round(r.right),
          });
        }
      });
      return {
        viewport: window.innerWidth,
        docWidth,
        scrollWidth: document.documentElement.scrollWidth,
        offenders: offenders.slice(0, 8),
      };
    });

    report.push({ name: vp.name, asked: vp.width, ...overflow });

    await page.screenshot({
      path: path.join(OUT, 'page-' + vp.name + '.png'),
      fullPage: true,
    });

    /* Gate screen, same viewport. */
    await page.goto(BASE + '/?gate=not_subscribed', {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });
    await page.waitForSelector('.app.is-gated', { timeout: 10000 }).catch(() => {});
    await page.screenshot({ path: path.join(OUT, 'gate-' + vp.name + '.png') });

    await page.close();
  }

  /* A conversation, so the thread and thinking state get eyes on them too. */
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 1000, deviceScaleFactor: 1 });
  await page.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 30000 });
  await page
    .waitForFunction(() => !document.getElementById('app').classList.contains('is-booting'), {
      timeout: 15000,
    })
    .catch(() => {});

  await page.type('#input', 'What is the difference between a plan and a strategy?');
  await page.click('#sendBtn');
  /* Capture mid-flight, while the dots are showing. */
  await page.waitForSelector('.dots', { timeout: 5000 }).catch(() => {});
  await page.screenshot({ path: path.join(OUT, 'thread-thinking.png') });

  /* Then the settled answer. BuddyPro takes ~5-10s and does not stream. */
  await page
    .waitForFunction(() => !document.querySelector('.dots'), { timeout: 90000 })
    .catch(() => {});
  await new Promise((r) => setTimeout(r, 400));
  await page.screenshot({ path: path.join(OUT, 'thread-answer.png') });
  await page.close();

  await browser.close();

  console.log('\n--- overflow report ---');
  let bad = 0;
  for (const row of report) {
    const clean = row.offenders.length === 0 && row.scrollWidth <= row.docWidth + 1;
    if (!clean) bad++;
    console.log(
      '%s  asked=%d innerWidth=%d docWidth=%d scrollWidth=%d  %s',
      row.name.padEnd(14),
      row.asked,
      row.viewport,
      row.docWidth,
      row.scrollWidth,
      clean ? 'OK' : 'OVERFLOW'
    );
    for (const o of row.offenders) {
      console.log('     <%s class="%s"> left=%d right=%d', o.tag, o.cls, o.left, o.right);
    }
  }
  console.log('\nshots written to', OUT);
  process.exit(bad ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
