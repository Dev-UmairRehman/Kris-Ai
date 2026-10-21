'use strict';

/* ---------------------------------------------------------------------------
   The member's social feeds, read in depth - public data only, no login to
   their accounts. The client's feedback (2026-10-21): the MasterPlan drew
   mostly on the resume because a profile link gave it only a page title and
   a description. Now, per link:

     LinkedIn   the profile (headline, about, every position with its
                description, education, skills, certifications,
                recommendations, featured) and the latest posts with their
                reactions - Apify, harvestapi readers
     YouTube    the channel's latest videos with views and dates (the agency's
                reader, no key)
     Instagram  the profile (bio, followers, category, link) and the latest
                Reels with whole captions, views, likes, comments - Apify
     TikTok     the bio, followers, total likes and the latest videos with
                whole captions and numbers - Apify
     anything   the page title and description, as before

   Apify uses the agency's token (YMA_APIFY_TOKEN). About 11 cents a
   MasterPlan with all four. Without the token, or when a reader fails, the
   link falls back to its page title and description, and the document says
   how much the feed showed.
   --------------------------------------------------------------------------- */

const intake = require('./intake');

/* Loaded on use: the agency's readers (and its config) are optional here. */
const social = () => require('../agency/social');
const channels = () => require('../agency/channels');

const LINKEDIN_POSTS = 15;
const VIDEOS = 12;

function platformOf(url) {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\.|^m\./, '');
  } catch {
    return 'other';
  }
  if (/(^|\.)linkedin\.com$/.test(host)) return 'linkedin';
  if (/(^|\.)(youtube\.com|youtu\.be)$/.test(host)) return 'youtube';
  if (/(^|\.)instagram\.com$/.test(host)) return 'instagram';
  if (/(^|\.)tiktok\.com$/.test(host)) return 'tiktok';
  return 'other';
}

/* LinkedIn sections come back as a list or as { items: [...] }. */
const arr = (x) => (Array.isArray(x) ? x : x && Array.isArray(x.items) ? x.items : x && Array.isArray(x.data) ? x.data : []);
/* Newest first: pinned posts otherwise come first, whatever their age. */
const newest = (list) => list.slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
const clip = (s, n) => String(s || '').replace(/\s+\n/g, '\n').trim().slice(0, n);
const date = (d) => (d ? String(d).slice(0, 10) : null);
/* A time limit that is cleared as soon as the reader answers. */
function withTimeout(p, ms, what) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(what + ' took too long')), ms);
  });
  return Promise.race([p, limit]).finally(() => clearTimeout(timer));
}

async function readLinkedIn(url) {
  const s = social();
  const [prof, posts] = await Promise.all([
    s.runActor('harvestapi~linkedin-profile-scraper', { profileScraperMode: 'Profile details no email ($4 per 1k)', urls: [url] }, 150, 1),
    s.runActor('harvestapi~linkedin-profile-posts', { targetUrls: [url], maxPosts: LINKEDIN_POSTS }, 150, LINKEDIN_POSTS).catch(() => ({ items: [], costUsd: 0 })),
  ]);
  const p = prof.items.find((i) => i && (i.headline || i.experience)) || null;
  if (!p) throw new Error('the profile came back empty (private or wrong link)');
  const when = (x) => [x && x.startDate && x.startDate.text, x && x.endDate && x.endDate.text].filter(Boolean).join(' - ');
  return {
    platform: 'LinkedIn',
    url,
    name: [p.firstName, p.lastName].filter(Boolean).join(' '),
    headline: clip(p.headline, 300),
    about: clip(p.about, 2500),
    location: p.location && (p.location.linkedinText || (p.location.parsed && p.location.parsed.text)),
    followers: p.followerCount || null,
    connections: p.connectionsCount || null,
    open_to_work: !!p.openToWork,
    creator: !!p.creator,
    experience: arr(p.experience).slice(0, 15).map((x) => ({
      title: x.position,
      organization: x.companyName,
      when: when(x) || x.duration || '',
      place: x.location || '',
      description: clip(x.description, 600),
    })),
    education: arr(p.education).slice(0, 6).map((x) => ({ school: x.schoolName || x.title, degree: [x.degree, x.fieldOfStudy].filter(Boolean).join(', '), when: when(x) })),
    skills: arr(p.skills).slice(0, 25).map((x) => x.name || x).filter((x) => typeof x === 'string'),
    certifications: arr(p.certifications).slice(0, 10).map((x) => x.title || x.name).filter(Boolean),
    languages: arr(p.languages).slice(0, 8).map((x) => x.name || x).filter((x) => typeof x === 'string'),
    volunteering: arr(p.volunteering).slice(0, 5).map((x) => [x.role || x.title, x.organizationName || x.companyName].filter(Boolean).join(', ')),
    recommendations: arr(p.receivedRecommendations).slice(0, 3).map((x) => clip(x.description || x.text, 400)).filter(Boolean),
    featured: arr(p.featured).slice(0, 5).map((x) => clip(x.title || x.description, 160)).filter(Boolean),
    posts: newest(posts.items
      .filter((x) => x && x.content)
      .slice(0, LINKEDIN_POSTS)
      .map((x) => ({
        date: date(x.postedAt && x.postedAt.date),
        text: clip(x.content, 900),
        reactions: (x.engagement && x.engagement.likes) || 0,
        comments: (x.engagement && x.engagement.comments) || 0,
        shares: (x.engagement && x.engagement.shares) || 0,
        repost: x.type === 'repost' || !!(x.header && /repost/i.test(JSON.stringify(x.header))),
      }))),
    costUsd: (prof.costUsd || 0) + (posts.costUsd || 0),
  };
}

