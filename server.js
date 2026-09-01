'use strict';

/* ---------------------------------------------------------------------------
   Kris AI - server

   Routes
     GET  /healthz        liveness. No gate.
     GET  /               standalone full page.  Members only.
     GET  /embed          bare widget for the Uscreen iframe. Members only.
     GET  /api/session    current session state, used to boot the page.
     POST /api/session    exchange a store identity claim for a session cookie.
     POST /api/chat       ask Kris one question.

   The BuddyPro key and the Uscreen key exist only in this process. Nothing
   secret is ever written into the page.
   --------------------------------------------------------------------------- */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');

const config = require('./lib/config');
const auth = require('./lib/auth');
const uscreen = require('./lib/uscreen');
const ratelimit = require('./lib/ratelimit');
const buddypro = require('./lib/buddypro');

const app = express();
app.disable('x-powered-by');
/* DigitalOcean App Platform sits behind a proxy - trust it for protocol and IP. */
app.set('trust proxy', true);

/* ---- template ----------------------------------------------------------- */

const TEMPLATE_PATH = path.join(__dirname, 'views', 'app.html');
let template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
if (!config.isProd) {
  /* Pick up edits without a restart while developing. */
  app.use((req, res, next) => {
    template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
    next();
  });
}

function render(mode, bootstrap) {
  return template
    .replace(/\{\{MODE\}\}/g, mode)
    .replace(
      '{{BOOTSTRAP}}',
      /* Inlined as JSON. `<` is escaped so a value can never close the script. */
      JSON.stringify(bootstrap).replace(/</g, '\\u003c')
    );
}

/* ---- global middleware -------------------------------------------------- */

app.use((req, res, next) => {
  auth.securityHeaders(req, res);
  auth.applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

app.use(express.json({ limit: '12mb' })); // audio uploads arrive base64

/* Static assets only. The HTML never lives under /public, so there is no
   ungated path to it. */
app.use(
  '/static',
  express.static(path.join(__dirname, 'public'), {
    maxAge: config.isProd ? '7d' : 0,
    index: false,
    dotfiles: 'ignore',
    setHeaders(res, filePath) {
      if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
        res.setHeader('Cache-Control', config.isProd ? 'public, max-age=604800' : 'no-store');
      }
    },
  })
);

/* ---- health ------------------------------------------------------------- */

app.get('/healthz', (req, res) => {
  res.json({
    ok: true,
    env: config.env,
    gate: config.gateMode,
    buddyproSurface: config.buddypro.surface,
    uscreenConfigured: !!(config.uscreen.apiBase && config.uscreen.apiKey),
    voiceEnabled: config.voiceEnabled,
  });
});

/* ---- session ------------------------------------------------------------ */

/* Bearer first, cookie second. The bearer is what the cross-site iframe uses,
   because third-party cookies are blocked in Safari and being restricted in
   Chrome. The cookie still serves the standalone page, where it is first-party. */
function currentSession(req) {
  const bearer = auth.readBearer(req);
  if (bearer) {
    const fromBearer = auth.readSession(bearer);
    if (fromBearer) return fromBearer;
  }
  const cookies = auth.parseCookies(req);
  return auth.readSession(cookies[auth.COOKIE]);
}

function publicBootstrap(extra) {
  return {
    apiBase: '',
    joinUrl: config.store.joinUrl,
    signInUrl: config.store.signInUrl,
    storeOrigin: config.store.origin,
    allowedParentOrigins: Array.from(auth.allowedOrigins()),
    devPreview: !config.isProd,
    voiceEnabled: config.voiceEnabled,
    ...extra,
  };
}

app.get('/api/session', (req, res) => {
  const session = currentSession(req);
  res.setHeader('Cache-Control', 'no-store');
  if (!session) {
    return res.status(401).json({
      ok: false,
      reason: 'no_session',
      joinUrl: config.store.joinUrl,
      signInUrl: config.store.signInUrl,
    });
  }
  res.json({ ok: true, verifiedBy: session.src, expiresAt: session.exp });
});

/**
 * The store page tells us who the signed-in visitor is. That claim is verified
 * against Uscreen before it becomes a session.
 *
 * Body: { email?: string, uscreenId?: string|number }
 */
app.post('/api/session', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (!auth.isTrustedRequestOrigin(req)) {
    return res.status(403).json({ ok: false, reason: 'untrusted_origin' });
  }

  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const uscreenId = req.body?.uscreenId != null ? String(req.body.uscreenId).trim() : '';

  const deny = (reason, status = 403) => {
    auth.clearSessionCookie(res);
    return res.status(status).json({
      ok: false,
      reason,
      joinUrl: config.store.joinUrl,
      signInUrl: config.store.signInUrl,
    });
  };

  /* --- open: local development only. config.js refuses this in production. -- */
  if (config.gateMode === 'open') {
    const profileId = auth.profileIdFor(email || uscreenId || 'dev-local');
    const token = auth.mintSession({ profileId, verifiedBy: 'frame' });
    auth.setSessionCookie(res, token);
    return res.json({ ok: true, verifiedBy: 'open', token, handoff: auth.mintHandoff(profileId) });
  }

  /* --- frame: being inside the members-only /delphi page is the proof. ----- */
  if (config.gateMode === 'frame') {
    if (!auth.isFramedByStore(req) && !auth.isTrustedRequestOrigin(req)) {
      return deny('not_framed_by_store');
    }
    /* With no verified identity there is nothing stable to key memory on, so
       each browser gets its own durable pseudonymous thread. */
    const seed = email || uscreenId || pseudonymSeed(req, res);
    const profileId = auth.profileIdFor(seed);
    const token = auth.mintSession({ profileId, verifiedBy: 'frame' });
    auth.setSessionCookie(res, token);
    return res.json({ ok: true, verifiedBy: 'frame', token, handoff: auth.mintHandoff(profileId) });
  }

  /* --- strict: confirm the subscription with Uscreen. --------------------- */
  if (!email) return deny('no_identity_from_store', 401);

  let verdict;
  try {
    verdict = await uscreen.verifySubscriber(email);
  } catch (err) {
    console.error('[session] uscreen verification threw:', err.message);
    return deny('verification_unavailable', 503);
  }

  if (!verdict.ok) {
    /* not_subscribed and customer_not_found are the member's answer. The rest
       are our problem, and are logged loudly so they get noticed. */
    if (
      verdict.reason !== 'not_subscribed' &&
      verdict.reason !== 'customer_not_found' &&
      verdict.reason !== 'customer_mismatch'
    ) {
      console.error('[session] gate could not verify (%s) for %s', verdict.reason, mask(email));
      return deny(verdict.reason, 503);
    }
    return deny(verdict.reason, 403);
  }

  const profileId = auth.profileIdFor(uscreenId || verdict.customerId || email);
  const token = auth.mintSession({ profileId, verifiedBy: 'uscreen' });
  auth.setSessionCookie(res, token);
  res.json({ ok: true, verifiedBy: 'uscreen', token, handoff: auth.mintHandoff(profileId) });
});

