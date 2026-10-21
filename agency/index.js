'use strict';

/* ---------------------------------------------------------------------------
   Your Marketing Agency - routes, under /agency.

   Same member login as MasterPlan Digital: the page gets its session from
   /masterplan/api/session (which also checks the member's plan) and sends that
   token here. Nothing here is shared between members: answers are private,
   and a story the member marks private is never used in content.

     GET  /agency/healthz
     GET  /agency/api/state                 dashboard: progress, next question, jobs
     GET  /agency/api/questions             the bank, with what is open and answered
     GET  /agency/api/answers/:qid          one answer
     POST /agency/api/answers               save an answer (typed, or a checked transcript)
     POST /agency/api/transcribe            raw audio -> text, for the member to check
     GET  /agency/api/profile               identity profile, story bank, things to confirm
     POST /agency/api/profile               edit a profile field (the model then leaves it alone)
     POST /agency/api/stories/:sid          set a story's tier (P publishable, A ask first, X private)
     GET  /agency/api/rules                 writing rules: defaults + the member's own
     POST /agency/api/rules
     GET  /agency/api/ideas                 topic ideas
     POST /agency/api/ideas                 propose new ideas
     GET  /agency/api/ideas/:iid            one idea and its content pack
     POST /agency/api/ideas/:iid/pack       write the content pack
     POST /agency/api/ideas/:iid/cover      draw the cover picture
     GET  /agency/api/ideas/:iid/cover      the picture
     POST /agency/api/ideas/:iid/delete
     POST /agency/api/photo                 raw image: the member's photo for covers
     GET  /agency/api/photo
     POST /agency/api/photo/delete
     GET  /agency/api/results               channels, posted content, views, comparison
     POST /agency/api/channels              connect YouTube, Instagram, TikTok by @handle
     POST /agency/api/insights              what works on their accounts
     POST /agency/api/ideas/:iid/posted     where a pack went live (+ views)
     POST /agency/api/ideas/:iid/posted/screenshot   numbers read off an analytics screenshot
     POST /agency/api/delete-all            remove everything we hold for the member
   --------------------------------------------------------------------------- */

const crypto = require('crypto');
const express = require('express');

const rootConfig = require('../lib/config');
const auth = require('../lib/auth');
const config = require('./config');
const questions = require('./questions');
const rules = require('./rules');

const router = express.Router();
const ready = config.enabled && config.problems.length === 0;

/* MasterPlan provides the login, storage and model access. */
let mp = null;
let store = null;
let engine = null;
let llm = null;
if (ready) {
  mp = require('../masterplan');
  store = require('../masterplan/store');
  llm = require('../masterplan/llm');
  engine = require('./engine');
}
const channels = require('./channels');
const social = require('./social');

const MEMBER = (id) => 'yma/members/' + id + '.json';
const ANSWER = (id, qid) => 'yma/answers/' + id + '/' + qid + '.json';
const PACK = (id, iid) => 'yma/packs/' + id + '/' + iid + '.json';
const PHOTO = (id) => 'yma/photos/' + id + '.img';
const COVER = (id, iid) => 'yma/covers/' + id + '/' + iid + '.img';
const USAGE = 'yma/usage.json';

const today = () => new Date().toISOString().slice(0, 10);
const newId = () => crypto.randomBytes(9).toString('base64url');
const userError = (msg, status = 400, reason) => Object.assign(new Error(msg), { userFacing: true, status, reason });

/* ---- the member record ------------------------------------------------------ */

function blank() {
  return {
    createdAt: new Date().toISOString(),
    answered: {},
    startersDoneAt: null,
    profile: {},
    locked: [],
    stories: [],
    confirm: [],
    followUps: {},
    rules: { text: '', phrases: [] },
    ideas: [],
    photo: null,
    pending: [],
    jobs: {},
    usage: { day: today() },
  };
}

async function getMember(id) {
  return (await store.getJson(MEMBER(id), null)) || blank();
}
function updateMember(id, fn) {
  return store.update(MEMBER(id), null, (m) => {
    const x = m || blank();
    return fn(x) || x;
  });
}

/* Daily allowance per member, counted when a paid job is accepted. */
async function spend(id, kind, amount = 1) {
  const cap = config.limits[kind];
  const global = await store.getJson(USAGE, null);
  if (global && global.day === today() && global.cost >= config.limits.globalCost) {
    throw userError('Your Marketing Agency is very busy today. Please try again tomorrow.', 429, 'busy');
  }
  await updateMember(id, (m) => {
    if (!m.usage || m.usage.day !== today()) m.usage = { day: today() };
    const used = m.usage[kind] || 0;
    if (used + amount > cap) {
      const what = { answers: 'answers', audioMinutes: 'minutes of recordings', ideas: 'rounds of ideas', packs: 'content packs', covers: 'covers', insights: 'analyses', socialReads: 'account reads', screenshots: 'screenshots read' }[kind];
      throw userError('You have reached today\'s limit of ' + cap + ' ' + what + '. It resets tomorrow.', 429, 'limit');
    }
    m.usage[kind] = used + amount;
    return m;
  });
}

/* What each paid call cost, for the site-wide daily ceiling and the log. */
async function addCost(usage, what) {
  const cost = Math.round(llm.estimateCost(usage) * 10000) / 10000;
  if (!cost) return;
  await store
    .update(USAGE, null, (u) => {
      if (!u || u.day !== today()) u = { day: today(), cost: 0 };
      u.cost = Math.round((u.cost + cost) * 10000) / 10000;
      return u;
    })
    .catch(() => {});
  console.log('[agency] %s ~$%s', what, cost);
}

/* ---- background jobs ---------------------------------------------------------- */

/* One job at a time per member (their record is updated by each), several
   members in parallel. `active` says which jobs this process is running; a
   job marked running that is not active was cut off by a restart. */
const lanes = new Map();
const active = new Set();