async function readInstagram(url) {
  const s = social();
  const handle = s.parseHandle('instagram', url);
  if (!handle) throw new Error('no Instagram handle in the link');
  const [prof, reels] = await Promise.all([
    s.runActor('apify~instagram-profile-scraper', { usernames: [handle] }, 150, 1).catch(() => ({ items: [], costUsd: 0 })),
    s.read('instagram', handle, VIDEOS, { full: true }).catch(() => null),
  ]);
  const p = prof.items.find((i) => i && i.username) || {};
  if (!p.username && !reels) throw new Error('the account could not be read (private or wrong handle)');
  return {
    platform: 'Instagram',
    url,
    handle,
    name: p.fullName || (reels && reels.title) || handle,
    bio: clip(p.biography, 600),
    category: p.businessCategoryName && p.businessCategoryName !== 'None' ? p.businessCategoryName : '',
    link: p.externalUrl || '',
    followers: p.followersCount || null,
    following: p.followsCount || null,
    posts_total: p.postsCount || null,
    verified: !!p.verified,
    reels: newest(((reels && reels.videos) || []).map((v) => ({ date: date(v.published), text: v.text || v.title, views: v.views, likes: v.likes, comments: v.comments }))),
    costUsd: (prof.costUsd || 0) + ((reels && reels.costUsd) || 0),
  };
}

async function readTikTok(url) {
  const s = social();
  const handle = s.parseHandle('tiktok', url);
  if (!handle) throw new Error('no TikTok handle in the link');
  const r = await s.read('tiktok', handle, VIDEOS, { full: true });
  return {
    platform: 'TikTok',
    url,
    handle,
    name: r.title,
    bio: r.bio || '',
    followers: r.followers,
    following: r.following,
    total_likes: r.totalLikes,
    videos_total: r.videoCount,
    verified: r.verified,
    videos: newest(r.videos.map((v) => ({ date: date(v.published), text: v.text || v.title, views: v.views, likes: v.likes, comments: v.comments, shares: v.shares }))),
    costUsd: r.costUsd || 0,
  };
}

async function readYouTube(url) {
  const [ch, page] = await Promise.all([channels().channel(url), intake.readProfilePage(url)]);
  return {
    platform: 'YouTube',
    url,
    name: ch.title,
    about: clip(page.description, 1000),
    videos: (ch.videos || []).slice(0, 30).map((v) => ({ date: date(v.published), title: v.title, views: v.views, short: v.short === true })),
    costUsd: 0,
  };
}

const READERS = { linkedin: readLinkedIn, instagram: readInstagram, tiktok: readTikTok, youtube: readYouTube };

/**
 * Every link read as deeply as possible. Returns
 *   pages  the page title/description per link (as before, for the record)
 *   feeds  the in-depth reads, one per link that could be read
 *   notes  per link, what was read or why not
 * Never throws.
 */
async function gather(links, log) {
  const apify = (() => {
    try {
      return social().available();
    } catch {
      return false;
    }
  })();
  const results = await Promise.all(
    (links || []).map(async (url) => {
      const kind = platformOf(url);
      const page = await intake.readProfilePage(url);
      const reader = READERS[kind];
      if (!reader || (kind !== 'youtube' && !apify)) return { url, page, feed: null, note: kind === 'other' ? 'page title and description' : 'page title and description only (in-depth reading is not switched on)' };
      try {
        const feed = await withTimeout(reader(url), 240000, kind);
        return { url, page, feed, note: 'read in depth' };
      } catch (err) {
        if (log) log('feed ' + kind + ' not read in depth: ' + err.message);
        return { url, page, feed: null, note: 'page title and description only (' + err.message + ')' };
      }
    })
  );
  const feeds = results.filter((r) => r.feed).map((r) => r.feed);
  const cost = feeds.reduce((n, f) => n + (f.costUsd || 0), 0);
  feeds.forEach((f) => delete f.costUsd);
  return { pages: results.map((r) => ({ ...r.page, depth: r.note })), feeds, costUsd: cost };
}

/** The feeds as text for the model, at most `max` characters. */
function asText(feeds, max) {
  if (!feeds || !feeds.length) return '';
  let out = '';
  for (const f of feeds) {
    const block = '### ' + f.platform + ' (' + f.url + ')\n' + JSON.stringify(f, null, 0) + '\n\n';
    out += block;
  }
  if (out.length <= max) return out;
  /* Too long: keep every account, shorten the posts. */
  const slim = feeds.map((f) => {
    const g = { ...f };
    for (const k of ['posts', 'reels', 'videos']) {
      if (Array.isArray(g[k])) g[k] = g[k].slice(0, 8).map((p) => ({ ...p, text: p.text ? clip(p.text, 300) : p.text }));
    }
    if (Array.isArray(g.experience)) g.experience = g.experience.map((x) => ({ ...x, description: clip(x.description, 250) }));
    return g;
  });
  return slim.map((f) => '### ' + f.platform + ' (' + f.url + ')\n' + JSON.stringify(f, null, 0)).join('\n\n').slice(0, max);
}

module.exports = { gather, asText, platformOf };
