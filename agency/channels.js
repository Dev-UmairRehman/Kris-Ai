'use strict';

/* ---------------------------------------------------------------------------
   Reading a member's YouTube channel and video views - public data only, no
   login to their account and no API key needed:

     channel   the @handle / channel page gives the channel ID; the channel's
               public feed gives its latest 15 videos with views and dates
     video     a video's public page gives its views and length
     short?    youtube.com/shorts/<id> answers 200 for a Short, a redirect
               for a normal video

   With YMA_YOUTUBE_API_KEY set (a free YouTube Data API key) the same answers
   come from the official API instead, which also reaches older videos.

   Instagram and TikTok do not allow this without an approved app, so their
   view counts are entered by the member.
   --------------------------------------------------------------------------- */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';
const apiKey = () => process.env.YMA_YOUTUBE_API_KEY || '';

async function get(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en', Cookie: 'CONSENT=YES+1; SOCS=CAI' },
    redirect: opts.redirect || 'follow',
    signal: AbortSignal.timeout(15000),
  });
  return res;
}

const unxml = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

/** A YouTube channel from what the member typed: @handle, a channel URL or an ID. */
function parseChannelInput(input) {
  const s = String(input || '').trim();
  let m = s.match(/(UC[A-Za-z0-9_-]{22})/);
  if (m) return { channelId: m[1] };
  m = s.match(/(?:youtube\.com\/)?@([A-Za-z0-9._-]{3,100})/);
  if (m) return { handle: m[1] };
  m = s.match(/youtube\.com\/(?:c|user)\/([A-Za-z0-9._-]{2,100})/);
  if (m) return { legacy: m[1] };
  if (/^[A-Za-z0-9._-]{3,100}$/.test(s)) return { handle: s };
  return null;
}

/** A video ID from a YouTube link (watch, shorts, youtu.be). */
function videoIdFrom(url) {
  const m = String(url || '').match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

async function resolveChannelId(input) {
  const p = parseChannelInput(input);
  if (!p) throw Object.assign(new Error('That does not look like a YouTube channel. Use your @handle or your channel link.'), { userFacing: true, status: 400 });
  if (p.channelId) return p.channelId;
  if (apiKey() && p.handle) {
    const r = await (await get('https://www.googleapis.com/youtube/v3/channels?part=id&forHandle=@' + encodeURIComponent(p.handle) + '&key=' + apiKey())).json();
    if (r.items && r.items[0]) return r.items[0].id;
  }
  const url = p.handle ? 'https://www.youtube.com/@' + encodeURIComponent(p.handle) : 'https://www.youtube.com/c/' + encodeURIComponent(p.legacy);
  const res = await get(url);
  if (res.status === 404) throw Object.assign(new Error('That YouTube channel was not found.'), { userFacing: true, status: 404 });
  const html = await res.text();
  const m = html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})"/) ||
    html.match(/"externalId":"(UC[A-Za-z0-9_-]{22})"/) ||
    html.match(/"channelId":"(UC[A-Za-z0-9_-]{22})"/);
  if (!m) throw Object.assign(new Error('YouTube did not show that channel just now. Please try again in a minute.'), { userFacing: true, status: 502 });
  return m[1];
}

async function isShort(videoId) {
  try {
    const res = await get('https://www.youtube.com/shorts/' + videoId, { redirect: 'manual' });
    return res.status === 200;
  } catch {
    return null;
  }
}

/** The channel and its latest videos (15 from the public feed, up to 50 with a key). */
async function channel(input) {
  const channelId = await resolveChannelId(input);
  if (apiKey()) {
    const ch = await (await get('https://www.googleapis.com/youtube/v3/channels?part=snippet,contentDetails,statistics&id=' + channelId + '&key=' + apiKey())).json();
    const c = ch.items && ch.items[0];
    if (c) {
      const uploads = c.contentDetails.relatedPlaylists.uploads;
      const pl = await (await get('https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails&maxResults=50&playlistId=' + uploads + '&key=' + apiKey())).json();
      const ids = (pl.items || []).map((i) => i.contentDetails.videoId);
      const vids = ids.length
        ? await (await get('https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails&id=' + ids.join(',') + '&key=' + apiKey())).json()
        : { items: [] };
      const seconds = (d) => {
        const m = String(d || '').match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/) || [];
        return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
      };
      return {
        channelId,
        title: c.snippet.title,
        subscribers: Number(c.statistics.subscriberCount) || null,
        source: 'api',
        videos: (vids.items || []).map((v) => ({
          id: v.id,
          title: v.snippet.title,
          published: v.snippet.publishedAt,
          views: Number(v.statistics.viewCount) || 0,
          short: seconds(v.contentDetails.duration) <= 180,
        })),
      };
    }
  }
  /* Without a key: the channel's own Videos and Shorts pages (what any visitor
     sees), and the public feed as a second source. The feed has exact views
     and dates but YouTube takes it offline for long stretches. */
  const [longs, shorts] = await Promise.all([tabVideos(channelId, 'videos'), tabVideos(channelId, 'shorts')]);
  let videos = [...longs.videos.map((v) => ({ ...v, short: false })), ...shorts.videos.map((v) => ({ ...v, short: true }))];
  let title = longs.title || shorts.title;
  let source = 'pages';
  if (!videos.length) {
    const res = await get('https://www.youtube.com/feeds/videos.xml?channel_id=' + channelId);
    if (!res.ok) {
      if (longs.ok || shorts.ok) return { channelId, title, subscribers: null, source, videos: [] }; // a channel with no videos yet
      throw Object.assign(new Error('YouTube did not show that channel\'s videos just now. Please try again in a minute.'), { userFacing: true, status: 502 });
    }
    const xml = await res.text();
    title = title || unxml((xml.match(/<title>([^<]*)<\/title>/) || [])[1] || '');
    videos = xml
      .split('<entry>')
      .slice(1)
      .map((e) => ({
        id: (e.match(/<yt:videoId>([^<]+)/) || [])[1],
        title: unxml((e.match(/<title>([^<]*)<\/title>/) || [])[1] || ''),
        published: (e.match(/<published>([^<]+)/) || [])[1] || null,
        views: Number((e.match(/<media:statistics views="(\d+)"/) || [])[1]) || 0,
        short: null,
      }))
      .filter((v) => v.id);
    source = 'feed';
  }
  /* Newest first; Shorts carry no date on their page, so they keep their order. */
  videos.sort((a, b) => (b.published ? Date.parse(b.published) : 0) - (a.published ? Date.parse(a.published) : 0));
  return { channelId, title, subscribers: null, source, videos: videos.slice(0, 50) };
}

