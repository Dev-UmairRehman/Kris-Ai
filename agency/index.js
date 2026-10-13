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
      const what = { answers: 'answers', audioMinutes: 'minutes of recordings', ideas: 'rounds of ideas', packs: 'content packs', covers: 'covers' }[kind];
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
  return { id: i.id, topic: i.topic, angle: i.angle, goal: i.goal, why: i.why, story: i.storyId ? (m.stories.find((s) => s.id === i.storyId) || {}).title || null : null, createdAt: i.createdAt, pack, cover };
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
      const list = await engine.ideas({ profile: fresh.profile, stories: fresh.stories, existing: fresh.ideas.map((i) => i.topic), count: 6, usage });
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
