'use strict';

/* ---------------------------------------------------------------------------
   Two sliding window limiters.

     global   protects the BuddyPro key, which allows 30 requests per minute
              across the whole instance. Exceeding it returns 429 for every
              member at once, so we deliberately sit under the ceiling.

     session  stops one member monopolising that shared budget.

   In memory, so the numbers are per process. Running more than one instance on
   DigitalOcean multiplies the effective global rate - either keep it at one
   instance, or divide RATE_GLOBAL_PER_MIN by the instance count. This is
   called out in the README.
   --------------------------------------------------------------------------- */

const config = require('./config');

const WINDOW_MS = 60000;

function createWindow(limit) {
  /** key -> number[] of hit timestamps */
  const hits = new Map();

  function prune(list, now) {
    /* Timestamps are appended in order, so drop from the front. */
    let i = 0;
    while (i < list.length && now - list[i] >= WINDOW_MS) i++;
    return i ? list.slice(i) : list;
  }

  return {
    /** @returns {{allowed:boolean, retryAfter:number, remaining:number}} */
    take(key) {
      const now = Date.now();
      const list = prune(hits.get(key) || [], now);

      if (list.length >= limit) {
        hits.set(key, list);
        const retryAfter = Math.max(1, Math.ceil((WINDOW_MS - (now - list[0])) / 1000));
        return { allowed: false, retryAfter, remaining: 0 };
      }

      list.push(now);
      hits.set(key, list);
      return { allowed: true, retryAfter: 0, remaining: limit - list.length };
    },

    /** Give a slot back when the work never happened. */
    refund(key) {
      const list = hits.get(key);
      if (list && list.length) list.pop();
    },

    sweep() {
      const now = Date.now();
      for (const [key, list] of hits) {
        const kept = prune(list, now);
        if (kept.length === 0) hits.delete(key);
        else hits.set(key, kept);
      }
    },

    get size() {
      return hits.size;
    },
  };
}

const globalWindow = createWindow(config.rate.globalPerMin);
const sessionWindow = createWindow(config.rate.sessionPerMin);

/* Keep the maps from growing without bound on a long lived process. */
const sweeper = setInterval(() => {
  globalWindow.sweep();
  sessionWindow.sweep();
}, WINDOW_MS);
sweeper.unref();

/**
 * Claim one upstream slot for a member.
 * @param {string} sessionKey stable per member session
 */
function claim(sessionKey) {
  const perSession = sessionWindow.take(sessionKey);
  if (!perSession.allowed) {
    return {
      allowed: false,
      scope: 'session',
      retryAfter: perSession.retryAfter,
      message:
        'You have sent a lot of questions in the last minute. Give Kris ' +
        perSession.retryAfter +
        ' seconds to catch up.',
    };
  }

  const perGlobal = globalWindow.take('global');
  if (!perGlobal.allowed) {
    /* The member did nothing wrong, so do not spend their allowance. */
    sessionWindow.refund(sessionKey);
    return {
      allowed: false,
      scope: 'global',
      retryAfter: perGlobal.retryAfter,
      message: 'Kris is answering a lot of questions right now. Try again in a moment.',
    };
  }

  return { allowed: true, remaining: perSession.remaining };
}

/** Hand both slots back, for when the request failed before reaching BuddyPro. */
function release(sessionKey) {
  sessionWindow.refund(sessionKey);
  globalWindow.refund('global');
}

module.exports = { claim, release };