/* "7 million views" / "1.2K views" / "7,071,874 views" -> a number. */
function parseViews(s) {
  const m = String(s || '').replace(/,/g, '').match(/([\d.]+)\s*(thousand|million|billion|[KMB])?/i);
  if (!m) return 0;
  const mult = { k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, b: 1e9, billion: 1e9 }[String(m[2] || '').toLowerCase()] || 1;
  return Math.round(parseFloat(m[1]) * mult);
}
/* "4 days ago" -> an approximate date. */
function parseAgo(s) {
  const m = String(s || '').match(/(\d+)\s*(second|minute|hour|day|week|month|year)/i);
  if (!m) return null;
  const unit = { second: 1, minute: 60, hour: 3600, day: 86400, week: 604800, month: 2629800, year: 31557600 }[m[2].toLowerCase()];
  return new Date(Date.now() - Number(m[1]) * unit * 1000).toISOString();
}

/** The videos on a channel tab ("videos" or "shorts"), as any visitor sees them. */
async function tabVideos(channelId, tab) {
  let html = '';
  try {
    const res = await get('https://www.youtube.com/channel/' + channelId + '/' + tab);
    if (!res.ok) return { ok: false, videos: [] };
    html = await res.text();
  } catch {
    return { ok: false, videos: [] };
  }
  const m = html.match(/var ytInitialData = (\{.*?\});<\/script>/s);
  if (!m) return { ok: false, videos: [] };
  let data;
  try {
    data = JSON.parse(m[1]);
  } catch {
    return { ok: false, videos: [] };
  }
  const title = unxml((html.match(/<meta property="og:title" content="([^"]*)"/) || [])[1] || '');
  const videos = [];
  const seen = new Set();
  (function walk(o) {
    if (!o || typeof o !== 'object' || videos.length >= 30) return;
    if (o.lockupViewModel && o.lockupViewModel.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO') {
      const l = o.lockupViewModel;
      const meta = l.metadata && l.metadata.lockupMetadataViewModel;
      const parts = (((meta && meta.metadata && meta.metadata.contentMetadataViewModel && meta.metadata.contentMetadataViewModel.metadataRows) || [])[0] || {}).metadataParts || [];
      const label = (i) => (parts[i] && (parts[i].accessibilityLabel || (parts[i].text && parts[i].text.content))) || '';
      const views = parseViews(label(0));
      const published = parseAgo(label(1));
      /* A premiere or an upcoming live has no views and no age yet: leave it out. */
      if (l.contentId && !seen.has(l.contentId) && (views > 0 || published)) {
        seen.add(l.contentId);
        videos.push({ id: l.contentId, title: (meta && meta.title && meta.title.content) || '', views, published });
      }
      return;
    }
    if (o.shortsLockupViewModel) {
      const s = o.shortsLockupViewModel;
      const id = (((s.onTap || {}).innertubeCommand || {}).reelWatchEndpoint || {}).videoId || String(s.entityId || '').replace('shorts-shelf-item-', '');
      const text = String(s.accessibilityText || '');
      const cut = text.lastIndexOf(', ');
      if (id && !seen.has(id)) {
        seen.add(id);
        videos.push({ id, title: (cut > 0 ? text.slice(0, cut) : text).trim(), views: parseViews(cut > 0 ? text.slice(cut) : ''), published: null });
      }
      return;
    }
    for (const k of Object.keys(o)) walk(o[k]);
  })(data);
  return { ok: true, title, videos };
}

/** One video's current views (for a Short the member posted). */
async function videoViews(videoId) {
  if (apiKey()) {
    const r = await (await get('https://www.googleapis.com/youtube/v3/videos?part=statistics,snippet&id=' + videoId + '&key=' + apiKey())).json();
    const v = r.items && r.items[0];
    if (v) return { views: Number(v.statistics.viewCount) || 0, title: v.snippet.title, channelId: v.snippet.channelId };
  }
  const res = await get('https://www.youtube.com/watch?v=' + videoId);
  const html = await res.text();
  const views = html.match(/"viewCount":"(\d+)"/);
  if (!views) return null;
  return {
    views: Number(views[1]),
    title: unxml((html.match(/<meta name="title" content="([^"]*)"/) || [])[1] || ''),
    channelId: (html.match(/"channelId":"(UC[A-Za-z0-9_-]{22})"/) || [])[1] || null,
  };
}

module.exports = { parseChannelInput, videoIdFrom, resolveChannelId, channel, videoViews, isShort, parseViews, parseAgo };