/* A stable per browser id for `frame` mode, kept in its own long lived cookie
   so a member's thread survives page reloads. */
function pseudonymSeed(req, res) {
  const cookies = auth.parseCookies(req);
  const existing = cookies.kris_anon;
  if (existing && /^[a-f0-9]{32}$/.test(existing)) return 'anon:' + existing;

  const fresh = crypto.randomBytes(16).toString('hex');
  res.append(
    'Set-Cookie',
    'kris_anon=' + fresh + '; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=31536000'
  );
  return 'anon:' + fresh;
}

function mask(email) {
  const at = email.indexOf('@');
  return at > 1 ? email[0] + '***' + email.slice(at) : '***';
}

/* ---- pages -------------------------------------------------------------- */

/* Bare widget, for the iframe on strategytraining.com/delphi.
   Always served as HTML: a 302 here would render the join page inside the
   iframe, which reads as a broken embed. The page itself shows the gate and
   links out with target="_top". */
app.get('/embed', (req, res) => {
  const session = currentSession(req);
  const framed = auth.isFramedByStore(req);

  /* A direct top level hit on /embed with no session is not a member. */
  if (!session && !framed && config.gateMode !== 'open') {
    return res.redirect(302, config.store.joinUrl);
  }

  res.setHeader('Cache-Control', 'no-store');
  res.type('html').send(
    render('embed', publicBootstrap({ hasSession: !!session, framed }))
  );
});

/* Standalone full page. The session cookie is SameSite=None, so a member who
   has used the widget inside Uscreen is recognised here too. Anyone else is
   sent to the join page, which is the whole requirement. */
app.get('/', (req, res) => {
  let session = currentSession(req);

  /* A member arriving from the embed carries a short-lived handoff token. The
     iframe cannot set a usable cookie (third-party), but this navigation is
     top-level, so the cookie set here is first-party and sticks. */
  const handoff = typeof req.query.t === 'string' ? req.query.t : '';
  if (!session && handoff) {
    const claim = auth.readSession(handoff);
    if (claim && claim.src === 'handoff') {
      const token = auth.mintSession({ profileId: claim.sub, verifiedBy: 'handoff' });
      auth.setSessionCookie(res, token);
      /* Drop the token from the URL so it cannot be shared or logged. */
      return res.redirect(302, '/');
    }
  }

  if (!session && config.gateMode !== 'open') {
    return res.redirect(302, config.store.joinUrl);
  }

  res.setHeader('Cache-Control', 'no-store');
  res.type('html').send(render('page', publicBootstrap({ hasSession: !!session, framed: false })));
});

