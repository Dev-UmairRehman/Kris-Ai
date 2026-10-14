'use strict';

/* Your Marketing Agency, through the real routes and the shared MasterPlan
   login. The models are stubbed (no API credit is spent); the stubs answer in
   the shapes the real models are asked for. */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-test-'));
Object.assign(process.env, {
  MP_USCREEN_API_KEY: '', // never the developer's own key from .env
  MP_OPENAI_API_KEY: '', // never the developer's own key from .env
  MP_GEMINI_API_KEY: '', // never the developer's own key from .env
  YMA_APIFY_TOKEN: '', // never the developer's own key from .env
  NODE_ENV: 'development',
  MEMBER_GATE_MODE: 'open',
  MP_ENABLED: 'true',
  MP_STORAGE: 'disk',
  MP_DISK_ROOT: tmp,
  MP_LLM_PROVIDER: 'openrouter',
  MP_OPENROUTER_API_KEY: 'test-key',
  MP_EMAIL_DRIVER: 'log',
  MP_PAGE_PLAN_CHECK: 'off',
  USCREEN_API_BASE: '',
  USCREEN_API_KEY: '',
  YMA_ENABLED: 'true',
  YMA_PACKS_PER_DAY: '3',
});

const llm = require('../../masterplan/llm');
const config = require('../config');

/* ---- model stubs ---------------------------------------------------------------- */

const calls = [];
const ideaPrompts = [];
const insightPrompts = [];
let nextShot = null;
let packDrafts = 0;
llm.generate = async (p) => {
  const text = typeof p.content === 'string' ? p.content : p.content.map((b) => b.text || '').join('\n');
  calls.push({ model: p.model, start: text.slice(0, 40) });
  const usage = p.usage || {};
  usage.cost_usd = (usage.cost_usd || 0) + 0.001;
  const json = (o) => ({ text: '```json\n' + JSON.stringify(o) + '\n```', usage });
  /* Profile and ideas may use the same model: tell the jobs apart by their instructions. */
  const sys = typeof p.system === 'string' ? p.system : (p.system || []).map((b) => b.text).join('\n');
  const job = /brand identity profile/.test(sys) ? 'profile' : /analytics screen/.test(sys) ? 'screenshot' : /own accounts \(YouTube, Instagram, TikTok\)/.test(sys) ? 'insights' : /content strategist/.test(sys) ? 'ideas' : /short-video content/.test(sys) ? 'write' : 'transcribe';

  if (job === 'screenshot') {
    assert.strictEqual(p.content[0].type, 'image_data', 'the screenshot goes to the model');
    return json(nextShot);
  }
  if (job === 'insights') {
    assert.match(text, /latest videos/);
    insightPrompts.push(text);
    return json({ summary: 'Personal stories win.', working: ['Stories from childhood'], notWorking: ['Generic tips'], doMore: ['One story per Short'], topicsThatWork: ['childhood'] });
  }
  if (job === 'ideas') ideaPrompts.push(text);
  if (job === 'transcribe') {
    assert.ok(Array.isArray(p.content) && p.content[0].type === 'audio', 'audio goes to the model');
    return { text: 'When I was a child I dreamt of writing books.', usage };
  }
  if (job === 'profile') {
    const q = (text.match(/Question: (.*)/) || [])[1] || '';
    const story = (title, tier) => ({ title, theme: 'courage', summary: 'Something that happened: ' + title, tier });
    return json({
      profile: { mission: 'Help people grow', expertise: 'coaching', values: ['loyalty', 'kindness'], voice: 'plain, warm', coreBelief: 'People can change' },
      newStories: q.includes('dream') ? [story('The typewriter', 'P'), story('The bus', 'X'), story('Grandmother', 'A')] : [],
      storyUpdates: [],
      followUp: text.includes('<answer>\nshort\n</answer>') ? 'Why? Give an example.' : null,
      confirm: [],
    });
  }
  if (job === 'ideas') {
    const stories = JSON.parse(text.match(/<stories>\n([\s\S]*?)\n<\/stories>/)[1]);
    /* The model only ever sees publishable stories. */
    assert.ok(stories.every((s) => s.title === 'The typewriter'), 'only publishable stories reach the ideas model');
    return json({
      ideas: [
        { topic: 'The typewriter', angle: 'A dream that shaped a career', goal: 'trust', storyId: stories[0].id, why: 'her story' },
        { topic: 'A myth in coaching', angle: 'What beginners get wrong', goal: 'expertise', storyId: 'made-up-id', why: 'expertise' },
      ],
    });
  }
  if (job === 'write') {
    packDrafts++;
    const repair = text.startsWith('This draft breaks the writing rules');
    return json({
      titles: ['The typewriter', 'Dreams that write', 'What I wanted at seven'],
      hook: repair ? 'I wanted a typewriter more than anything.' : 'I wanted a typewriter — more than anything.',
      script: [{ say: 'I wanted a typewriter.', show: 'Close-up, window light' }],
      seconds: 40,
      filming: { framing: 'chest up', light: 'window', sound: 'lapel mic', location: 'desk', tips: ['look at the lens'] },
      caption: 'What did you want as a child? Tell me below.',
      hashtags: ['writing', '#dreams'],
      post: 'When I was seven I wanted a typewriter.',
      postingTips: ['Post in the morning'],
      cover: { scene: 'Woman at a desk with an old typewriter', text: 'The typewriter' },
    });
  }
  throw new Error('unexpected model ' + p.model);
};

