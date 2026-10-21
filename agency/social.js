'use strict';

/* ---------------------------------------------------------------------------
   Instagram and TikTok numbers from a member's @handle - public data only, no
   login to their account and no app review. Read through Apify (one account,
   one token: YMA_APIFY_TOKEN) with its two most-used readers:

     Instagram  apify~instagram-reel-scraper   plays, likes, comments, date per Reel
     TikTok     clockworks~tiktok-scraper      plays, likes, comments, shares, date

   Both charge per video read (Apify free plan: Instagram $0.0026, TikTok
   $0.0037, less on paid plans), so a member's account is read once in full
   (YMA_SOCIAL_VIDEOS_PER_READ, 12) and then only its newest videos
   (YMA_SOCIAL_REFRESH_VIDEOS, 6) at most once a day. A read takes 15-40
   seconds, so it runs as a background job (index.js).
   --------------------------------------------------------------------------- */

const config = require('./config');

const ACTORS = {
  instagram: () => config.social.instagramActor,
  tiktok: () => config.social.tiktokActor,
};

const userError = (msg, status = 400) => Object.assign(new Error(msg), { userFacing: true, status });

function available() {
  return !!config.social.apifyToken;
}

/** @handle from what the member typed: a handle or a profile link. */
function parseHandle(platform, input) {
  const s = String(input || '').trim();
  const fromUrl =
    platform === 'instagram'
      ? s.match(/instagram\.com\/([A-Za-z0-9._]{1,30})\/?/i)
      : s.match(/tiktok\.com\/@([A-Za-z0-9._]{2,24})/i);
  const h = fromUrl ? fromUrl[1] : s.replace(/^@/, '');
  if (platform === 'instagram' && /^(p|reel|reels|stories|explore)$/i.test(h)) return null;
  const ok = platform === 'instagram' ? /^[A-Za-z0-9._]{1,30}$/.test(h) : /^[A-Za-z0-9._]{2,24}$/.test(h);
  return ok ? h.toLowerCase() : null;
}

/** The video a post link points at, to match it with what was read. */
function postId(platform, url) {
  const s = String(url || '');
  if (platform === 'instagram') {
    const m = s.match(/instagram\.com\/(?:[A-Za-z0-9._]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i);
    return m ? m[1] : null;
  }
  if (platform === 'tiktok') {
    const m = s.match(/tiktok\.com\/@[^/]+\/(?:video|photo)\/(\d+)/i);
    return m ? m[1] : null;
  }
  return null;
}

/** As postId, also for TikTok's short share links (vm.tiktok.com/...), which redirect to the video. */
async function resolvePostId(platform, url) {
  const id = postId(platform, url);
  if (id || platform !== 'tiktok' || !/^https:\/\/(vm|vt)\.tiktok\.com\/\w+/i.test(String(url))) return id;
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(8000) });
    return postId(platform, res.headers.get('location') || '');
  } catch {
    return null;
  }
}

/* What a run cost: the readers charge per video (plus a start fee). The run's
   own total is settled only later, so it is worked out from the counts. */
function runCost(run) {
  const events = (((run.pricingInfo || {}).pricingPerEvent || {}).actorChargeEvents) || {};
  let usd = 0;
  for (const [name, count] of Object.entries(run.chargedEventCounts || {})) usd += (Number(count) || 0) * (Number((events[name] || {}).eventPriceUsd) || 0);
  return Math.max(usd, Number(run.usageTotalUsd) || 0);
}

