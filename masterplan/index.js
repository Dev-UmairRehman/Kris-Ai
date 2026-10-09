'use strict';

/* ---------------------------------------------------------------------------
   MasterPlan Digital - routes, mounted at /masterplan by server.js.

     GET    /healthz                  module state. No gate.
     GET    /embed                    the page, for the Uscreen iframe.
     GET    /static/...               page assets (and PDF.js).
     POST   /api/session              store identity -> MasterPlan session
     GET    /api/reports              my reports + my sharing choice
     POST   /api/reports              start a new MasterPlan
     POST   /api/reports/:id/retry    re-run a failed one
     DELETE /api/reports/:id          delete mine
     GET    /api/reports/:id/:doc     PDF bytes for the viewer (narrative|article)
     GET    /api/library              shared reports (only for members who share)
     POST   /api/sharing              { sharing: true|false }

   Membership is checked exactly as for Kris AI Memory (lib/auth.js, the same
   frame lock, origin check and Uscreen identity), but the session token is
   this module's own: a different payload signed with a different context, so a
   Kris AI token can never act as a MasterPlan token or the reverse.
   --------------------------------------------------------------------------- */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');

const rootConfig = require('../lib/config');
const auth = require('../lib/auth');
const uscreen = require('../lib/uscreen');
const config = require('./config');

const router = express.Router();
if (config.enabled) {
  const knowledgeProblem = require('./knowledge').problem();
  if (knowledgeProblem) config.problems.push(knowledgeProblem);
}
const ready = config.enabled && config.problems.length === 0;

/* jobs pulls in the SDK, pdfmake and the knowledge files; only load it when
   the module can actually run. */
const jobs = ready ? require('./jobs') : null;

/* ---- session ---------------------------------------------------------------- */

const TTL = 4 * 3600;

function sign(body) {
  return crypto.createHmac('sha256', rootConfig.session.secret).update('masterplan.' + body).digest('base64url');
}

/* scope 'full' opens the account; scope 'link' (an unrecognised browser on an
   account that has MasterPlans) can only enter a link code. `dev` is the hash
   of the device key, checked again on every request so removing a device
   ends its access at once. */
function mint(memberId, scope, dev) {
  const body = Buffer.from(
    JSON.stringify({ aud: 'mp', sub: memberId, scope, dev, exp: Math.floor(Date.now() / 1000) + TTL })
  ).toString('base64url');
  return body + '.' + sign(body);
}

function deviceHash(key) {
  return crypto.createHmac('sha256', rootConfig.session.secret).update('masterplan.device.' + key).digest('hex');
}

function readToken(req) {
  const token = auth.readBearer(req);
  if (!token) return null;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  const a = Buffer.from(token.slice(dot + 1));
  const b = Buffer.from(sign(body));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (p.aud !== 'mp' || typeof p.sub !== 'string' || p.exp < Date.now() / 1000) return null;
    return p;
  } catch {
    return null;
  }
}

const memberIdFor = (email) => auth.profileIdFor('masterplan:' + email).replace(/^st_/, 'mp_');

/* ---- page ------------------------------------------------------------------- */

const VIEW = path.join(__dirname, 'views', 'app.html');
const PUBLIC = path.join(__dirname, 'public');
/* The legacy build carries polyfills for the newest JavaScript the modern
   build relies on (Map.getOrInsertComputed, Promise.withResolvers, ...), so
   the viewer draws pages on browsers that are a year or two old. */
const PDFJS = path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'legacy', 'build');
const PDFJS_VERSION = require('pdfjs-dist/package.json').version;

function assetVersion() {
  const h = crypto.createHash('sha1');
  for (const f of ['app.js', 'app.css']) h.update(fs.readFileSync(path.join(PUBLIC, f)));
  return h.digest('hex').slice(0, 10);
}
let assetV = assetVersion();
let template = fs.readFileSync(VIEW, 'utf8');

router.use((req, res, next) => {
  if (!rootConfig.isProd) {
    template = fs.readFileSync(VIEW, 'utf8');
    assetV = assetVersion();
  }
  next();
});