function runJob(memberId, key, fn) {
  active.add(memberId + ':' + key);
  const prev = lanes.get(memberId) || Promise.resolve();
  const next = prev
    .then(fn)
    .catch((err) => console.error('[agency] job %s failed: %s', key, err.stack || err))
    .finally(() => {
      active.delete(memberId + ':' + key);
      if (lanes.get(memberId) === next) lanes.delete(memberId);
    });
  lanes.set(memberId, next);
  return next;
}
const isActive = (memberId, key) => active.has(memberId + ':' + key);

/* Read one saved answer into the profile and story bank. */
async function absorbJob(memberId, qid) {
  const usage = {};
  let failed = false;
  try {
    const q = questions.get(qid);
    const answer = await store.getJson(ANSWER(memberId, qid), null);
    const m = await getMember(memberId);
    if (q && answer && answer.text) {
      const out = await engine.absorb({ question: q.text, answer: answer.text, profile: m.profile, stories: m.stories, locked: m.locked, usage });
      await updateMember(memberId, (mm) => {
        mm.profile = out.profile;
        /* A story told again in a later answer is not added twice. */
        const known = new Set(mm.stories.map((s) => s.title.trim().toLowerCase()));
        for (const s of out.newStories) {
          if (known.has(s.title.trim().toLowerCase())) continue;
          known.add(s.title.trim().toLowerCase());
          mm.stories.push({ id: newId(), ...s, tierBy: 'model', from: qid, at: new Date().toISOString() });
        }
        for (const u of out.storyUpdates) {
          const s = mm.stories.find((x) => x.id === u.id);
          if (s) s.summary = String(u.summary).slice(0, 1500);
        }
        mm.stories = mm.stories.slice(-200);
        if (out.followUp) mm.followUps[qid] = out.followUp;
        else delete mm.followUps[qid];
        mm.confirm = [...new Set([...(mm.confirm || []), ...out.confirm])].slice(-20);
        mm.profileAt = new Date().toISOString();
        return mm;
      });
    }
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    /* Not retried on its own (that could cost money over and over): the
       member is told, and saving the answer again tries again. */
    await updateMember(memberId, (mm) => {
      mm.pending = (mm.pending || []).filter((x) => x !== qid);
      mm.readFailed = (mm.readFailed || []).filter((x) => x !== qid);
      if (failed) mm.readFailed.push(qid);
      return mm;
    }).catch(() => {});
    await addCost(usage, 'profile from ' + qid);
  }
}

function queueAbsorb(memberId, qid) {
  return runJob(memberId, 'absorb:' + qid, () => absorbJob(memberId, qid));
}

/* ---- guards ------------------------------------------------------------------- */

router.get('/healthz', (req, res) => {
  res.json({
    ok: ready,
    enabled: config.enabled,
    problems: config.problems,
    models: config.models,
    questions: questions.total,
    social: social.available(),
  });
});

/* The MP3 encoder for recording in the browser, loaded only when a member
   presses Record (the pasted page stays small). */
const LAME = require.resolve('@breezystack/lamejs').replace(/lamejs(\.iife)?\.js$/, 'lamejs.iife.js');
router.get('/static/lame.js', (req, res) => {
  res.setHeader('Cache-Control', rootConfig.isProd ? 'public, max-age=604800' : 'no-store');
  res.type('application/javascript').sendFile(LAME);
});

router.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!ready || !mp || !mp.ready) return res.status(503).json({ error: 'Your Marketing Agency is not available yet.', reason: 'not_configured' });
  if (!auth.isTrustedRequestOrigin(req)) return res.status(403).json({ error: 'Request came from an unrecognised page.' });
  next();
});
router.use('/api', (req, res, next) => mp.requireSession(req, res, next));

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => {
    if (err.userFacing) return res.status(err.status || 400).json({ error: err.message, reason: err.reason });
    console.error('[agency] %s %s failed:', req.method, req.originalUrl, err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  });

const clip = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');

/* ---- dashboard -------------------------------------------------------------- */

function jobState(m, memberId, key) {
  const j = (m.jobs || {})[key];
  if (!j) return null;
  if (j.status === 'running' && !isActive(memberId, key)) return { status: 'failed', error: 'This was interrupted. Please try again.' };
  return j;
}

router.get('/api/state', wrap(async (req, res) => {
  const id = req.memberId;
  const m = await getMember(id);
  /* Answers saved but not yet read (a restart in between): read them now. */
  for (const qid of m.pending || []) if (!isActive(id, 'absorb:' + qid)) queueAbsorb(id, qid);
  const next = questions.next(m, config.nextEveryDays);
  const answeredCount = Object.keys(m.answered || {}).length;
  res.json({
    answered: answeredCount,
    total: questions.total,
    starters: questions.starters.map((qid) => ({ id: qid, level: questions.get(qid).level, title: questions.levels[questions.get(qid).level - 1].title, done: !!m.answered[qid] })),
    startersDone: questions.starters.every((qid) => m.answered[qid]),
    next: next ? { id: next.id, text: next.text, level: next.level, levelTitle: next.levelTitle, kind: next.kind, items: next.items || null } : null,
    nextAt: next ? null : questions.nextAt(m, config.nextEveryDays),
    reading: (m.pending || []).length,
    readFailed: (m.readFailed || []).map((qid) => ({ id: qid, text: (questions.get(qid) || {}).text || '' })),
    profileReady: answeredCount > 0 && !!m.profileAt,
    stories: { publishable: m.stories.filter((s) => s.tier === 'P').length, total: m.stories.length },
    ideas: { count: m.ideas.length, job: jobState(m, id, 'ideas') },
    photo: !!m.photo,
    followUps: Object.keys(m.followUps || {}).length,
  });
}));

/* ---- questions and answers ------------------------------------------------------- */

router.get('/api/questions', wrap(async (req, res) => {
  const m = await getMember(req.memberId);
  const open = questions.unlocked(m, config.nextEveryDays);
  res.json({
    levels: questions.levels.map((l) => ({
      n: l.n,
      title: l.title,
      questions: l.questions.map((q) => ({
        id: q.id,
        text: q.text,
        kind: q.kind,
        items: q.items || null,
        starter: q.id === l.starter,
        open: open.has(q.id),
        answeredAt: m.answered[q.id] || null,
        followUp: (m.followUps || {})[q.id] || null,
      })),
    })),
  });
}));