/* The cover picture comes from OpenRouter's image endpoint: stub fetch for it. */
const realFetch = global.fetch;
let coverRequests = [];
global.fetch = async (url, opts) => {
  if (String(url).startsWith('https://openrouter.ai/')) {
    const body = JSON.parse(opts.body);
    coverRequests.push(body);
    const png = Buffer.from('89504e470d0a1a0a' + '00'.repeat(64), 'hex').toString('base64');
    return new Response(JSON.stringify({ choices: [{ message: { images: [{ image_url: { url: 'data:image/png;base64,' + png } }] } }], usage: { cost: 0.004 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  return realFetch(url, opts);
};

/* ---- the server -------------------------------------------------------------------- */

const express = require('express');
const masterplan = require('../../masterplan');
/* YouTube is not called in tests: the channel reader is stubbed. */
const channelsMod = require('../channels');
const day = (n) => new Date(Date.now() - n * 86400000).toISOString();
channelsMod.channel = async () => ({
  channelId: 'UC' + 'x'.repeat(22),
  title: 'Ana on stories',
  source: 'feed',
  videos: [
    { id: 'aaaaaaaaaa1', title: 'My first short', published: day(3), views: 900, short: true },
    { id: 'aaaaaaaaaa2', title: 'Another short', published: day(10), views: 1100, short: true },
    { id: 'aaaaaaaaaa3', title: 'A third short', published: day(20), views: 1000, short: true },
    { id: 'aaaaaaaaaa4', title: 'A long talk', published: day(30), views: 20000, short: false },
  ],
});
/* Nor Apify: the Instagram / TikTok reader is stubbed. */
const socialMod = require('../social');
socialMod.available = () => true;
const socialReads = [];
socialMod.read = async (platform, handle) => {
  socialReads.push(platform + ':' + handle);
  if (handle === 'nobody') throw Object.assign(new Error('We could not read @nobody.'), { userFacing: true, status: 404 });
  const v = (id, views, d) => ({ id, url: 'https://x/' + id, title: 'Video ' + id, views, likes: 10, comments: 2, published: day(d), short: true });
  return platform === 'instagram'
    ? { handle, title: 'Ana', followers: null, costUsd: 0.002, videos: [v('abc', 1500, 1), v('R1', 300, 5), v('R2', 500, 8), v('R3', 400, 12)] }
    : { handle, title: 'Ana TT', followers: 900, costUsd: 0.002, videos: [v('7000000000000000009', 2000, 2), v('7000000000000000001', 600, 6), v('7000000000000000002', 1000, 9)] };
};
channelsMod.videoViews = async (id) => ({ views: id === 'bbbbbbbbbb1' ? 5000 : 0, title: 'Posted short', channelId: null });
const agency = require('..');
let base;
let server;

test.before(async () => {
  const app = express();
  app.use(express.json({ limit: '12mb' }));
  app.use('/masterplan', masterplan.router);
  app.use('/agency', agency.router);
  await new Promise((r) => (server = app.listen(0, r)));
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(() => server.close());

async function call(method, p, body, token, type) {
  const headers = {};
  if (token) headers.authorization = 'Bearer ' + token;
  let payload;
  if (Buffer.isBuffer(body)) {
    headers['content-type'] = type;
    payload = body;
  } else if (body) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await realFetch(base + p, { method, headers, body: payload });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, type: ct, data: ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
}
async function signIn(email) {
  const r = await call('POST', '/masterplan/api/session', { signedIn: true, email });
  assert.strictEqual(r.status, 200);
  return r.data.token;
}
async function until(fn, what) {
  for (let i = 0; i < 300; i++) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error('timed out waiting for ' + what);
}

const questions = require('../questions');

/* ---- tests --------------------------------------------------------------------------------- */

test('the same login as MasterPlan opens it; no login opens nothing', async () => {
  assert.strictEqual((await call('GET', '/agency/api/state')).status, 401);
  const t = await signIn('ana@example.com');
  const s = await call('GET', '/agency/api/state', null, t);
  assert.strictEqual(s.status, 200);
  assert.strictEqual(s.data.answered, 0);
  assert.strictEqual(s.data.next.id, 'L1Q1', 'starts with the childhood starter');
  assert.strictEqual(s.data.starters.length, 10);
});

test('starter questions first, then one more every few days; answers build the profile', async () => {
  const t = await signIn('ana@example.com');
  const locked = await call('POST', '/agency/api/answers', { qid: 'L1Q2', text: 'Something' }, t);
  assert.strictEqual(locked.status, 400, 'a later question is not open yet');

  for (const qid of questions.starters) {
    const r = await call('POST', '/agency/api/answers', { qid, text: qid === 'L1Q1' ? 'I dreamt of a typewriter and of writing books.' : 'short' }, t);
    assert.strictEqual(r.status, 200, qid);
  }
  const st = await until(async () => {
    const r = await call('GET', '/agency/api/state', null, t);
    return r.data.reading === 0 && r.data.profileReady ? r.data : null;
  }, 'profile');
  assert.strictEqual(st.startersDone, true);
  assert.ok(st.next && !questions.starters.includes(st.next.id), 'a new question opens after the starters');
  assert.ok(st.followUps >= 1, 'thin answers get a follow-up');

  const prof = await call('GET', '/agency/api/profile', null, t);
  assert.strictEqual(prof.data.profile.mission, 'Help people grow');
  const tiers = Object.fromEntries(prof.data.stories.map((s) => [s.title, s.tier]));
  assert.deepStrictEqual(tiers, { 'The typewriter': 'P', 'The bus': 'X', Grandmother: 'A' });

  /* The next question cannot be skipped ahead of: only the earned one is open. */
  const qs = await call('GET', '/agency/api/questions', null, t);
  const open = qs.data.levels.flatMap((l) => l.questions).filter((q) => q.open && !q.answeredAt);
  assert.strictEqual(open.length, 1);
});

test('the member\'s own edits and tiers win over the model', async () => {
  const t = await signIn('ana@example.com');
  await call('POST', '/agency/api/profile', { field: 'mission', value: 'My own words' }, t);
  const prof = await call('GET', '/agency/api/profile', null, t);
  const grandmother = prof.data.stories.find((s) => s.title === 'Grandmother');
  assert.strictEqual((await call('POST', '/agency/api/stories/' + grandmother.id, { tier: 'X' }, t)).status, 200);

  /* Re-answering runs the model again; the edited field stays theirs. */
  await call('POST', '/agency/api/answers', { qid: 'L2Q21', text: 'People can change, I have seen it.' }, t);
  await until(async () => (await call('GET', '/agency/api/state', null, t)).data.reading === 0, 'reading');
  const after = await call('GET', '/agency/api/profile', null, t);
  assert.strictEqual(after.data.profile.mission, 'My own words');
  assert.ok(after.data.locked.includes('mission'));
  assert.strictEqual(after.data.stories.find((s) => s.title === 'Grandmother').tier, 'X');
});

test('ideas use only publishable stories; packs follow the writing rules; covers use the photo', async () => {
  const t = await signIn('ana@example.com');
  assert.strictEqual((await call('POST', '/agency/api/ideas', {}, t)).status, 202);
  const ideas = await until(async () => {
    const r = await call('GET', '/agency/api/ideas', null, t);
    return r.data.job && r.data.job.status === 'ready' ? r.data.ideas : null;
  }, 'ideas');
  assert.strictEqual(ideas.length, 2);
  assert.strictEqual(ideas[0].story, 'The typewriter');
  assert.strictEqual(ideas[1].story, null, 'an invented story id is dropped');

  const iid = ideas[0].id;
  assert.strictEqual((await call('POST', '/agency/api/ideas/' + iid + '/cover', {}, t)).status, 400, 'cover needs the content first');
  packDrafts = 0;
  assert.strictEqual((await call('POST', '/agency/api/ideas/' + iid + '/pack', {}, t)).status, 202);
  const content = await until(async () => {
    const r = await call('GET', '/agency/api/ideas/' + iid, null, t);
    return r.data.idea.pack && r.data.idea.pack.status === 'ready' ? r.data.content : null;
  }, 'pack');
  assert.strictEqual(packDrafts, 2, 'the em dash in the first draft was sent back for repair');
  assert.doesNotMatch(content.hook, /—/);
  assert.deepStrictEqual(content.ruleIssues, []);
  assert.deepStrictEqual(content.hashtags, ['#writing', '#dreams']);

  const photo = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(2000, 7)]);
  assert.strictEqual((await call('POST', '/agency/api/photo', photo, t, 'image/jpeg')).status, 200);
  coverRequests = [];
  assert.strictEqual((await call('POST', '/agency/api/ideas/' + iid + '/cover', {}, t)).status, 202);
  await until(async () => {
    const r = await call('GET', '/agency/api/ideas/' + iid, null, t);
    return r.data.idea.cover && r.data.idea.cover.status === 'ready';
  }, 'cover');
  const sent = coverRequests[0];
  assert.strictEqual(sent.image_config.aspect_ratio, '9:16');
  assert.ok(sent.messages[0].content.some((c) => c.type === 'image_url'), 'the member photo goes with the request');
  assert.match(sent.messages[0].content[0].text, /no text/i);
  const img = await call('GET', '/agency/api/ideas/' + iid + '/cover', null, t);
  assert.strictEqual(img.status, 200);
  assert.strictEqual(img.type, 'image/png');
});

test('another member sees nothing of this member\'s', async () => {
  const t = await signIn('ana@example.com');
  const other = await signIn('bo@example.com');
  const iid = (await call('GET', '/agency/api/ideas', null, t)).data.ideas[0].id;
  for (const p of ['/agency/api/ideas/' + iid, '/agency/api/ideas/' + iid + '/cover']) {
    assert.strictEqual((await call('GET', p, null, other)).status, 404, p);
  }
  assert.strictEqual((await call('GET', '/agency/api/answers/L1Q1', null, other)).data.answer, null);
  assert.deepStrictEqual((await call('GET', '/agency/api/profile', null, other)).data.stories, []);
  assert.strictEqual((await call('GET', '/agency/api/photo', null, other)).status, 404);
  assert.strictEqual((await call('POST', '/agency/api/ideas/' + iid + '/delete', {}, other)).status, 200);
  assert.strictEqual((await call('GET', '/agency/api/ideas/' + iid, null, t)).status, 200, 'deleting someone else\'s idea does nothing');
});

test('recordings become text to check; only audio formats; nothing kept', async () => {
  const t = await signIn('ana@example.com');
  const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(5000, 1)]);
  const r = await call('POST', '/agency/api/transcribe?seconds=30', mp3, t, 'audio/mpeg');
  assert.strictEqual(r.status, 200);
  assert.match(r.data.text, /typewriter|books/);
  assert.strictEqual((await call('POST', '/agency/api/transcribe', mp3, t, 'video/x-flv')).status, 415);
  const files = fs.readdirSync(tmp, { recursive: true }).map(String);
  assert.ok(!files.some((f) => /\.(mp3|audio)$/i.test(f)), 'no recording is stored');
});

test('daily limits stop runaway costs', async () => {
  const t = await signIn('ana@example.com');
  const iid = (await call('GET', '/agency/api/ideas', null, t)).data.ideas[1].id;
  /* 3 packs a day in this test; one was used above. */
  for (let i = 0; i < 2; i++) {
    assert.strictEqual((await call('POST', '/agency/api/ideas/' + iid + '/pack', {}, t)).status, 202);
    await until(async () => {
      const r = await call('GET', '/agency/api/ideas/' + iid, null, t);
      return r.data.idea.pack && r.data.idea.pack.status !== 'running';
    }, 'pack ' + i);
  }
  const over = await call('POST', '/agency/api/ideas/' + iid + '/pack', {}, t);
  assert.strictEqual(over.status, 429);
  assert.strictEqual(over.data.reason, 'limit');
});

test('results: channels, what was posted, and whether it gets more views', async () => {
  const t = await signIn('ana@example.com');
  assert.strictEqual((await call('POST', '/agency/api/insights', {}, t)).status, 400, 'needs a channel first');
  const c = await call('POST', '/agency/api/channels', { platform: 'youtube', input: '@ana' }, t);
  assert.strictEqual(c.status, 200);
  assert.strictEqual(c.data.title, 'Ana on stories');

  const iid = (await call('GET', '/agency/api/ideas', null, t)).data.ideas[0].id;
  assert.strictEqual((await call('POST', '/agency/api/ideas/' + iid + '/posted', { platform: 'youtube', url: 'https://example.com/x' }, t)).status, 400, 'a non-YouTube link is refused');
  const yt = await call('POST', '/agency/api/ideas/' + iid + '/posted', { platform: 'youtube', url: 'https://youtube.com/shorts/bbbbbbbbbb1' }, t);
  assert.strictEqual(yt.data.views, 5000, 'YouTube views are read automatically');
  await call('POST', '/agency/api/ideas/' + iid + '/posted', { platform: 'instagram', url: 'https://www.instagram.com/reel/abc/', views: 800 }, t);
  await call('POST', '/agency/api/channels', { platform: 'instagram', url: 'https://instagram.com/ana', baseline: 400 }, t);

  const r = await call('GET', '/agency/api/results', null, t);
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.data.compare.youtube.madeHere, { n: 1, avg: 5000 });
  assert.strictEqual(r.data.compare.youtube.before.avg, 1000, 'compared with the channel"s other Shorts, not its long videos');
  assert.deepStrictEqual(r.data.compare.instagram, { madeHere: { n: 1, avg: 800 }, before: { n: null, avg: 400, what: 'your usual views' } });
  assert.strictEqual(r.data.posted[0].posts.length, 2);

  assert.strictEqual((await call('POST', '/agency/api/insights', {}, t)).status, 202);
  const ins = await until(async () => (await call('GET', '/agency/api/results', null, t)).data.insights, 'insights');
  assert.deepStrictEqual(ins.working, ['Stories from childhood']);
  /* New ideas learn from what works on the channel. */
  await call('POST', '/agency/api/ideas', {}, t);
  await until(async () => ideaPrompts.some((p) => /What already works on their own accounts/.test(p) && /Stories from childhood/.test(p)), 'ideas use insights');

  const other = await signIn('bo@example.com');
  const theirs = await call('GET', '/agency/api/results', null, other);
  assert.strictEqual(theirs.data.youtube, null);
  assert.deepStrictEqual(theirs.data.posted, []);
});

test('Instagram and TikTok by @handle: posted views read automatically; screenshots add the rest', async () => {
  const t = await signIn('ana@example.com');
  const ideas = (await call('GET', '/agency/api/ideas', null, t)).data.ideas;
  /* The idea posted on YouTube and Instagram in the test above, and another one. */
  const first = ideas.find((i) => i.posted.some((p) => p.platform === 'instagram')).id;
  const second = ideas.find((i) => i.id !== first).id;

  /* Posted on TikTok before the account is connected: no views yet. */
  const tt = await call('POST', '/agency/api/ideas/' + first + '/posted', { platform: 'tiktok', url: 'https://www.tiktok.com/@ana/video/7000000000000000009?lang=en' }, t);
  assert.strictEqual(tt.status, 200);
  assert.strictEqual(tt.data.views, null);
  assert.strictEqual((await call('POST', '/agency/api/ideas/' + first + '/posted', { platform: 'instagram', url: 'https://www.instagram.com/ana/' }, t)).status, 400, 'a profile link is not a post');

  assert.strictEqual((await call('POST', '/agency/api/channels', { platform: 'instagram', handle: 'not a handle!' }, t)).status, 400);
  for (const [platform, handle] of [['instagram', 'https://www.instagram.com/ana.stories/'], ['tiktok', '@Ana']]) {
    const c = await call('POST', '/agency/api/channels', { platform, handle }, t);
    assert.strictEqual(c.status, 202, platform);
  }
  const r = await until(async () => {
    const x = await call('GET', '/agency/api/results', null, t);
    const j = x.data.socialJobs;
    return j.instagram && j.instagram.status === 'ready' && j.tiktok && j.tiktok.status === 'ready' ? x.data : null;
  }, 'social reads');
  assert.ok(socialReads.includes('instagram:ana.stories') && socialReads.includes('tiktok:ana'));
  assert.strictEqual(r.instagram.handle, 'ana.stories');
  assert.strictEqual(r.instagram.baseline, 400, 'the usual views typed before are kept');
  assert.strictEqual(r.tiktok.followers, 900);

  /* The Reel typed as 800 views earlier is in the account: its real count wins. */
  const posts = r.posted.find((p) => p.ideaId === first).posts;
  const ig = posts.find((p) => p.platform === 'instagram');
  assert.strictEqual(ig.views, 1500);
  assert.strictEqual(ig.source, 'read');
  assert.strictEqual(posts.find((p) => p.platform === 'tiktok').views, 2000);
  assert.deepStrictEqual(r.compare.instagram, { madeHere: { n: 1, avg: 1500 }, before: { n: 3, avg: 400, what: 'your other Reels' } });
  assert.deepStrictEqual(r.compare.tiktok, { madeHere: { n: 1, avg: 2000 }, before: { n: 2, avg: 800, what: 'your other videos' } });

  /* A post the account read does not have yet: views typed or from a screenshot. */
  const fresh = await call('POST', '/agency/api/ideas/' + second + '/posted', { platform: 'tiktok', url: 'https://www.tiktok.com/@ana/video/7000000000000000077' }, t);
  assert.strictEqual(fresh.data.views, null);
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(3000, 3)]);
  assert.strictEqual((await call('POST', '/agency/api/ideas/' + second + '/posted/screenshot?platform=instagram', png, t, 'image/png')).status, 400, 'only for a saved post');
  nextShot = { isAnalytics: false, platform: null, views: null };
  assert.strictEqual((await call('POST', '/agency/api/ideas/' + second + '/posted/screenshot?platform=tiktok', png, t, 'image/png')).status, 422, 'a picture with no numbers');
  nextShot = { isAnalytics: true, platform: 'tiktok', views: 12400, reach: null, avgWatchSeconds: 7.5, watchedFullPercent: 31.2, likes: 'many' };
  const shot = await call('POST', '/agency/api/ideas/' + second + '/posted/screenshot?platform=tiktok', png, t, 'image/png');
  assert.strictEqual(shot.status, 200);
  assert.deepStrictEqual(shot.data.stats, { views: 12400, avgWatchSeconds: 7.5, watchedFullPercent: 31.2 });
  assert.strictEqual(shot.data.views, 12400);
  const files = fs.readdirSync(tmp, { recursive: true }).map(String);
  assert.ok(!files.some((x) => /\.png$/.test(x)), 'the screenshot is not kept');

  /* The analysis now covers every connected account. */
  insightPrompts.length = 0;
  assert.strictEqual((await call('POST', '/agency/api/insights', {}, t)).status, 202);
  await until(async () => insightPrompts.some((p) => /Instagram/.test(p) && /TikTok/.test(p) && /YouTube/.test(p)), 'insights on all platforms');

  /* An account that cannot be read says so. */
  await call('POST', '/agency/api/channels', { platform: 'instagram', handle: '@nobody' }, t);
  const failed = await until(async () => {
    const x = await call('GET', '/agency/api/results', null, t);
    return x.data.socialJobs.instagram && x.data.socialJobs.instagram.status === 'failed' ? x.data.socialJobs.instagram : null;
  }, 'failed read');
  assert.match(failed.error, /nobody/);

  socialMod.available = () => false;
  assert.strictEqual((await call('POST', '/agency/api/channels', { platform: 'tiktok', handle: '@ana' }, t)).status, 503, 'off without an Apify token');
  socialMod.available = () => true;

  const other = await signIn('bo@example.com');
  const theirs = (await call('GET', '/agency/api/results', null, other)).data;
  assert.strictEqual(theirs.instagram, null);
  assert.strictEqual(theirs.tiktok, null);
});

test('delete everything removes the member\'s data', async () => {
  const t = await signIn('ana@example.com');
  assert.strictEqual((await call('POST', '/agency/api/delete-all', { confirm: 'nope' }, t)).status, 400);
  await until(async () => (await call('POST', '/agency/api/delete-all', { confirm: 'DELETE' }, t)).status === 200, 'delete');
  const s = await call('GET', '/agency/api/state', null, t);
  assert.strictEqual(s.data.answered, 0);
  assert.strictEqual((await call('GET', '/agency/api/answers/L1Q1', null, t)).data.answer, null);
  assert.strictEqual((await call('GET', '/agency/api/photo', null, t)).status, 404);
});
