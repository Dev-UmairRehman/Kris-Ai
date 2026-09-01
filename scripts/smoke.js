'use strict';

/* ---------------------------------------------------------------------------
   Smoke test. Exercises the gate and the chat path against a running server.

   Usage:
     node scripts/smoke.js                       # http://127.0.0.1:8080
     node scripts/smoke.js https://your-app.app  # a deployed instance
     LIVE=1 node scripts/smoke.js                # also spend one real
                                                 # BuddyPro call

   Exit code 0 = every assertion held.
   --------------------------------------------------------------------------- */

const BASE = (process.argv[2] || 'http://127.0.0.1:8080').replace(/\/+$/, '');
const LIVE = process.env.LIVE === '1';

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

/* A tiny cookie jar, so the session survives between calls. */
const jar = new Map();

function jarHeader() {
  return Array.from(jar, ([k, v]) => k + '=' + v).join('; ');
}

function remember(res) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const line of raw) {
    const [pair] = line.split(';');
    const eq = pair.indexOf('=');
    if (eq < 1) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (value) jar.set(name, value);
    else jar.delete(name);
  }
}

async function call(path, opts = {}) {
  const headers = Object.assign(
    { Origin: BASE, 'Content-Type': 'application/json' },
    opts.headers || {}
  );
  if (jar.size) headers.Cookie = jarHeader();

  const res = await fetch(BASE + path, {
    method: opts.method || 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    redirect: 'manual',
  });
  remember(res);

  let body = null;
  const text = await res.text();
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers };
}

async function main() {
  console.log('smoke: ' + BASE + (LIVE ? '  (LIVE - will spend one BuddyPro call)' : ''));

  /* ---- health --------------------------------------------------------- */
  console.log('\nhealth');
  const health = await call('/healthz');
  check('/healthz returns 200', health.status === 200, 'got ' + health.status);
  check('reports a gate mode', !!(health.body && health.body.gate), JSON.stringify(health.body));
  const gateMode = health.body && health.body.gate;

  /* ---- security headers ----------------------------------------------- */
  console.log('\nsecurity headers');
  const root = await call('/');
  const csp = root.headers.get('content-security-policy') || '';
  check('frame-ancestors is set', csp.includes('frame-ancestors'), csp.slice(0, 80));
  check(
    'frame-ancestors names strategytraining.com',
    csp.includes('strategytraining.com'),
    csp.slice(0, 120)
  );
  check("connect-src is 'self'", csp.includes("connect-src 'self'"));
  check('nosniff is set', root.headers.get('x-content-type-options') === 'nosniff');

  /* ---- the gate ------------------------------------------------------- */
  console.log('\ngate');
  const chatNoSession = await call('/api/chat', { method: 'POST', body: { message: 'hi' } });
  check(
    '/api/chat without a session is refused',
    chatNoSession.status === 401,
    'got ' + chatNoSession.status
  );

  const foreign = await call('/api/session', {
    method: 'POST',
    body: { email: 'x@example.com' },
    headers: { Origin: 'https://evil.example.com' },
  });
  check(
    '/api/session from a foreign origin is refused',
    foreign.status === 403,
    'got ' + foreign.status
  );

  if (gateMode !== 'open') {
    const bare = await call('/embed');
    check(
      '/embed with no session and no frame redirects away',
      bare.status === 302,
      'got ' + bare.status
    );
    const target = bare.headers.get('location') || '';
    check('...and it redirects to the join page', target.includes('/join'), target);
  } else {
    console.log('  SKIP  direct-hit redirects (gate=open, development only)');
  }

  /* ---- session + chat -------------------------------------------------- */
  console.log('\nsession');
  const session = await call('/api/session', {
    method: 'POST',
    body: { email: 'smoke-test@example.com' },
  });

  if (gateMode === 'strict') {
    check(
      'strict mode refuses an unknown email',
      session.status === 403 || session.status === 503,
      'got ' + session.status + ' ' + JSON.stringify(session.body)
    );
    console.log('  SKIP  chat (strict mode needs a real member)');
  } else {
    check('a session is granted', session.status === 200, JSON.stringify(session.body));
    check('a session cookie was set', jar.has('kris_sess'), Array.from(jar.keys()).join(','));

    const state = await call('/api/session');
    check('GET /api/session confirms it', state.status === 200, 'got ' + state.status);

    const empty = await call('/api/chat', { method: 'POST', body: { message: '   ' } });
    check('an empty message is rejected', empty.status === 400, 'got ' + empty.status);

    if (LIVE) {
      console.log('\nchat (live BuddyPro call)');
      const started = Date.now();
      const chat = await call('/api/chat', {
        method: 'POST',
        body: { message: 'Reply with exactly: SMOKE OK' },
      });
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      check('chat returns 200', chat.status === 200, JSON.stringify(chat.body).slice(0, 200));
      check(
        'chat returns content',
        !!(chat.body && typeof chat.body.content === 'string' && chat.body.content.length),
        JSON.stringify(chat.body).slice(0, 200)
      );
      console.log('        answered in ' + seconds + 's');
    } else {
      console.log('\n  SKIP  live chat call (set LIVE=1 to include it)');
    }
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('\nsmoke crashed:', err.message);
  process.exit(1);
});