router.get('/api/answers/:qid', wrap(async (req, res) => {
  const q = questions.get(req.params.qid);
  if (!q) return res.status(404).json({ error: 'Not found.' });
  const a = await store.getJson(ANSWER(req.memberId, q.id), null);
  const m = await getMember(req.memberId);
  res.json({ question: { id: q.id, text: q.text, level: q.level, levelTitle: q.levelTitle, kind: q.kind, items: q.items || null }, answer: a ? { text: a.text, source: a.source, at: a.at } : null, followUp: (m.followUps || {})[q.id] || null });
}));

router.post('/api/answers', wrap(async (req, res) => {
  const id = req.memberId;
  const q = questions.get(clip(req.body && req.body.qid, 40));
  if (!q) throw userError('That question was not found.');
  const text = clip(req.body.text, config.maxAnswerChars);
  if (text.length < 2) throw userError('Write or record your answer first.');
  const m = await getMember(id);
  if (!questions.unlocked(m, config.nextEveryDays).has(q.id)) throw userError('That question is not open yet.');
  await spend(id, 'answers');

  const now = new Date().toISOString();
  await store.update(ANSWER(id, q.id), null, (a) => {
    const history = a ? [{ text: a.text, at: a.at }, ...(a.history || [])].slice(0, 3) : [];
    return { qid: q.id, text, source: req.body.source === 'audio' ? 'audio' : 'typed', at: now, history };
  });
  await updateMember(id, (mm) => {
    mm.answered[q.id] = now;
    if (!mm.startersDoneAt && questions.starters.every((s) => mm.answered[s])) mm.startersDoneAt = now;
    mm.pending = [...new Set([...(mm.pending || []), q.id])];
    delete mm.followUps[q.id];
    return mm;
  });
  queueAbsorb(id, q.id);
  res.json({ ok: true });
}));

/* Raw audio in, text out. Nothing is stored: the member checks the text and
   saves it as their answer, and the recording is gone. */
const AUDIO_FORMATS = {
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav',
  'audio/ogg': 'ogg', 'audio/flac': 'flac', 'audio/x-flac': 'flac', 'audio/aac': 'aac',
  'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/m4a': 'm4a', 'audio/aiff': 'aiff', 'audio/x-aiff': 'aiff',
};
router.post(
  '/api/transcribe',
  express.raw({ type: () => true, limit: config.maxAudioBytes }),
  wrap(async (req, res) => {
    const id = req.memberId;
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const format = AUDIO_FORMATS[type];
    if (!format) throw userError('Please use an MP3, M4A, WAV, OGG, FLAC or AAC recording.', 415);
    if (!Buffer.isBuffer(req.body) || req.body.length < 1000) throw userError('That recording is empty.');
    /* Minutes as the page measured them, never less than a size estimate. */
    const said = Number(req.query.seconds) || 0;
    const minutes = Math.max(1, Math.ceil(Math.max(said / 60, req.body.length / (1024 * 1024))));
    if (minutes > config.maxAudioMinutes) throw userError('Recordings can be up to ' + config.maxAudioMinutes + ' minutes. Please split it into parts.', 413);
    await spend(id, 'audioMinutes', minutes);
    const usage = {};
    try {
      const text = await engine.transcribe(req.body, format, usage);
      res.json({ ok: true, text });
    } finally {
      await addCost(usage, 'transcribe ' + minutes + ' min');
    }
  })
);

/* ---- identity profile and story bank ------------------------------------------------ */

router.get('/api/profile', wrap(async (req, res) => {
  const m = await getMember(req.memberId);
  res.json({
    profile: m.profile || {},
    fields: engine.PROFILE_FIELDS,
    listFields: engine.LIST_FIELDS,
    locked: m.locked || [],
    stories: (m.stories || []).map((s) => ({ id: s.id, title: s.title, theme: s.theme, summary: s.summary, tier: s.tier, tierBy: s.tierBy, from: s.from })),
    confirm: m.confirm || [],
    reading: (m.pending || []).length,
    updatedAt: m.profileAt || null,
  });
}));

router.post('/api/profile', wrap(async (req, res) => {
  const field = clip(req.body && req.body.field, 40);
  if (!engine.PROFILE_FIELDS[field]) throw userError('Unknown field.');
  const isList = engine.LIST_FIELDS.includes(field);
  const raw = req.body.value;
  const value = isList
    ? (Array.isArray(raw) ? raw : String(raw || '').split('\n')).map((v) => clip(String(v), 300)).filter(Boolean).slice(0, 30)
    : clip(String(raw || ''), 2000);
  await updateMember(req.memberId, (m) => {
    m.profile[field] = value;
    if (!m.locked.includes(field)) m.locked.push(field);
    return m;
  });
  res.json({ ok: true });
}));

router.post('/api/confirm/clear', wrap(async (req, res) => {
  const item = clip(req.body && req.body.item, 400);
  await updateMember(req.memberId, (m) => {
    m.confirm = (m.confirm || []).filter((c) => c !== item);
    return m;
  });
  res.json({ ok: true });
}));

router.post('/api/stories/:sid', wrap(async (req, res) => {
  const tier = req.body && req.body.tier;
  const remove = req.body && req.body.remove === true;
  if (!remove && !['P', 'A', 'X'].includes(tier)) throw userError('Choose publishable, ask first or private.');
  let found = false;
  await updateMember(req.memberId, (m) => {
    const s = m.stories.find((x) => x.id === req.params.sid);
    if (s) {
      found = true;
      if (remove) m.stories = m.stories.filter((x) => x.id !== s.id);
      else {
        s.tier = tier;
        s.tierBy = 'member';
      }
    }
    return m;
  });
  if (!found) return res.status(404).json({ error: 'Not found.' });
  res.json({ ok: true });
}));

/* ---- writing rules ---------------------------------------------------------------- */

router.get('/api/rules', wrap(async (req, res) => {
  const m = await getMember(req.memberId);
  res.json({ defaults: rules.DEFAULT_RULES, own: m.rules || { text: '', phrases: [] } });
}));

