'use strict';

/* ---------------------------------------------------------------------------
   Does this email have a StrategyTraining plan?

   Asked of Uscreen's Publisher API (https://www.uscreen.io/api/publisher.yml),
   with MasterPlan's own key (MP_USCREEN_API_KEY) so the Kris AI widget on the
   same server keeps its own settings:

     GET /customers/{email}/subscription   200 active plan | 204 none | 404 no customer
     GET /customers/{email}/accesses       plans assigned another way (by an
                                           admin, Zapier, a migration...)

   A member gets in with an active, unpaused subscription, or an active
   recurring access. MP_PLAN_PRODUCT_IDS narrows that to given plans (and can
   name one-off products, such as a lifetime bundle, that should count too).
   The team's own domains (MP_STAFF_DOMAINS) always get in.

   When Uscreen cannot be reached, members are let in rather than locked out
   by someone else's outage. A refused key is different: that is our setup
   being wrong, so nobody gets in and the log says why.
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
  const res = await fetch(s.apiBase + path, {
    headers: { Accept: 'application/json', Authorization: s.apiKey, 'X-Store-Token': s.apiKey },
    signal: AbortSignal.timeout(s.timeoutMs),
  });
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

function activeSubscription(sub) {
  if (!sub || sub.canceled_at) return false;
  const paused = sub.pauses_at && sub.pauses_at <= now() && (!sub.resumes_at || sub.resumes_at > now());
  return !paused && counts(sub.product_id);
}

function activeAccess(a) {
  if (!a || a.canceled_at) return false;
  const ids = settings().planProductIds;
  if (ids.length) return ids.includes(Number(a.product_id)) && (!a.perform_action_at || a.product_type !== 'rent' || a.perform_action_at > now());
  return a.product_type === 'recurring';
}

/**
 * { ok: true, why } or { ok: false, reason } where reason is
 * 'not_subscribed' | 'customer_not_found' | 'verification_unavailable'.
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
    const sub = await call('/customers/' + id + '/subscription');
    if (sub.status === 401 || sub.status === 403) {
      console.error('[masterplan] Uscreen refused MP_USCREEN_API_KEY (%d): nobody can be checked, so nobody gets in', sub.status);
      return { ok: false, reason: 'verification_unavailable' };
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
    console.warn('[masterplan] membership check unavailable (%s); letting the member in', err.message);
    return { ok: true, why: 'uscreen unavailable' };
  }
  cache.set(email, { verdict, until: Date.now() + (verdict.ok ? OK_TTL_MS : NO_TTL_MS) });
  if (cache.size > 5000) cache.delete(cache.keys().next().value);
  return verdict;
}

module.exports = { check, enabled, isStaff, _cache: cache };
