'use strict';

/* ---------------------------------------------------------------------------
   Uscreen membership verification.

   The store page tells us who the signed-in visitor is. That claim arrives
   from the browser, so it is untrusted until confirmed here against Uscreen's
   own API using the publisher key - which lives only on the server.

   WHY THIS IS DEFENSIVE ABOUT ENDPOINTS
   Uscreen has shipped several shapes of publisher API and the exact base path,
   auth header and subscription field differ per store and plan. Rather than
   hard coding one guess, this probes a short list of known shapes once, then
   remembers the combination that worked. Set USCREEN_API_BASE to the base you
   were given and the probing collapses to a single call.

   Every verified answer is cached for CACHE_TTL_MS so a member's whole session
   costs one upstream call, not one per message.
   --------------------------------------------------------------------------- */

const config = require('./config');

const CACHE_TTL_MS = 10 * 60 * 1000;
const NEGATIVE_TTL_MS = 60 * 1000;
const cache = new Map(); // key -> { ok, until, detail }

/* Auth styles Uscreen has used. Probed in order; the winner is remembered. */
const AUTH_STYLES = [
  (key) => ({ headers: { Authorization: 'Bearer ' + key } }),
  (key) => ({ headers: { 'X-Api-Key': key } }),
  (key) => ({ headers: { Authorization: key } }),
  (key) => ({ query: { api_key: key } }),
];

/* Lookup shapes, in order of how specific they are. */
const LOOKUPS = [
  { path: '/customers', query: (email) => ({ email }) },
  { path: '/customers', query: (email) => ({ 'q[email]': email }) },
  { path: '/customers/search', query: (email) => ({ email }) },
  { path: '/users', query: (email) => ({ email }) },
];

let learned = null; // { authIndex, lookupIndex }

function buildUrl(base, path, query) {
  const url = new URL(base + path);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  return url;
}

async function callUscreen(path, query, authIndex) {
  const style = AUTH_STYLES[authIndex](config.uscreen.apiKey);
  const url = buildUrl(config.uscreen.apiBase, path, {
    ...query,
    ...(style.query || {}),
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.uscreen.timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json', ...(style.headers || {}) },
      signal: controller.signal,
    });

    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      /* HTML error page or a login redirect. Treat as a miss. */
      return { status: res.status, body: null, html: true };
    }
    return { status: res.status, body, html: false };
  } finally {
    clearTimeout(timer);
  }
}

/** Pull the first customer-looking object out of whatever envelope came back. */
function firstCustomer(body) {
  if (!body) return null;
  if (Array.isArray(body)) return body[0] || null;
  for (const key of ['customer', 'user', 'data', 'customers', 'users', 'results']) {
    const v = body[key];
    if (Array.isArray(v)) return v[0] || null;
    if (v && typeof v === 'object') return v;
  }
  /* Already the object itself. */
  return typeof body === 'object' && (body.id || body.email) ? body : null;
}

/** Decide whether a customer record represents an active, paying member.
    Uscreen exposes this under several names depending on store and plan. */
function hasActiveAccess(customer) {
  if (!customer || typeof customer !== 'object') return false;

  /* Direct booleans. */
  for (const key of ['subscribed', 'is_subscribed', 'active', 'has_access', 'access']) {
    if (customer[key] === true) return true;
  }

  /* Status strings. */
  const okStatus = new Set(['active', 'trialing', 'trial', 'paid', 'comped', 'complimentary']);
  for (const key of ['status', 'subscription_status', 'state', 'access_status']) {
    const v = customer[key];
    if (typeof v === 'string' && okStatus.has(v.toLowerCase())) return true;
  }

  /* Nested subscription collections. */
  for (const key of ['subscriptions', 'memberships', 'plans', 'accesses']) {
    const arr = customer[key];
    if (!Array.isArray(arr)) continue;
    for (const sub of arr) {
      if (!sub || typeof sub !== 'object') continue;
      if (sub.active === true) return true;
      const s = sub.status || sub.state;
      if (typeof s === 'string' && okStatus.has(s.toLowerCase())) return true;
      /* A future expiry with no cancellation also counts. */
      const ends = sub.expires_at || sub.current_period_end || sub.ends_at;
      if (ends && !sub.cancelled_at && new Date(ends).getTime() > Date.now()) return true;
    }
  }

  /* Explicit negatives take precedence over an absent signal. */
  for (const key of ['subscribed', 'is_subscribed', 'active', 'has_access']) {
    if (customer[key] === false) return false;
  }

  return false;
}

/** Verify one email against Uscreen. Returns { ok, reason, customerId }. */
async function verifySubscriber(email) {
  if (!config.uscreen.apiBase || !config.uscreen.apiKey) {
    return { ok: false, reason: 'uscreen_not_configured' };
  }

  const key = 'email:' + String(email).trim().toLowerCase();
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.detail;

  const authOrder = learned
    ? [learned.authIndex, ...AUTH_STYLES.keys()].filter((v, i, a) => a.indexOf(v) === i)
    : [...AUTH_STYLES.keys()];
  const lookupOrder = learned
    ? [learned.lookupIndex, ...LOOKUPS.keys()].filter((v, i, a) => a.indexOf(v) === i)
    : [...LOOKUPS.keys()];

  let sawAuthFailure = false;
  let lastError = null;

  for (const ai of authOrder) {
    for (const li of lookupOrder) {
      const lookup = LOOKUPS[li];
      let res;
      try {
        res = await callUscreen(lookup.path, lookup.query(email), ai);
      } catch (err) {
        lastError = err;
        continue;
      }

      if (res.status === 401 || res.status === 403) {
        sawAuthFailure = true;
        continue; // wrong auth style, or the key lacks scope
      }
      if (res.status === 404 || res.html || !res.body) continue; // wrong path

      /* This combination talks to us. Remember it. */
      if (!learned) {
        learned = { authIndex: ai, lookupIndex: li };
        console.log(
          '[uscreen] using auth style #%d with %s',
          ai,
          lookup.path
        );
      }

      const customer = firstCustomer(res.body);
      if (!customer) {
        const detail = { ok: false, reason: 'customer_not_found' };
        cache.set(key, { until: Date.now() + NEGATIVE_TTL_MS, detail });
        return detail;
      }

      /* Guard against a search endpoint that ignores the filter and returns
         an unrelated first record. */
      const returned = String(customer.email || '').trim().toLowerCase();
      if (returned && returned !== String(email).trim().toLowerCase()) {
        const detail = { ok: false, reason: 'customer_mismatch' };
        cache.set(key, { until: Date.now() + NEGATIVE_TTL_MS, detail });
        return detail;
      }

      const active = hasActiveAccess(customer);
      const detail = active
        ? { ok: true, reason: 'active', customerId: customer.id || customer.uuid || email }
        : { ok: false, reason: 'not_subscribed' };

      cache.set(key, {
        until: Date.now() + (active ? CACHE_TTL_MS : NEGATIVE_TTL_MS),
        detail,
      });
      return detail;
    }
  }

  if (lastError) console.warn('[uscreen] unreachable:', lastError.message);
  return {
    ok: false,
    reason: sawAuthFailure ? 'uscreen_auth_rejected' : 'uscreen_no_matching_endpoint',
  };
}

/** Drop cached answers. Useful after a plan change or from an admin hook. */
function invalidate(email) {
  if (email) cache.delete('email:' + String(email).trim().toLowerCase());
  else cache.clear();
}

module.exports = { verifySubscriber, invalidate, hasActiveAccess, firstCustomer };