router.post('/api/rules', wrap(async (req, res) => {
  const text = clip(req.body && req.body.text, 6000);
  const phrases = (Array.isArray(req.body.phrases) ? req.body.phrases : String(req.body.phrases || '').split('\n'))
    .map((p) => clip(String(p), 80))
    .filter((p) => p.length >= 2)
    .slice(0, 100);
  await updateMember(req.memberId, (m) => {
    m.rules = { text, phrases };
    return m;
  });
  res.json({ ok: true });
}));

/* ---- ideas and content packs ------------------------------------------------------------ */

function publicIdea(memberId, m, i) {
  const pack = jobState({ jobs: i.jobs || {} }, memberId, 'pack:' + i.id) || (i.packed ? { status: 'ready' } : null);
  const cover = jobState({ jobs: i.jobs || {} }, memberId, 'cover:' + i.id) || (i.covered ? { status: 'ready' } : null);
  return { id: i.id, topic: i.topic, angle: i.angle, goal: i.goal, format: i.format || '', why: i.why, posted: i.posted || [], story: i.storyId ? (m.stories.find((s) => s.id === i.storyId) || {}).title || null : null, createdAt: i.createdAt, pack, cover };
}

router.get('/api/ideas', wrap(async (req, res) => {
  const m = await getMember(req.memberId);
  res.json({ ideas: m.ideas.map((i) => publicIdea(req.memberId, m, i)), job: jobState(m, req.memberId, 'ideas') });
}));

router.post('/api/ideas', wrap(async (req, res) => {
  const id = req.memberId;
  const m = await getMember(id);
  if (!m.profileAt) throw userError('Answer a few questions first: ideas come from your answers.');
  if (isActive(id, 'ideas')) return res.status(202).json({ ok: true });
  await spend(id, 'ideas');
  await updateMember(id, (mm) => {
    mm.jobs.ideas = { status: 'running', at: new Date().toISOString() };
    return mm;
  });
  runJob(id, 'ideas', async () => {
    const usage = {};
    try {
      const fresh = await getMember(id);
      const list = await engine.ideas({ profile: fresh.profile, stories: fresh.stories, existing: fresh.ideas.map((i) => i.topic), insights: fresh.insights, count: 6, usage });
      await updateMember(id, (mm) => {
        const now = new Date().toISOString();
        mm.ideas = [...list.map((i) => ({ id: newId(), ...i, createdAt: now, jobs: {} })), ...mm.ideas].slice(0, 120);
        mm.jobs.ideas = { status: 'ready', at: now };
        return mm;
      });
    } catch (err) {
      await updateMember(id, (mm) => {
        mm.jobs.ideas = { status: 'failed', error: 'The ideas could not be written. Please try again.' };
        return mm;
      });
      throw err;
    } finally {
      await addCost(usage, 'ideas');
    }
  });
  res.status(202).json({ ok: true });
}));

router.get('/api/ideas/:iid', wrap(async (req, res) => {
  const m = await getMember(req.memberId);
  const i = m.ideas.find((x) => x.id === req.params.iid);
  if (!i) return res.status(404).json({ error: 'Not found.' });
  const pack = i.packed ? await store.getJson(PACK(req.memberId, i.id), null) : null;
  res.json({ idea: publicIdea(req.memberId, m, i), content: pack });
}));

async function setIdeaJob(memberId, iid, key, value, extra) {
  await updateMember(memberId, (m) => {
    const i = m.ideas.find((x) => x.id === iid);
    if (i) {
      i.jobs = i.jobs || {};
      i.jobs[key] = value;
      Object.assign(i, extra || {});
    }
    return m;
  });
}

router.post('/api/ideas/:iid/pack', wrap(async (req, res) => {
  const id = req.memberId;
  const m = await getMember(id);
  const idea = m.ideas.find((x) => x.id === req.params.iid);
  if (!idea) return res.status(404).json({ error: 'Not found.' });
  const key = 'pack:' + idea.id;
  if (isActive(id, key)) return res.status(202).json({ ok: true });
  await spend(id, 'packs');
  await setIdeaJob(id, idea.id, key, { status: 'running', at: new Date().toISOString() });
  runJob(id, key, async () => {
    const usage = {};
    try {
      const fresh = await getMember(id);
      const i = fresh.ideas.find((x) => x.id === idea.id);
      const story = i.storyId ? fresh.stories.find((s) => s.id === i.storyId && s.tier === 'P') : null;
      const content = await engine.pack({ profile: fresh.profile, story, idea: i, memberRules: fresh.rules, usage });
      await store.putJson(PACK(id, idea.id), { ...content, at: new Date().toISOString() });
      await setIdeaJob(id, idea.id, key, { status: 'ready' }, { packed: true });
    } catch (err) {
      await setIdeaJob(id, idea.id, key, { status: 'failed', error: 'The content could not be written. Please try again.' });
      throw err;
    } finally {
      await addCost(usage, 'content pack');
    }
  });
  res.status(202).json({ ok: true });
}));

router.post('/api/ideas/:iid/cover', wrap(async (req, res) => {
  const id = req.memberId;
  const m = await getMember(id);
  const idea = m.ideas.find((x) => x.id === req.params.iid);
  if (!idea) return res.status(404).json({ error: 'Not found.' });
  if (!idea.packed) throw userError('Write the content first: the cover follows from it.');
  const key = 'cover:' + idea.id;
  if (isActive(id, key)) return res.status(202).json({ ok: true });
  await spend(id, 'covers');
  await setIdeaJob(id, idea.id, key, { status: 'running', at: new Date().toISOString() });
  runJob(id, key, async () => {
    const usage = {};
    try {
      const pack = await store.getJson(PACK(id, idea.id), null);
      const fresh = await getMember(id);
      let photo = null;
      if (fresh.photo) {
        const data = await store.get(PHOTO(id));
        if (data) photo = { type: fresh.photo.type, data };
      }
      const img = await engine.cover({ scene: (pack && pack.cover && pack.cover.scene) || idea.angle, photo, usage });
      await store.put(COVER(id, idea.id), img.data, 'application/octet-stream');
      await setIdeaJob(id, idea.id, key, { status: 'ready' }, { covered: true, coverType: img.type, coverAt: new Date().toISOString() });
    } catch (err) {
      await setIdeaJob(id, idea.id, key, { status: 'failed', error: 'The cover could not be drawn. Please try again.' });
      throw err;
    } finally {
      await addCost(usage, 'cover');
    }
  });
  res.status(202).json({ ok: true });
}));