/* ---- chat -------------------------------------------------------------- */

app.post('/api/chat', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (!auth.isTrustedRequestOrigin(req)) {
    return res.status(403).json({ error: 'Request came from an unrecognised page.' });
  }

  const session = currentSession(req);
  if (!session) {
    return res.status(401).json({
      error: 'Your session has expired.',
      reason: 'no_session',
      joinUrl: config.store.joinUrl,
    });
  }

  const message = typeof req.body?.message === 'string' ? req.body.message : '';
  const audio = typeof req.body?.audio === 'string' ? req.body.audio : null;
  const wantAudio = req.body?.wantAudio === true;

  /* BuddyPro accepts exactly these input formats. Anything else is rejected
     here rather than spending an upstream call to be told the same thing. */
  const ALLOWED_AUDIO = ['mp3', 'wav', 'ogg', 'aac', 'flac'];
  const requestedFormat =
    typeof req.body?.audioFormat === 'string' ? req.body.audioFormat.toLowerCase() : 'wav';

  if (audio && !config.voiceEnabled) {
    return res.status(503).json({
      error:
        'Voice is not enabled for Kris AI Memory yet. Please type your question - Kris will answer.',
      reason: 'voice_disabled',
    });
  }

  if (audio && !ALLOWED_AUDIO.includes(requestedFormat)) {
    return res.status(400).json({
      error: 'That audio format is not supported. Please type your question instead.',
    });
  }
  const audioFormat = requestedFormat;

  if (!message.trim() && !audio) {
    return res.status(400).json({ error: 'Empty message.' });
  }
  if (message.length > buddypro.MAX_TEXT_CHARS) {
    return res.status(413).json({ error: 'That message is too long.' });
  }

  const slot = ratelimit.claim(session.sub);
  if (!slot.allowed) {
    res.setHeader('Retry-After', String(slot.retryAfter));
    return res.status(429).json({ error: slot.message, retryAfter: slot.retryAfter });
  }

  try {
    const answer = await buddypro.ask({
      text: message,
      profileId: session.sub,
      wantAudio,
      audioInput: audio,
      audioFormat,
    });

    res.json({
      content: answer.content,
      audio: answer.audio ? answer.audio.dataUrl : null,
      transcript: answer.audio ? answer.audio.transcript : null,
      image: answer.image ? answer.image.dataUrl : null,
      imageCaption: answer.image ? answer.image.caption : null,
    });
  } catch (err) {
    /* The upstream call never happened, or failed before doing work - do not
       charge the member for it. */
    if (err instanceof buddypro.BuddyProError && (err.status === 502 || err.status === 503)) {
      ratelimit.release(session.sub);
    }

    const status = err instanceof buddypro.BuddyProError ? err.status : 500;
    if (err.retryAfter) res.setHeader('Retry-After', String(err.retryAfter));
    if (status >= 500) console.error('[chat] failed:', err.message);

    res.status(status).json({
      error:
        err instanceof buddypro.BuddyProError
          ? err.message
          : 'That did not go through. Try again in a moment.',
    });
  }
});

/* ---- fallbacks --------------------------------------------------------- */

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found.' });
  res.redirect(302, config.store.joinUrl);
});

app.use((err, req, res, _next) => {
  console.error('[unhandled]', err);
  if (res.headersSent) return;
  const isJson = req.path.startsWith('/api/');
  res.status(500);
  if (isJson) res.json({ error: 'Something went wrong.' });
  else res.type('text').send('Something went wrong.');
});

/* ---- boot -------------------------------------------------------------- */

const server = app.listen(config.port, () => {
  console.log(
    '[kris-ai] listening on :%d  env=%s  gate=%s  buddypro=%s  uscreen=%s',
    config.port,
    config.env,
    config.gateMode,
    config.buddypro.surface,
    config.uscreen.apiBase && config.uscreen.apiKey ? 'configured' : 'NOT configured'
  );
  if (config.gateMode === 'frame') {
    console.warn(
      '[kris-ai] gate=frame: membership is inferred from the iframe host, not verified against Uscreen.'
    );
  }
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log('[kris-ai] %s received, closing.', signal);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10000).unref();
  });
}

module.exports = app;
