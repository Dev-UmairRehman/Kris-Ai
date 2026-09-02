'use strict';

/* ---------------------------------------------------------------------------
   The two Uscreen paste-ins, exercised in a real browser.

   They go into different boxes in the Uscreen admin and a mistake in either is
   invisible until a member hits it, so this serves a stand-in storefront and
   checks both.

   IT MIRRORS ONE UNOBVIOUS USCREEN BEHAVIOUR, AND THAT IS THE POINT:
   Uscreen does NOT inject the site-wide Head Code into landing pages. Verified
   on the live store - the homepage and /join carry it, /pages/kris-ai-memory
   carries none of it, not even the gift-card block that has been live since
   February. So here the landing page is served WITHOUT the head code, exactly
   as Uscreen serves it. That is why the identity bridge lives in the page's own
   Custom HTML: a bridge in the head code would never run, and every member
   would see "Please sign in" while logged in and subscribed.

   What gets checked:
     head code, block 2  page and link markers, on both Kris pages and elsewhere
     head code, block 3  the sub-nav hider and the nav highlight
     head code, block 4  routing a logged-out click to /join
     page snippet        the identity bridge, with no head code present

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
/* The host the nav's absolute hrefs point at. */
const REAL_ORIGIN = 'https://www.strategytraining.com';

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

const HEAD = fs.readFileSync(path.join(__dirname, '..', 'uscreen', 'head-code.html'), 'utf8');
const PAGE = fs.readFileSync(
  path.join(__dirname, '..', 'uscreen', 'kris-ai-memory-page.html'),
  'utf8'
);

const WIDGET_ORIGIN = (HEAD.match(/widgetOrigin: '([^']+)'/) || [])[1];
const MEMORY_PATH = (HEAD.match(/memory: '([^']+)'/) || [])[1];
const DELPHI_PATH = (HEAD.match(/delphi: '([^']+)'/) || [])[1];

/* The widget stub: speaks the widget's half of the protocol and records the
   answer, so no real request is ever made. */
const WIDGET_STUB =
  '<!doctype html><html><head><meta charset="utf-8"></head><body>' +
  '<script>' +
  'window.__got = null;' +
  "window.addEventListener('message', function (e) { window.__got = e.data; });" +
  "parent.postMessage({ type: 'kris-ai:ready' }, '*');" +
  '<\/script></body></html>';

/* The store's chrome, reproducing the trap that broke the first attempt: an
   <a href="/sign_in"> is present EVEN WHEN SIGNED IN (it lives in a menu), while
   the visible Sign in control is a <ds-button> and only appears when signed out.
   So "no sign-in link means signed in" reads every member as a visitor. Nothing
   here may infer login state from the DOM - it must ask /account. */
function chrome(signedIn) {
  return (
    '<header>header</header>' +
    /* the catalog sub-nav the head code hides */
    '<div class="w-full border-b border-ds-default bg-ds-main overflow-x-auto z-[20]">' +
    'Browse Favorites Playlists</div>' +
    '<nav>' +
    /* always present, signed in or not - this is the trap */
    '<a class="block py-2" href="/sign_in">Sign in</a>' +
    (signedIn ? '' : '<ds-button href="/sign_in">Sign in</ds-button>') +
    /* the nav stores absolute URLs, as the real one does */
    '<a id="navDelphi" href="https://www.strategytraining.com' + DELPHI_PATH + '">Kris AI</a>' +
    '<a id="navMemory" href="https://www.strategytraining.com' + MEMORY_PATH + '">Kris AI Memory</a>' +
    '<a id="navOther" href="/courses">Courses</a>' +
    '</nav>'
  );
}

/* A normal storefront page: Uscreen DOES inject the head code here. */
function storefront(signedIn) {
  return (
    '<!doctype html><html><head><meta charset="utf-8"><title>ST</title>' +
    HEAD +
    '</head><body>' +
    chrome(signedIn) +
    '</body></html>'
  );
}

/* A landing page: Uscreen does NOT inject the head code, so it is absent here
   on purpose. Only the page's own Custom HTML block is present. */
