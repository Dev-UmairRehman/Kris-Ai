'use strict';

/* ---------------------------------------------------------------------------
   The member gate.

   Only a signed-in StrategyTraining subscriber may reach the chat. Everyone
   else is sent to JOIN_URL. Four independent layers, so no single spoofable
   signal is load bearing:

     1. Frame lock       CSP frame-ancestors limits who may iframe /embed, and
                         the browser enforces it. Set on every response.
     2. Origin check     state changing calls must carry an Origin/Referer
                         belonging to the store. Browsers set these and pages
                         cannot forge them cross origin.
     3. Identity proof   the store page hands us the signed-in customer, and we
                         confirm the subscription against the Uscreen API
                         (lib/uscreen.js) before trusting it.
     4. Signed session   the result is sealed into an HttpOnly cookie so the
                         verification runs once per session, not per message.

   The cookie is HMAC-SHA256 signed and carries its own expiry. There is no
   server side session store, so this scales horizontally with no shared state.
   --------------------------------------------------------------------------- */

const crypto = require('crypto');
const config = require('./config');

const COOKIE = config.session.cookieName;

/* ---- tiny cookie helpers (avoids a dependency) -------------------------- */

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const k = part.slice(0, eq).trim();
    if (!out[k]) {
      try {
        out[k] = decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        out[k] = part.slice(eq + 1).trim();
      }
    }
  }
  return out;
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function sign(payloadB64) {
  return crypto
    .createHmac('sha256', config.session.secret)
    .update(payloadB64)
    .digest('base64url');
}

/* ---- session token ------------------------------------------------------ */

/** Seal a verified member into a signed token. */
function mintSession(member) {
  const payload = {
    /* `sub` is already the hashed profile id, so the raw Uscreen id never
       lands in a cookie. */
    sub: member.profileId,
    src: member.verifiedBy, // 'uscreen' | 'frame'
    exp: Math.floor(Date.now() / 1000) + config.session.ttlSeconds,
  };
  const body = b64url(JSON.stringify(payload));
  return body + '.' + sign(body);
}

/** Short-lived token used to hand a verified member from the iframe to the
    standalone page, where the cookie can be set first-party. */
function mintHandoff(profileId) {
  const payload = {
    sub: profileId,
    src: 'handoff',
    exp: Math.floor(Date.now() / 1000) + 120,
  };
  const body = b64url(JSON.stringify(payload));
  return body + '.' + sign(body);
}

/** Pull a bearer token from the Authorization header.
    This is the primary transport: the iframe runs cross-site, and Safari's ITP
    blocks third-party cookies outright while Chrome is restricting them, so a
    SameSite=None cookie cannot be relied on inside the embed. The token lives
    only in the page's JavaScript memory - never in storage - so it also cannot
    be exfiltrated from localStorage later. */
function readBearer(req) {
  const header = req.headers.authorization;
  if (!header || typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

/** Verify and decode a token. Returns the payload, or null. */
function readSession(token) {
  if (typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;

  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = sign(body);

  /* Constant time compare. Lengths must match first or timingSafeEqual throws. */
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (!payload || typeof payload.sub !== 'string') return null;
  if (!Number.isFinite(payload.exp) || payload.exp < Math.floor(Date.now() / 1000)) return null;

  return payload;
}

function setSessionCookie(res, token) {
  /* SameSite=None is required: the app runs cross site inside the Uscreen
     iframe, and a Lax cookie is not sent in that context. None demands
     Secure, which is fine since DigitalOcean terminates TLS. */
  res.append(
    'Set-Cookie',
    [
      COOKIE + '=' + encodeURIComponent(token),
      'Path=/',
      'HttpOnly',
      'Secure',
      'SameSite=None',
      'Max-Age=' + config.session.ttlSeconds,
    ].join('; ')
  );
}

function clearSessionCookie(res) {
  res.append('Set-Cookie', COOKIE + '=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0');
}

/* ---- profile id --------------------------------------------------------- */

/** Stable, non reversible BuddyPro profile id for a Uscreen customer.
    Keeps each member's chat history isolated without handing BuddyPro the
    member's identity. Must satisfy BuddyPro's `user` rules: alphanumeric,
    hyphen, underscore, dot; at most 128 chars; not purely numeric. */
function profileIdFor(uscreenIdOrEmail) {
  const digest = crypto
    .createHmac('sha256', config.memberIdSalt)
    .update(String(uscreenIdOrEmail).trim().toLowerCase())
    .digest('hex');
  return 'st_' + digest.slice(0, 32);
}

/* ---- origin checks ------------------------------------------------------ */

function originOf(url) {
  try {
    return new URL(url).origin.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function selfOrigin(req) {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https')
    .split(',')[0]
    .trim();
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return host ? proto + '://' + host : null;
}

function allowedOrigins() {
  const set = new Set(config.allowedFrameOrigins);
  set.add(config.store.origin);
  return set;
}

/** True when the request came from a page we allow to host this app.
    Same origin requests (our own standalone page) are allowed too. */
function isTrustedRequestOrigin(req) {
  const allow = allowedOrigins();

  const origin = req.headers.origin ? req.headers.origin.replace(/\/+$/, '') : null;
  if (origin) {
    return allow.has(origin) || origin === selfOrigin(req);
  }

  /* No Origin header, which happens on some same origin GETs. Use Referer. */
  const ref = req.headers.referer ? originOf(req.headers.referer) : null;
  if (ref) return allow.has(ref) || ref === selfOrigin(req);

  /* Neither header present. Only acceptable outside production. */
  return !config.isProd;
}

/** True when this response is being rendered inside an allowed iframe.
    Sec-Fetch-* are browser set forbidden headers and cannot be set by script. */
function isFramedByStore(req) {
  const dest = req.headers['sec-fetch-dest'];
  const site = req.headers['sec-fetch-site'];

  if (dest === 'iframe' && site === 'cross-site') {
    const ref = req.headers.referer ? originOf(req.headers.referer) : null;
    return !!ref && allowedOrigins().has(ref);
  }
  return false;
}

/* ---- response headers --------------------------------------------------- */

function securityHeaders(req, res) {
  const frameAncestors = ["'self'"].concat(Array.from(allowedOrigins())).join(' ');

  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "base-uri 'none'",
      "object-src 'none'",
      "form-action 'none'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      'font-src https://fonts.gstatic.com data:',
      "img-src 'self' data: blob:",
      "media-src 'self' data: blob:",
      /* The page only ever talks to its own /api. */
      "connect-src 'self'",
      'frame-ancestors ' + frameAncestors,
    ].join('; ')
  );

  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Permissions-Policy', 'microphone=(self), camera=(), geolocation=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  if (config.isProd) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}

/** CORS for the iframe's own fetches. Credentials are required for the session
    cookie, so the origin must be echoed exactly and never '*'. */
function applyCors(req, res) {
  const origin = req.headers.origin ? req.headers.origin.replace(/\/+$/, '') : null;
  res.setHeader('Vary', 'Origin');
  if (!origin) return;
  if (!allowedOrigins().has(origin) && origin !== selfOrigin(req)) return;

  res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
}

module.exports = {
  COOKIE,
  parseCookies,
  mintSession,
  mintHandoff,
  readBearer,
  readSession,
  setSessionCookie,
  clearSessionCookie,
  profileIdFor,
  isTrustedRequestOrigin,
  isFramedByStore,
  securityHeaders,
  applyCors,
  selfOrigin,
  allowedOrigins,
};