/** Runs a reader and returns its items and what it cost. maxItems also caps the charge. */
async function runActor(actor, input, timeoutSec, maxItems) {
  const base = 'https://api.apify.com/v2';
  const token = '?token=' + encodeURIComponent(config.social.apifyToken);
  /* Some readers refuse a cap under $0.50; maxItems is what keeps the charge down. */
  const caps = maxItems ? '&maxItems=' + maxItems + '&maxTotalChargeUsd=' + Math.max(0.5, maxItems * 0.005 + 0.01).toFixed(3) : '';
  const started = await fetch(base + '/acts/' + actor + '/runs' + token + '&waitForFinish=60' + caps, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(90000),
  });
  const startBody = await started.json().catch(() => ({}));
  if (!started.ok) {
    const type = String((startBody.error || {}).type || '');
    /* The Apify account's monthly credit is used up, or its token is wrong. */
    if (started.status === 402 || started.status === 401 || started.status === 403 || /usage|limit|credit|auth|token/i.test(type)) {
      console.error('[agency] Apify refused the read (%s %s): check the Apify account and YMA_APIFY_TOKEN', started.status, type);
      throw userError('Reading Instagram and TikTok is paused for now. Please try again later, or type your views.', 503);
    }
    throw new Error('Apify answered ' + started.status + ': ' + JSON.stringify(startBody.error || startBody).slice(0, 200));
  }
  let run = startBody.data;
  const deadline = Date.now() + timeoutSec * 1000;
  while (!['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'].includes(run.status)) {
    if (Date.now() > deadline) {
      await fetch(base + '/actor-runs/' + run.id + '/abort' + token, { method: 'POST' }).catch(() => {});
      throw new Error('the reader took too long');
    }
    await new Promise((r) => setTimeout(r, 4000));
    run = (await (await fetch(base + '/actor-runs/' + run.id + token, { signal: AbortSignal.timeout(30000) })).json()).data;
  }
  if (run.status !== 'SUCCEEDED') throw new Error('the reader ' + run.status.toLowerCase());
  const items = await (await fetch(base + '/datasets/' + run.defaultDatasetId + '/items' + token + '&clean=true', { signal: AbortSignal.timeout(30000) })).json();
  return { items: Array.isArray(items) ? items : [], costUsd: runCost(run) };
}

const firstLine = (t) => String(t || '').split('\n')[0].trim().slice(0, 140);

/** The account's latest `limit` videos with their numbers. */
/** opts.full: also each post's whole caption and (TikTok) the bio, for MasterPlan. */
async function read(platform, handle, limit, opts = {}) {
  const full = (t) => (opts.full ? { text: String(t || '').trim().slice(0, 700) } : {});
  if (!available()) throw userError('Reading Instagram and TikTok is not switched on yet.', 503);
  limit = limit || config.social.videosPerRead;
  if (platform === 'instagram') {
    const { items, costUsd } = await runActor(ACTORS.instagram(), { username: [handle], resultsLimit: limit }, 150, limit);
    const reels = items.filter((i) => i && (i.shortCode || i.id) && !i.error);
    if (!reels.length) throw userError('We could not read @' + handle + ' on Instagram. Check the handle, and that the account is public.', 404);
    return {
      handle,
      /* A collab Reel on their profile can belong to the other account. */
      title: (reels.find((i) => String(i.ownerUsername || '').toLowerCase() === handle) || {}).ownerFullName || handle,
      followers: null,
      costUsd,
      videos: reels.slice(0, limit).map((i) => ({
        id: i.shortCode || String(i.id),
        url: i.url || 'https://www.instagram.com/reel/' + i.shortCode + '/',
        title: firstLine(i.caption) || 'Reel',
        views: Number(i.videoPlayCount || i.videoViewCount) || 0,
        likes: Number(i.likesCount) || 0,
        comments: Number(i.commentsCount) || 0,
        published: i.timestamp || null,
        short: true,
        ...full(i.caption),
      })),
    };
  }
  if (platform === 'tiktok') {
    const { items, costUsd } = await runActor(
      ACTORS.tiktok(),
      {
        profiles: [handle],
        resultsPerPage: limit,
        shouldDownloadVideos: false,
        shouldDownloadCovers: false,
        shouldDownloadSubtitles: false,
        shouldDownloadSlideshowImages: false,
        shouldDownloadAvatars: false,
      },
      150,
      limit
    );
    const vids = items.filter((i) => i && i.id && !i.error);
    if (!vids.length) throw userError('We could not read @' + handle + ' on TikTok. Check the handle, and that the account is public.', 404);
    const author = (vids[0] && vids[0].authorMeta) || {};
    return {
      handle,
      title: author.nickName || author.name || handle,
      followers: Number(author.fans) || null,
      ...(opts.full ? { bio: String(author.signature || '').slice(0, 500), following: Number(author.following) || null, totalLikes: Number(author.heart) || null, videoCount: Number(author.video) || null, verified: !!author.verified } : {}),
      costUsd,
      videos: vids.slice(0, limit).map((i) => ({
        id: String(i.id),
        url: i.webVideoUrl || 'https://www.tiktok.com/@' + handle + '/video/' + i.id,
        title: firstLine(i.text) || 'TikTok video',
        views: Number(i.playCount) || 0,
        likes: Number(i.diggCount) || 0,
        comments: Number(i.commentCount) || 0,
        shares: Number(i.shareCount) || 0,
        published: i.createTimeISO || null,
        short: true,
        ...full(i.text),
      })),
    };
  }
  throw userError('Unknown platform.');
}

module.exports = { available, parseHandle, postId, resolvePostId, read, runActor };
