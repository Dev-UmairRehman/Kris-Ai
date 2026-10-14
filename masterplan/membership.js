'use strict';

/* ---------------------------------------------------------------------------
   Does this email have a StrategyTraining plan?

   Asked of Uscreen's Publisher API (https://www.uscreen.io/api/publisher.yml),
   with MasterPlan's own key (MP_USCREEN_API_KEY) so the Kris AI widget on the
   same server keeps its own settings:

     GET /customers/{email}                 404 no customer | 200 with "subscriber",
                                            Uscreen's own verdict (paid, assigned by
                                            an admin, or cancelled with time left)
   With MP_PLAN_PRODUCT_IDS (only some plans count, or a one-off product such
   as a lifetime bundle should count too) the plan itself is read instead:
     GET /customers/{email}/subscription   200 a plan | 204 none
     GET /customers/{email}/accesses       plans given another way

   Checked against real customers (2026-10-14): "subscriber" matched the
   subscription on every one. The team's own domains (MP_STAFF_DOMAINS)
   always get in.

   Uscreen allows only so many requests a second: a busy answer (429) is
   waited out once. If Uscreen still cannot answer - busy, down, or the key
   refused - check() says so ({ ok: null }) and the session falls back to the
   store page's own check (/delphi), so nobody is let in or locked out on
   Uscreen's account alone.
   --------------------------------------------------------------------------- */

const config = require('./config');

const OK_TTL_MS = 10 * 60 * 1000; // a member's answer, reused for 10 minutes
const NO_TTL_MS = 60 * 1000; // a "no" is asked again after a minute (they may have just joined)
const cache = new Map();

function settings() {
  return config.membership;
}

function enabled() {
  return !!settings().apiKey;
}

function isStaff(email) {
  const domain = String(email).split('@')[1] || '';
  return settings().staffDomains.some((d) => domain === d || domain.endsWith('.' + d));
}

async function call(path) {
  const s = settings();
  let res;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(s.apiBase + path, {
      headers: { Accept: 'application/json', Authorization: s.apiKey, 'X-Store-Token': s.apiKey },
      signal: AbortSignal.timeout(s.timeoutMs),
    });
    if (res.status !== 429 || attempt) break;
    const wait = Math.min(3000, Math.max(800, Number(res.headers.get('retry-after') || 1.5) * 1000));
    await new Promise((r) => setTimeout(r, wait));
  }
  let body = null;
  if (res.status !== 204) {
    const text = await res.text();
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
  }
  return { status: res.status, body };
}

const now = () => Date.now() / 1000;
const counts = (productId) => {
  const ids = settings().planProductIds;
  return !ids.length || ids.includes(Number(productId));
};

/* A cancelled plan runs to the end of the period paid for. */
const lapsed = (x) => !!x.canceled_at && !(x.perform_action_at && x.perform_action_at > now());

function activeSubscription(sub) {
  if (!sub || lapsed(sub)) return false;
  const paused = sub.pauses_at && sub.pauses_at <= now() && (!sub.resumes_at || sub.resumes_at > now());
  return !paused && counts(sub.product_id);
}

function activeAccess(a) {
  if (!a || lapsed(a)) return false;
  const ids = settings().planProductIds;
  if (ids.length) return ids.includes(Number(a.product_id)) && (!a.perform_action_at || a.product_type !== 'rent' || a.perform_action_at > now());
  return a.product_type === 'recurring';
}

/**
 * { ok: true, why } | { ok: false, reason: 'not_subscribed' | 'customer_not_found' }
 * | { ok: null, why } when Uscreen could not answer (the caller decides).
 */
async function check(email) {
  email = String(email || '').trim().toLowerCase();
  if (!enabled()) return { ok: true, why: 'membership check off' };
  if (isStaff(email)) return { ok: true, why: 'team' };

  const hit = cache.get(email);
  if (hit && hit.until > Date.now()) return hit.verdict;

  let verdict;
  try {
    const id = encodeURIComponent(email);
    if (!settings().planProductIds.length) {
      const c = await call('/customers/' + id);
      if (c.status === 401 || c.status === 403) {
        console.error('[masterplan] Uscreen refused MP_USCREEN_API_KEY (%d): falling back to the store page check', c.status);
        return { ok: null, why: 'key refused' };
      }
      if (c.status === 404) verdict = { ok: false, reason: 'customer_not_found' };
      else if (c.status === 200 && c.body) verdict = c.body.subscriber === true ? { ok: true, why: 'subscriber' } : { ok: false, reason: 'not_subscribed' };
      else throw new Error('Uscreen answered ' + c.status);
      cache.set(email, { verdict, until: Date.now() + (verdict.ok ? OK_TTL_MS : NO_TTL_MS) });
      if (cache.size > 5000) cache.delete(cache.keys().next().value);
      return verdict;
    }
    const sub = await call('/customers/' + id + '/subscription');
    if (sub.status === 401 || sub.status === 403) {
      console.error('[masterplan] Uscreen refused MP_USCREEN_API_KEY (%d): falling back to the store page check', sub.status);
      return { ok: null, why: 'key refused' };
    }
    if (sub.status === 404) verdict = { ok: false, reason: 'customer_not_found' };
    else if (sub.status === 200 && activeSubscription(sub.body)) verdict = { ok: true, why: 'subscription' };
    else if (sub.status === 200 || sub.status === 204) {
      /* No usable subscription: a plan may have been given another way. */
      const acc = await call('/customers/' + id + '/accesses');
      const list = Array.isArray(acc.body) ? acc.body : [];
      verdict = acc.status === 200 && list.some(activeAccess) ? { ok: true, why: 'access' } : { ok: false, reason: 'not_subscribed' };
    } else {
      throw new Error('Uscreen answered ' + sub.status);
    }
  } catch (err) {
    console.warn('[masterplan] Uscreen could not answer (%s); falling back to the store page check', err.message);
    return { ok: null, why: 'uscreen unavailable' };
  }
  cache.set(email, { verdict, until: Date.now() + (verdict.ok ? OK_TTL_MS : NO_TTL_MS) });
  if (cache.size > 5000) cache.delete(cache.keys().next().value);
  return verdict;
}

module.exports = { check, enabled, isStaff, _cache: cache };