function landing(signedIn) {
  return (
    '<!doctype html><html><head><meta charset="utf-8"><title>Kris AI Memory</title>' +
    '</head><body>' +
    chrome(signedIn) +
    PAGE +
    '</body></html>'
  );
}

/* Uscreen's own answer, as measured on the live store: 401 with a JSON body for
   a visitor, 200 for a member. The member's email comes back with it, which is
   what names their memory thread. */
const MEMBER_EMAIL = 'member@strategytraining.com';

function accountResponse(signedIn) {
  if (!signedIn) return { status: 401, body: '[]' };
  return {
    status: 200,
    body: JSON.stringify({ user: { id: 4242, email: MEMBER_EMAIL } }),
  };
}

function serve() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, ORIGIN);
    const p = url.pathname.replace(/\/+$/, '') || '/';

    /* The page is served with ?signedIn=1; its later fetches have no query, so
       carry the state in a cookie the way a real session would. */
    const cookie = req.headers.cookie || '';
    const signedIn =
      url.searchParams.get('signedIn') === '1' || /(^|;\s*)fake_member=1/.test(cookie);

    if (p === '/account') {
      const a = accountResponse(signedIn);
      res.writeHead(a.status, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(a.body);
    }

    if (p === '/join') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<!doctype html><title>Join</title><h1>Join</h1>');
    }

    const headers = { 'Content-Type': 'text/html; charset=utf-8' };
    if (signedIn) headers['Set-Cookie'] = 'fake_member=1; Path=/';
    res.writeHead(200, headers);
    res.end(p === MEMORY_PATH ? landing(signedIn) : storefront(signedIn));
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
  if (/kris-ai:ready/.test(HEAD)) {
    console.error('The identity bridge is back in head-code.html. It cannot work there -');
    console.error('Uscreen does not inject Head Code into landing pages.');
    process.exit(1);
  }
  if (!/kris-ai:ready/.test(PAGE)) {
    console.error('The identity bridge is missing from the page snippet.');
    process.exit(1);
  }
  /* The DOM cannot tell you who is signed in on this store - see chrome(). */
  for (const [name, src] of [['head-code.html', HEAD], ['the page snippet', PAGE]]) {
    if (/querySelector\(\s*'a\[href="\/sign_in"\]/.test(src)) {
      console.error(name + ' infers login state from a /sign_in link in the DOM.');
      console.error('This store keeps that link when signed in - ask /account instead.');
      process.exit(1);
    }
    if (!/fetch\('\/account'/.test(src)) {
      console.error(name + ' does not ask Uscreen /account for login state.');
      process.exit(1);
    }
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
    /* Pages share one cookie jar, so a previous signed-in case would otherwise
       leak its session into the signed-out ones. */
    const cdp = await page.target().createCDPSession();
    await cdp.send('Network.clearBrowserCookies');
    /* Serve the widget origin from the stub, so the bridge's pinned-origin
       check is exercised for real rather than relaxed. */
    await page.setRequestInterception(true);
    page.on('request', (r) => {
      if (r.url().startsWith(WIDGET_ORIGIN)) {
        return r.respond({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: WIDGET_STUB,
        });
      }
      /* The nav stores absolute URLs, so following one would leave the fixture
         and hit the real site. Serve those from the fixture instead, which is
         what makes the absolute-href flow testable end to end. */
      if (r.url().startsWith(REAL_ORIGIN)) {
        const u = new URL(r.url());
        const rp = u.pathname.replace(/\/+$/, '') || '/';
        if (rp === '/account') {
          const a = accountResponse(signedIn);
          return r.respond({
            status: a.status,
            contentType: 'application/json; charset=utf-8',
            body: a.body,
          });
        }
        return r.respond({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: rp === MEMORY_PATH ? landing(signedIn) : storefront(signedIn),
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
    pageOf: window.ST_KRIS
      ? [
          window.ST_KRIS.pageOf('https://www.strategytraining.com/pages/kris-ai-memory'),
          window.ST_KRIS.pageOf('/delphi/'),
          window.ST_KRIS.pageOf('/courses'),
        ]
      : null,
  });

  /* Read the bridge's answer out of the widget stub. */
  async function identityFrom(page) {
    const handle = await page.$('.kris-ai-embed iframe');
    if (!handle) return null;
    const inner = await handle.contentFrame();
    return inner
      .waitForFunction(() => window.__got !== null, { timeout: 8000 })
      .then(() => inner.evaluate(() => window.__got))
      .catch(() => null);
  }

  /* ---- the page snippet, standing alone -------------------------------- */
  console.log('\npage snippet: the landing page, NO head code, signed in');
  let page = await open(MEMORY_PATH, true);
  let r = await page.evaluate(probe);

  check(
    'the head code really is absent here (as Uscreen serves it)',
    r.hasApi === false,
    'ST_KRIS was present - the fixture is wrong'
  );

  let id = await identityFrom(page);
  check('the widget gets an answer anyway', !!id, JSON.stringify(id));
  check('it is the identity message', id && id.type === 'st-kris:identity', JSON.stringify(id));
  check('a signed-in member is reported', id && id.signedIn === true, JSON.stringify(id));
  check(
    'the email comes through, so memory is per-member',
    id && id.email === MEMBER_EMAIL,
    JSON.stringify(id)
  );
  check('and the Uscreen id too', id && String(id.uscreenId) === '4242', JSON.stringify(id));
  await page.close();

  console.log('\npage snippet: the same page, logged out');
  page = await open(MEMORY_PATH, false);
  id = await identityFrom(page);
  check('signedIn is false for a visitor', id && id.signedIn === false, JSON.stringify(id));
  check(
    'no email leaks when logged out',
    id && !id.email && !id.uscreenId,
    JSON.stringify(id)
  );
  await page.close();

  /* ---- head code blocks 2 and 3 --------------------------------------- */
  console.log('\nhead code blocks 2 + 3: the existing Delphi page');
  page = await open(DELPHI_PATH, true);
  r = await page.evaluate(probe);

  check('the shared API is exposed', r.hasApi);
  check('<html> is marked st-kris', /\bst-kris\b/.test(r.cls), r.cls);
  check('<html> is marked st-delphi', /\bst-delphi\b/.test(r.cls), r.cls);
  check('the catalog sub-nav is hidden', r.subnavHidden);
  check('the Delphi nav link is current', /is-current/.test(r.delphiLink), r.delphiLink);
  check('the Memory nav link is not', !/is-current/.test(r.memoryLink), r.memoryLink);
  check('an unrelated nav link is untouched', r.otherLink === '', r.otherLink);
  check(
    'pageOf resolves the real /pages/ slug, and relative hrefs',
    JSON.stringify(r.pageOf) === JSON.stringify(['memory', 'delphi', '']),
    JSON.stringify(r.pageOf)
  );
  await page.close();

  /* ---- head code block 2, an unrelated page --------------------------- */
  console.log('\nhead code block 2: an unrelated page is left alone');
  page = await open('/courses', true);
  r = await page.evaluate(probe);
  check('no Kris class is set', !/st-kris|st-delphi/.test(r.cls), r.cls || '(none)');
  check('the sub-nav is visible', !r.subnavHidden);
  check('no nav link is current', !/is-current/.test(r.memoryLink + r.delphiLink));
  check('the Memory link is still recognised as a Kris link', /st-kris-link/.test(r.memoryLink), r.memoryLink);
  await page.close();

  /* ---- head code block 4, routing ------------------------------------- */
  console.log('\nhead code block 4: a logged-out click goes to /join');
  page = await open('/courses', false);
  await page.click('#navMemory');
  await page.waitForFunction(() => location.pathname === '/join', { timeout: 8000 }).catch(() => {});
  check('logged out -> /join', new URL(page.url()).pathname === '/join', page.url());
  await page.close();

  console.log('\nhead code block 4: a signed-in click is left alone');
  page = await open('/courses', true);
  await page.click('#navMemory');
  await page
    .waitForFunction((p) => location.pathname.replace(/\/+$/, '') === p, { timeout: 8000 }, MEMORY_PATH)
    .catch(() => {});
  check(
    'signed in -> the Kris AI Memory page, not /join',
    new URL(page.url()).pathname.replace(/\/+$/, '') === MEMORY_PATH,
    page.url()
  );
  check('...and the widget lets them in once there', (await identityFrom(page) || {}).signedIn === true);
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