router.get('/api/ideas/:iid/cover', wrap(async (req, res) => {
  const m = await getMember(req.memberId);
  const idea = m.ideas.find((x) => x.id === req.params.iid);
  if (!idea || !idea.covered) return res.status(404).json({ error: 'Not found.' });
  const data = await store.get(COVER(req.memberId, idea.id));
  if (!data) return res.status(404).json({ error: 'Not found.' });
  res.setHeader('Content-Type', idea.coverType || 'image/png');
  res.send(data);
}));

router.post('/api/ideas/:iid/delete', wrap(async (req, res) => {
  const id = req.memberId;
  const iid = req.params.iid;
  if (isActive(id, 'pack:' + iid) || isActive(id, 'cover:' + iid)) throw userError('This idea is still being worked on. Delete it once it finishes.', 409);
  await updateMember(id, (m) => {
    m.ideas = m.ideas.filter((x) => x.id !== iid);
    return m;
  });
  await store.del(PACK(id, iid)).catch(() => {});
  await store.del(COVER(id, iid)).catch(() => {});
  res.json({ ok: true });
}));

/* ---- results: their accounts, what was posted, and the views ---------------------------------- */

const PLATFORMS = ['youtube', 'instagram', 'tiktok'];
const SOCIAL = ['instagram', 'tiktok'];
const NAMES = { youtube: 'YouTube', instagram: 'Instagram', tiktok: 'TikTok' };
const REFRESH_EVERY = 6 * 3600 * 1000; // YouTube data is re-read when older than this
const REFRESH_FLOOR = 30 * 60 * 1000; // and never more often than this per member (also Instagram, TikTok)
const NEW_POST_DAYS = 30; // a posted link not found in the account yet is looked for this long

const avg = (list) => (list.length ? Math.round(list.reduce((n, x) => n + x, 0) / list.length) : null);
const socialKey = (pf) => 'social_' + pf;
const postKey = (p) => p.videoId || p.postId || social.postId(p.platform, p.url);

function comparison(m) {
  const posted = [];
  for (const i of m.ideas || []) for (const p of i.posted || []) posted.push({ ...p, ideaId: i.id });
  const out = {};
  /* Per platform: videos made here against the account's other videos (Shorts
     against Shorts on YouTube when there are any). Without a connected account,
     the usual views the member typed. */
  for (const pf of PLATFORMS) {
    const acct = (m.channels || {})[pf];
    const mine = posted.filter((p) => p.platform === pf && typeof p.views === 'number');
    if (!acct && !mine.length) continue;
    const ids = new Set(mine.map(postKey).filter(Boolean));
    const others = ((acct && acct.videos) || []).filter((v) => !ids.has(v.id) && v.views > 0);
    let base = others;
    let what = pf === 'instagram' ? 'your other Reels' : 'your other videos';
    if (pf === 'youtube') {
      const shorts = others.filter((v) => v.short);
      if (shorts.length >= 3) {
        base = shorts;
        what = 'your other Shorts';
      }
    }
    let before = { n: base.length, avg: avg(base.map((v) => v.views)), what };
    if (!base.length && acct && acct.baseline) before = { n: null, avg: acct.baseline, what: 'your usual views' };
    out[pf] = { madeHere: { n: mine.length, avg: avg(mine.map((p) => p.views)) }, before };
  }
  return out;
}

/* Re-read the YouTube channel and the views of posted YouTube videos. */
async function refreshYoutube(id, force) {
  const m = await getMember(id);
  const last = m.resultsAt ? Date.parse(m.resultsAt) : 0;
  if (!force && Date.now() - last < REFRESH_EVERY) return;
  if (Date.now() - last < REFRESH_FLOOR) return;
  await updateMember(id, (mm) => {
    mm.resultsAt = new Date().toISOString();
    return mm;
  });
  let ch = null;
  const yt = (m.channels || {}).youtube;
  if (yt && yt.channelId) ch = await channels.channel(yt.channelId).catch(() => null);
  const views = {};
  for (const i of m.ideas || []) {
    for (const p of i.posted || []) {
      if (p.platform !== 'youtube' || !p.videoId) continue;
      const fromFeed = ch && ch.videos.find((v) => v.id === p.videoId);
      const v = fromFeed ? { views: fromFeed.views } : await channels.videoViews(p.videoId).catch(() => null);
      if (v) views[p.videoId] = v.views;
    }
  }
  await updateMember(id, (mm) => {
    if (ch && mm.channels && mm.channels.youtube) Object.assign(mm.channels.youtube, { title: ch.title, videos: ch.videos, fetchedAt: new Date().toISOString(), source: ch.source });
    for (const i of mm.ideas || []) for (const p of i.posted || []) {
      if (p.videoId && views[p.videoId] != null) {
        p.views = views[p.videoId];
        p.viewsAt = new Date().toISOString();
        p.source = 'read';
      }
    }
    return mm;
  });
}

/* Posted Reels / TikToks found in what was read get their views from it. */
function applyReadViews(m, platform, videos) {
  const byId = new Map(videos.map((v) => [v.id, v]));
  for (const i of m.ideas || []) {
    for (const p of i.posted || []) {
      if (p.platform !== platform) continue;
      const v = byId.get(postKey(p));
      if (!v) continue;
      Object.assign(p, { views: v.views, likes: v.likes, comments: v.comments, viewsAt: new Date().toISOString(), source: 'read' });
      delete p.manual;
    }
  }
}

/* Read a connected Instagram / TikTok account in the background (15-40 s).
   A refresh reads only the newest videos and keeps the older ones. */