const staticOpts = (maxAge) => ({
  maxAge: rootConfig.isProd ? maxAge : 0,
  index: false,
  dotfiles: 'ignore',
});
router.use('/static/pdfjs', (req, res, next) => {
  /* Only the two files the viewer needs, never the whole package. */
  if (!/^\/pdf(\.worker)?\.min\.mjs$/.test(req.path)) return res.status(404).end();
  next();
}, express.static(PDFJS, staticOpts('30d')));
router.use(
  '/static',
  express.static(PUBLIC, {
    ...staticOpts('7d'),
    /* The storefront loader is pasted once and updated only by deploying, so
       it gets five minutes, not a week (same as Kris AI's embed.js). */
    setHeaders(res, file) {
      if (file.endsWith('embed.js')) res.setHeader('Cache-Control', rootConfig.isProd ? 'public, max-age=300' : 'no-store');
    },
  })
);

router.get('/healthz', (req, res) => {
  res.json({
    ok: ready,
    enabled: config.enabled,
    problems: config.problems,
    storage: config.storage.driver,
    model: config.anthropic.model,
    email: config.email.driver,
  });
});

router.get('/embed', (req, res) => {
  const framed = auth.isFramedByStore(req);
  if (!framed && rootConfig.gateMode !== 'open') return res.redirect(302, rootConfig.store.joinUrl);

  const report = typeof req.query.report === 'string' && /^[\w-]{8,40}$/.test(req.query.report) ? req.query.report : '';
  const boot = {
    ready,
    joinUrl: rootConfig.store.joinUrl,
    signInUrl: rootConfig.store.signInUrl,
    allowedParentOrigins: Array.from(auth.allowedOrigins()),
    devOpen: rootConfig.gateMode === 'open',
    openReport: report,
    bare: req.query.bare === '1',
    maxUploadBytes: config.maxUploadBytes,
    pdfjsVersion: PDFJS_VERSION,
  };
  res.setHeader('Cache-Control', 'no-store');
  res.type('html').send(
    template
      .replace(/\{\{ASSET_V\}\}/g, assetV)
      .replace('{{BOOTSTRAP}}', JSON.stringify(boot).replace(/</g, '\\u003c'))
  );
});

/* Local preview of the Uscreen page (uscreen/masterplan-page.html) inside a
   stand-in store header and footer, with the loader pointed at this server.
   Development only: 404 in production. */