function startSocialRead(id, platform, handle, refresh) {
  const key = socialKey(platform);
  return runJob(id, key, async () => {
    const usage = {};
    try {
      const acct = await social.read(platform, handle, refresh ? config.social.refreshVideos : config.social.videosPerRead);
      usage.cost_usd = acct.costUsd;
      await updateMember(id, (mm) => {
        const prev = (mm.channels || {})[platform];
        if (!prev || prev.handle !== handle) return mm; // changed or removed meanwhile
        const fresh = new Set(acct.videos.map((v) => v.id));
        const videos = refresh ? acct.videos.concat((prev.videos || []).filter((v) => !fresh.has(v.id))).slice(0, 30) : acct.videos;
        Object.assign(prev, { title: acct.title, followers: acct.followers || prev.followers || null, videos, fetchedAt: new Date().toISOString() });
        applyReadViews(mm, platform, acct.videos);
        mm.jobs[key] = { status: 'ready', at: new Date().toISOString() };
        return mm;
      });
    } catch (err) {
      await updateMember(id, (mm) => {
        mm.jobs[key] = {
          status: 'failed',
          error: err.userFacing ? err.message : 'We could not read @' + handle + ' on ' + NAMES[platform] + ' just now. Please try again later.',
        };
        return mm;
      });
      if (!err.userFacing) throw err;
    } finally {
      await addCost(usage, NAMES[platform] + ' read');
    }
  });
}

/* Re-read a connected account when its numbers are old, or when a link the
   member posted is not in it yet. Counted in the daily reads; quietly skipped
   past the limit. */
async function refreshSocial(id, m) {
  if (!social.available()) return;
  for (const pf of SOCIAL) {
    const acct = (m.channels || {})[pf];
    if (!acct || !acct.handle || isActive(id, socialKey(pf))) continue;
    const tried = acct.triedAt ? Date.parse(acct.triedAt) : 0;
    if (Date.now() - tried < REFRESH_FLOOR) continue;
    const fetched = acct.fetchedAt ? Date.parse(acct.fetchedAt) : 0;
    const stale = Date.now() - fetched > config.social.refreshHours * 3600 * 1000;
    const known = new Set((acct.videos || []).map((v) => v.id));
    const waiting = (m.ideas || []).some((i) =>
      (i.posted || []).some((p) => p.platform === pf && p.source !== 'read' && Date.now() - Date.parse(p.at) < NEW_POST_DAYS * 86400000 && !known.has(postKey(p)))
    );
    if (!stale && !waiting) continue;
    try {
      await spend(id, 'socialReads');
    } catch {
      continue;
    }
    await updateMember(id, (mm) => {
      const a = (mm.channels || {})[pf];
      if (a) a.triedAt = new Date().toISOString();
      mm.jobs[socialKey(pf)] = { status: 'running', at: new Date().toISOString() };
      return mm;
    });
    startSocialRead(id, pf, acct.handle, (acct.videos || []).length > 0);
  }
}

function publicAccount(a) {
  if (!a) return null;
  return {
    handle: a.handle || null,
    url: a.url || null,
    baseline: a.baseline == null ? null : a.baseline,
    title: a.title || null,
    followers: a.followers || null,
    fetchedAt: a.fetchedAt || null,
    videos: (a.videos || []).slice(0, 50),
  };
}

router.get('/api/results', wrap(async (req, res) => {
  const id = req.memberId;
  await refreshYoutube(id, false).catch((err) => console.warn('[agency] youtube refresh failed: %s', err.message));
  await refreshSocial(id, await getMember(id)).catch((err) => console.warn('[agency] social refresh failed: %s', err.message));
  const m = await getMember(id);
  const yt = (m.channels || {}).youtube || null;
  res.json({
    youtube: yt ? { input: yt.input, title: yt.title, fetchedAt: yt.fetchedAt, source: yt.source, videos: (yt.videos || []).slice(0, 50) } : null,
    instagram: publicAccount((m.channels || {}).instagram),
    tiktok: publicAccount((m.channels || {}).tiktok),
    socialAvailable: social.available(),
    socialJobs: { instagram: jobState(m, id, socialKey('instagram')), tiktok: jobState(m, id, socialKey('tiktok')) },
    insights: m.insights || null,
    insightsJob: jobState(m, id, 'insights'),
    posted: (m.ideas || [])
      .filter((i) => (i.posted || []).length)
      .map((i) => ({ ideaId: i.id, topic: i.topic, posts: i.posted })),
    compare: comparison(m),
    refreshedAt: m.resultsAt || null,
  });
}));