router.get('/preview', (req, res) => {
  if (rootConfig.isProd) return res.status(404).end();
  const block = fs
    .readFileSync(path.join(__dirname, '..', 'uscreen', 'masterplan-page.html'), 'utf8')
    /* Talk to this server instead of the deployed one. */
    .replace(/"apiOrigin":"[^"]*"/, '"apiOrigin":"","localApi":true');
  res.setHeader('Cache-Control', 'no-store');
  res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Preview - MasterPlan Digital</title>
<link rel="icon" href="data:,">
<style>body{margin:0;font-family:system-ui,sans-serif}
.st-bar{display:flex;align-items:center;gap:28px;padding:18px 32px;border-bottom:1px solid #e5e5e5;font-size:14px}
.st-bar b{font-size:17px;margin-right:auto}.st-foot{padding:40px 32px;background:#0f1d29;color:#c9d3dc;font-size:13px}</style>
</head><body><header class="st-bar"><b>StrategyTraining</b><span>Browse</span><span>Kris AI</span><span>MasterPlan Digital</span><span>Account</span></header>
${block}
<footer class="st-foot">Store footer (stand-in for the Uscreen footer)</footer></body></html>`);
});

/* ---- api ------------------------------------------------------------------- */

router.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!ready) return res.status(503).json({ error: 'The MasterPlan is not available yet.', reason: 'not_configured' });
  if (!auth.isTrustedRequestOrigin(req)) return res.status(403).json({ error: 'Request came from an unrecognised page.' });
  next();
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.post('/api/session', async (req, res, next) => {
  try {
    await openSession(req, res);
  } catch (err) {
    console.error('[masterplan] session failed:', err);
    if (!res.headersSent) res.status(503).json({ ok: false, reason: 'verification_unavailable' });
  }
});

async function openSession(req, res) {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const signedIn = req.body?.signedIn === true;
  const deny = (reason, status = 403) =>
    res.status(status).json({ ok: false, reason, joinUrl: rootConfig.store.joinUrl, signInUrl: rootConfig.store.signInUrl });

  let useEmail = email;
  if (rootConfig.gateMode === 'open') {
    useEmail = email || config.devEmail;
  } else if (rootConfig.gateMode === 'frame') {
    if (!auth.isFramedByStore(req) && !auth.isTrustedRequestOrigin(req)) return deny('not_framed_by_store');
    if (rootConfig.requireStoreIdentity && !signedIn) return deny('no_identity_from_store', 401);
  } else {
    if (!email) return deny('no_identity_from_store', 401);
    try {
      const verdict = await uscreen.verifySubscriber(email);
      if (!verdict.ok) return deny(verdict.reason, 403);
    } catch (err) {
      console.error('[masterplan] uscreen verification threw:', err.message);
      return deny('verification_unavailable', 503);
    }
  }

  /* Results are emailed and owned by the account, so an email is required.
     Asset names such as logo@2x.png look like emails; refuse them. */
  if (!EMAIL_RE.test(useEmail) || useEmail.length > 320 || /\.(png|jpe?g|gif|svg|webp|css|js|ico)$/i.test(useEmail)) {
    return deny('no_email', 401);
  }

  /* Where the store's Uscreen API is configured, the email must also belong to
     an active subscriber. Only a clear "no" from Uscreen refuses; a Uscreen
     outage does not lock members out (the device key below still protects
     every account). */
  if (rootConfig.gateMode !== 'strict' && rootConfig.uscreen.apiBase && rootConfig.uscreen.apiKey) {
    try {
      const verdict = await uscreen.verifySubscriber(useEmail);
      if (!verdict.ok && (verdict.reason === 'not_subscribed' || verdict.reason === 'customer_not_found')) {
        return deny(verdict.reason, 403);
      }
    } catch (err) {
      console.warn('[masterplan] uscreen check unavailable:', err.message);
    }
  }

  const deviceKey = typeof req.body?.deviceKey === 'string' ? req.body.deviceKey : '';
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(deviceKey)) return deny('no_device', 400);
  const dev = deviceHash(deviceKey);

  const memberId = memberIdFor(useEmail);
  /* Express 4 does not catch a rejected promise, and an unhandled rejection
     ends the process - Kris AI included. Every await here is caught. */
  let scope;
  try {
    scope = await jobs.claimDevice(memberId, useEmail, dev);
  } catch (err) {
    console.error('[masterplan] session: storage failed:', err.message);
    return deny('verification_unavailable', 503);
  }
  res.json({ ok: true, scope, token: mint(memberId, scope, dev), email: useEmail });
}

/* Every data route needs a full session from a device still linked to the
   account. The device check is one cached read. */
async function checkSession(req, res, needFull) {
  const s = readToken(req);
  if (!s || !s.dev) {
    res.status(401).json({ error: 'Your session has expired. Reload the page.', reason: 'no_session' });
    return null;
  }
  if (needFull && s.scope !== 'full') {
    res.status(403).json({ error: 'Link this browser to your account first.', reason: 'needs_link' });
    return null;
  }
  if (s.scope === 'full' && !(await jobs.hasDevice(s.sub, s.dev))) {
    res.status(401).json({ error: 'This browser is no longer linked to the account. Reload the page.', reason: 'no_session' });
    return null;
  }
  return s;
}

function requireSession(req, res, next) {
  checkSession(req, res, true).then(
    (s) => {
      if (!s) return;
      req.memberId = s.sub;
      req.device = s.dev;
      next();
    },
    (err) => {
      console.error('[masterplan] session check failed:', err.message);
      if (!res.headersSent) res.status(503).json({ error: 'Please try again in a moment.', reason: 'service_down' });
    }
  );
}

function requireAnySession(req, res, next) {
  checkSession(req, res, false).then(
    (s) => {
      if (!s) return;
      req.memberId = s.sub;
      req.device = s.dev;
      next();
    },
    (err) => {
      console.error('[masterplan] session check failed:', err.message);
      if (!res.headersSent) res.status(503).json({ error: 'Please try again in a moment.', reason: 'service_down' });
    }
  );
}

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => {
    if (err.userFacing) return res.status(err.status || 400).json({ error: err.message });
    console.error('[masterplan] %s %s failed:', req.method, req.originalUrl, err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  });

router.get('/api/reports', requireSession, wrap(async (req, res) => {
  res.json(await jobs.listMine(req.memberId));
}));

/* ---- devices ---------------------------------------------------------------- */

/* On a linked browser: a one-time code (15 minutes, 5 tries) to add another. */
router.post('/api/devices/code', requireSession, wrap(async (req, res) => {
  res.json({ ok: true, ...(await jobs.newLinkCode(req.memberId)) });
}));

/* On a new browser: enter that code to be linked. */
router.post('/api/devices/link', requireAnySession, wrap(async (req, res) => {
  const code = typeof req.body?.code === 'string' ? req.body.code.slice(0, 20) : '';
  const ok = code && (await jobs.linkDevice(req.memberId, req.device, code));
  if (!ok) return res.status(400).json({ error: 'That code is not right, or it has expired. Get a new code and try again.' });
  res.json({ ok: true, scope: 'full', token: mint(req.memberId, 'full', req.device) });
}));

const clip = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');

router.post('/api/reports', requireSession, wrap(async (req, res) => {
  const b = req.body || {};
  const form = {
    name: clip(b.name, 120),
    pronouns: ['she/her', 'he/him', 'they/them'].includes(b.pronouns) ? b.pronouns : '',
    city: clip(b.city, 80),
    region: clip(b.region, 80),
    postalCode: clip(b.postalCode, 20),
    country: clip(b.country, 60),
    links: (Array.isArray(b.links) ? b.links : [])
      .map((u) => clip(u, 300))
      .filter((u) => /^https?:\/\//i.test(u))
      .slice(0, 4),
    pasted: clip(b.pasted, 8000),
    resumeName: clip(b.resumeName, 200),
    resumeBase64: typeof b.resumeBase64 === 'string' ? b.resumeBase64 : '',
    share: b.share === true,
  };
  const missing = [];
  /* Name and location are read from the resume (the page asks for a resume
     that carries both); the form fields, when sent, take precedence. */
  if (!form.resumeBase64) missing.push('your resume');
  if (missing.length) return res.status(400).json({ error: 'Please add ' + missing.join(', ') + '.' });
  if (b.confirm !== true) return res.status(400).json({ error: 'Please confirm the resume and profiles are yours.' });
  if (form.resumeBase64.length > Math.ceil((config.maxUploadBytes * 4) / 3) + 16) {
    return res.status(413).json({ error: 'That resume file is too large.' });
  }

  const s = readToken(req);
  const member = await jobs.getMember(s.sub);
  const meta = await jobs.createReport({ memberId: req.memberId, email: member && member.email, form });
  res.status(202).json({ ok: true, report: { id: meta.id, status: meta.status } });
}));

router.post('/api/reports/:id/retry', requireSession, wrap(async (req, res) => {
  const meta = await jobs.retry(req.memberId, req.params.id);
  if (!meta) return res.status(404).json({ error: 'Not found.' });
  res.json({ ok: true });
}));

/* POST as well as DELETE: the Uscreen page calls cross-origin, and the shared
   CORS rules (lib/auth.js) only allow GET and POST. */
const removeReport = wrap(async (req, res) => {
  const ok = await jobs.remove(req.memberId, req.params.id);
  if (!ok) return res.status(404).json({ error: 'Not found.' });
  res.json({ ok: true });
});
router.delete('/api/reports/:id', requireSession, removeReport);
router.post('/api/reports/:id/delete', requireSession, removeReport);

router.get('/api/reports/:id/:doc', requireSession, wrap(async (req, res) => {
  const buf = await jobs.readDoc(req.memberId, req.params.id, req.params.doc);
  if (!buf) return res.status(404).json({ error: 'Not found.' });
  /* Read on the site, not downloaded: no filename, no attachment, and the
     page fetches it with a token, so the URL alone opens nothing. */
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', 'inline');
  res.setHeader('X-Robots-Tag', 'noindex');
  res.send(buf);
}));

router.get('/api/library', requireSession, wrap(async (req, res) => {
  res.json(await jobs.listLibrary(req.memberId));
}));

router.post('/api/sharing', requireSession, wrap(async (req, res) => {
  const member = await jobs.setSharing(req.memberId, req.body?.sharing === true);
  res.json({ ok: true, sharing: member.sharing });
}));

router.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

function boot() {
  if (!config.enabled) {
    console.log('[masterplan] disabled (MP_ENABLED is not true)');
    return;
  }
  if (!ready) {
    console.warn('[masterplan] not started:\n  - ' + config.problems.join('\n  - '));
    return;
  }
  if (config.storage.driver === 'disk' && rootConfig.isProd) {
    console.warn('[masterplan] storage=disk in production: reports are lost on every deploy. Set MP_STORAGE=supabase.');
  }
  console.log('[masterplan] ready  storage=%s  model=%s  email=%s', config.storage.driver, config.anthropic.model, config.email.driver);
  jobs.resumeActive().catch((err) => console.error('[masterplan] could not resume active reports:', err.message));
}

module.exports = { router, boot };