router.post('/api/channels', wrap(async (req, res) => {
  const id = req.memberId;
  const platform = req.body && req.body.platform;
  if (!PLATFORMS.includes(platform)) throw userError('Choose YouTube, Instagram or TikTok.');
  if (platform === 'youtube') {
    const input = clip(req.body.input, 300);
    if (!input) throw userError('Enter your YouTube @handle or channel link.');
    const ch = await channels.channel(input);
    await updateMember(id, (m) => {
      m.channels = m.channels || {};
      m.channels.youtube = { input, channelId: ch.channelId, title: ch.title, videos: ch.videos, source: ch.source, fetchedAt: new Date().toISOString() };
      m.resultsAt = new Date().toISOString();
      return m;
    });
    return res.json({ ok: true, title: ch.title, videos: ch.videos.length });
  }
  const baseline = req.body.baseline === '' || req.body.baseline == null ? null : Math.max(0, Math.round(Number(req.body.baseline)));
  if (baseline !== null && !Number.isFinite(baseline)) throw userError('Usual views must be a number.');

  /* Instagram / TikTok by @handle: read in the background. */
  const handleInput = clip(req.body.handle, 300);
  if (handleInput) {
    if (!social.available()) throw userError('Reading ' + NAMES[platform] + ' is not switched on yet. Type your usual views instead.', 503);
    const handle = social.parseHandle(platform, handleInput);
    if (!handle) throw userError('That does not look like an ' + NAMES[platform] + ' @handle. Type it like @yourname.');
    const key = socialKey(platform);
    if (isActive(id, key)) return res.status(202).json({ ok: true, handle });
    await spend(id, 'socialReads');
    await updateMember(id, (m) => {
      m.channels = m.channels || {};
      const prev = m.channels[platform] || {};
      const same = prev.handle === handle;
      m.channels[platform] = {
        handle,
        url: platform === 'instagram' ? 'https://www.instagram.com/' + handle + '/' : 'https://www.tiktok.com/@' + handle,
        baseline: baseline !== null ? baseline : prev.baseline == null ? null : prev.baseline,
        title: same ? prev.title : null,
        followers: same ? prev.followers : null,
        videos: same ? prev.videos || [] : [],
        fetchedAt: same ? prev.fetchedAt : null,
        triedAt: new Date().toISOString(),
      };
      m.jobs[key] = { status: 'running', at: new Date().toISOString() };
      return m;
    });
    startSocialRead(id, platform, handle, false);
    return res.status(202).json({ ok: true, handle });
  }

  /* Without a handle: the profile link and usual views, typed. */
  const url = clip(req.body.url, 300);
  if (url && !/^https:\/\/(www\.)?(instagram\.com|tiktok\.com)\//i.test(url)) throw userError('That does not look like an Instagram or TikTok profile link.');
  await updateMember(id, (m) => {
    m.channels = m.channels || {};
    const prev = m.channels[platform] || {};
    m.channels[platform] = { ...prev, url: url || prev.url || null, baseline };
    return m;
  });
  res.json({ ok: true });
}));

router.post('/api/channels/:platform/delete', wrap(async (req, res) => {
  if (!PLATFORMS.includes(req.params.platform)) return res.status(404).json({ error: 'Not found.' });
  await updateMember(req.memberId, (m) => {
    const had = m.channels && m.channels[req.params.platform];
    if (m.channels) delete m.channels[req.params.platform];
    delete m.jobs[socialKey(req.params.platform)];
    /* The analysis was made from this account's videos. */
    if (had && (had.videos || []).length) m.insights = null;
    return m;
  });
  res.json({ ok: true });
}));

router.post('/api/results/refresh', wrap(async (req, res) => {
  await refreshYoutube(req.memberId, true);
  res.json({ ok: true });
}));

const withVideos = (m) => PLATFORMS.map((pf) => ({ platform: pf, ...((m.channels || {})[pf] || {}) })).filter((a) => (a.videos || []).length);

router.post('/api/insights', wrap(async (req, res) => {
  const id = req.memberId;
  const m = await getMember(id);
  if (!withVideos(m).length) throw userError('Connect an account with some videos first.');
  if (isActive(id, 'insights')) return res.status(202).json({ ok: true });
  await spend(id, 'insights');
  await updateMember(id, (mm) => {
    mm.jobs.insights = { status: 'running', at: new Date().toISOString() };
    return mm;
  });
  runJob(id, 'insights', async () => {
    const usage = {};
    try {
      const fresh = await getMember(id);
      const accounts = withVideos(fresh);
      const out = await engine.insights({ accounts, profile: fresh.profile, usage });
      await updateMember(id, (mm) => {
        mm.insights = {
          ...out,
          at: new Date().toISOString(),
          videos: accounts.reduce((n, a) => n + a.videos.length, 0),
          platforms: accounts.map((a) => a.platform),
        };
        mm.jobs.insights = { status: 'ready', at: new Date().toISOString() };
        return mm;
      });
    } catch (err) {
      await updateMember(id, (mm) => {
        mm.jobs.insights = { status: 'failed', error: 'The analysis could not be written. Please try again.' };
        return mm;
      });
      throw err;
    } finally {
      await addCost(usage, 'account insights');
    }
  });
  res.status(202).json({ ok: true });
}));

/* Mark a content pack as posted on a platform, with its link. Views are read
   automatically (YouTube from the video, Instagram and TikTok from the
   connected account); otherwise the member types them or adds a screenshot. */
router.post('/api/ideas/:iid/posted', wrap(async (req, res) => {
  const id = req.memberId;
  const platform = req.body && req.body.platform;
  if (!PLATFORMS.includes(platform)) throw userError('Choose YouTube, Instagram or TikTok.');
  const url = clip(req.body.url, 400);
  const patterns = { youtube: /^https:\/\/(www\.|m\.)?(youtube\.com|youtu\.be)\//i, instagram: /^https:\/\/(www\.)?instagram\.com\//i, tiktok: /^https:\/\/(www\.|vm\.|vt\.|m\.)?tiktok\.com\//i };
  if (!patterns[platform].test(url)) throw userError('Paste the link to the post on ' + NAMES[platform] + '.');
  const m = await getMember(id);
  const idea = m.ideas.find((x) => x.id === req.params.iid);
  if (!idea) return res.status(404).json({ error: 'Not found.' });
  const prev = (idea.posted || []).find((p) => p.platform === platform);
  const entry = { platform, url, at: prev && prev.url === url ? prev.at : new Date().toISOString(), views: null, viewsAt: null };
  if (prev && prev.url === url && prev.stats) Object.assign(entry, { stats: prev.stats, statsAt: prev.statsAt });
  let reading = false;
  if (platform === 'youtube') {
    entry.videoId = channels.videoIdFrom(url);
    if (!entry.videoId) throw userError('That YouTube link has no video in it.');
    const v = await channels.videoViews(entry.videoId).catch(() => null);
    if (v) Object.assign(entry, { views: v.views, viewsAt: new Date().toISOString(), source: 'read' });
  } else {
    entry.postId = await social.resolvePostId(platform, url);
    if (!entry.postId) throw userError('That link does not point to one ' + (platform === 'instagram' ? 'Reel or post' : 'video') + '. Open the post, tap Share, Copy link, and paste it here.');
    const acct = (m.channels || {})[platform];
    const found = acct && (acct.videos || []).find((v) => v.id === entry.postId);
    if (found) {
      Object.assign(entry, { views: found.views, likes: found.likes, comments: found.comments, viewsAt: acct.fetchedAt, source: 'read' });
    } else if (req.body.views !== undefined && req.body.views !== '' && req.body.views !== null) {
      const n = Math.round(Number(req.body.views));
      if (!Number.isFinite(n) || n < 0) throw userError('Views must be a number.');
      Object.assign(entry, { views: n, viewsAt: new Date().toISOString(), source: 'typed' });
    } else if (entry.stats && entry.stats.views != null) {
      Object.assign(entry, { views: entry.stats.views, viewsAt: entry.statsAt, source: 'screenshot' });
    }
    reading = !found && !!(acct && acct.handle && social.available());
  }
  await updateMember(id, (mm) => {
    const i = mm.ideas.find((x) => x.id === req.params.iid);
    if (i) i.posted = [...(i.posted || []).filter((p) => p.platform !== platform), entry];
    return mm;
  });
  /* A new post is not in the account's last read: look for it now. */
  if (reading) await refreshSocial(id, await getMember(id)).catch(() => {});
  res.json({ ok: true, views: entry.views, source: entry.source || null, reading: reading && isActive(id, socialKey(platform)) });
}));

router.post('/api/ideas/:iid/posted/delete', wrap(async (req, res) => {
  const platform = req.body && req.body.platform;
  await updateMember(req.memberId, (m) => {
    const i = m.ideas.find((x) => x.id === req.params.iid);
    if (i) i.posted = (i.posted || []).filter((p) => p.platform !== platform);
    return m;
  });
  res.json({ ok: true });
}));

/* A screenshot of the post's Insights / Analytics screen: a cheap vision model
   reads the numbers off it (views, reach, watch time, ...). The picture is
   not kept. */
router.post(
  '/api/ideas/:iid/posted/screenshot',
  express.raw({ type: () => true, limit: config.maxScreenshotBytes }),
  wrap(async (req, res) => {
    const id = req.memberId;
    const platform = String(req.query.platform || '');
    if (!PLATFORMS.includes(platform)) throw userError('Choose YouTube, Instagram or TikTok.');
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!IMAGE_TYPES.includes(type)) throw userError('Please use a screenshot (PNG, JPG or WebP).', 415);
    if (!Buffer.isBuffer(req.body) || req.body.length < 1000) throw userError('That picture is empty.');
    const m = await getMember(id);
    const idea = m.ideas.find((x) => x.id === req.params.iid);
    if (!idea) return res.status(404).json({ error: 'Not found.' });
    if (!(idea.posted || []).some((p) => p.platform === platform)) throw userError('Save the link to the post first.');
    await spend(id, 'screenshots');
    const usage = {};
    let read;
    try {
      read = await engine.readScreenshot({ image: { type, data: req.body }, usage });
    } catch (err) {
      console.error('[agency] screenshot read failed: %s', err.message);
      throw userError('We could not read that screenshot just now. Please try again.', 502);
    } finally {
      await addCost(usage, 'screenshot');
    }
    if (!read.isAnalytics) throw userError('We found no numbers on that picture. Open the post\'s Insights (Instagram) or Analytics (TikTok, YouTube Studio) and take a screenshot of that screen.', 422);
    let entry = null;
    await updateMember(id, (mm) => {
      const i = mm.ideas.find((x) => x.id === req.params.iid);
      const p = i && (i.posted || []).find((x) => x.platform === platform);
      if (!p) return mm;
      p.stats = read.stats;
      p.statsAt = new Date().toISOString();
      /* Views read from the platform stay; otherwise the screenshot's count it. */
      if (p.source !== 'read' && read.stats.views != null) Object.assign(p, { views: read.stats.views, viewsAt: p.statsAt, source: 'screenshot' });
      delete p.manual;
      entry = p;
      return mm;
    });
    res.json({ ok: true, stats: read.stats, views: entry ? entry.views : null, otherPlatform: read.platform && read.platform !== platform ? NAMES[read.platform] : null });
  })
);

/* ---- the member's photo, for covers ------------------------------------------------------- */

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
router.post(
  '/api/photo',
  express.raw({ type: () => true, limit: config.maxPhotoBytes }),
  wrap(async (req, res) => {
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!IMAGE_TYPES.includes(type)) throw userError('Please use a JPG, PNG or WebP photo.', 415);
    if (!Buffer.isBuffer(req.body) || req.body.length < 1000) throw userError('That photo is empty.');
    await store.put(PHOTO(req.memberId), req.body, 'application/octet-stream');
    await updateMember(req.memberId, (m) => {
      m.photo = { type, at: new Date().toISOString() };
      return m;
    });
    res.json({ ok: true });
  })
);

router.get('/api/photo', wrap(async (req, res) => {
  const m = await getMember(req.memberId);
  const data = m.photo ? await store.get(PHOTO(req.memberId)) : null;
  if (!data) return res.status(404).json({ error: 'No photo.' });
  res.setHeader('Content-Type', m.photo.type);
  res.send(data);
}));

router.post('/api/photo/delete', wrap(async (req, res) => {
  await store.del(PHOTO(req.memberId)).catch(() => {});
  await updateMember(req.memberId, (m) => {
    m.photo = null;
    return m;
  });
  res.json({ ok: true });
}));

/* ---- delete everything ----------------------------------------------------------------------- */

router.post('/api/delete-all', wrap(async (req, res) => {
  const id = req.memberId;
  if (req.body && req.body.confirm !== 'DELETE') throw userError('Type DELETE to confirm.');
  if (lanes.has(id)) throw userError('Something is still being worked on. Try again in a minute.', 409);
  const m = await getMember(id);
  for (const qid of Object.keys(m.answered || {})) await store.del(ANSWER(id, qid)).catch(() => {});
  for (const i of m.ideas || []) {
    await store.del(PACK(id, i.id)).catch(() => {});
    await store.del(COVER(id, i.id)).catch(() => {});
  }
  await store.del(PHOTO(id)).catch(() => {});
  await store.del(MEMBER(id)).catch(() => {});
  res.json({ ok: true });
}));

router.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

function boot() {
  if (!ready) {
    console.log('[agency] off%s', config.problems.length ? ': ' + config.problems.join(' ') : ' (YMA_ENABLED is not true)');
    return;
  }
  /* Answers saved but not read before a restart are picked up when their
     member next opens the page (GET /api/state). */
  console.log('[agency] ready  models=%s', JSON.stringify(config.models));
}

module.exports = { router, boot, ready };
