'use strict';

/* ---------------------------------------------------------------------------
   Reports: creating them, running the pipeline, and who may see what.

   Pipeline for one report
     reading      resume text + public profile pages; Claude extracts a profile
     researching  Claude looks up local costs (web search); code runs the model
     writing      the narrative in eight parts and the article, in parallel
     rendering    both documents to PDF
     ready        stored, added to the library if the member shares, emailed

   The queue lives in this process and runs MP_CONCURRENCY reports at a time.
   Its contents are also kept in active.json, so a deploy or restart in the
   middle of a report picks it up again instead of losing it.

   Sharing: a member who opts in to sharing sees every other sharing member's
   documents, and their own appear in that library. A member who does not
   share sees only their own. Changing the choice applies to all their reports.
   --------------------------------------------------------------------------- */

const crypto = require('crypto');
const config = require('./config');
const store = require('./store');
const intake = require('./intake');
const writer = require('./writer');
const costs = require('./costs');
const render = require('./render');
const mailer = require('./mailer');
const llm = require('./llm');

const MEMBER = (id) => 'members/' + id + '.json';
const META = (id) => 'reports/' + id + '/meta.json';
const FILE = (id, name) => 'reports/' + id + '/' + name;

const DOCS = { narrative: 'narrative.pdf', article: 'article.pdf' };

/* ---- members ------------------------------------------------------------- */

async function getMember(memberId) {
  return store.getJson(MEMBER(memberId), null);
}

async function touchMember(memberId, email) {
  return store.update(MEMBER(memberId), null, (m) => {
    if (!m) return { email, sharing: false, reports: [], createdAt: new Date().toISOString() };
    if (email && m.email !== email) m.email = email;
    return m;
  });
}

/* ---- devices ----------------------------------------------------------------
   The email only says which account; it is not proof. Proof is a device key:
   a random secret the member's own browser creates the first time and keeps.
   Only its hash is stored here.

     - an account with no reports yet: the browser that arrives becomes its
       one device (any earlier device is dropped - there is nothing to protect
       yet, and the real owner can always take an empty account back);
     - an account with reports: only a linked device gets in. A new browser is
       added with a short-lived code shown on a linked one (linkDevice).

   So knowing - or faking - someone's email never shows their MasterPlans. */

const MAX_DEVICES = 10;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_TTL_MS = 15 * 60 * 1000;
const CODE_TRIES = 5;

function hashCode(code) {
  return crypto.createHash('sha256').update('mp-link:' + String(code).toUpperCase().replace(/[^A-Z0-9]/g, '')).digest('hex');
}

/** Which access does this device get? 'full' or 'link' (must link first). */
async function claimDevice(memberId, email, deviceHash) {
  let scope = 'link';
  await store.update(MEMBER(memberId), null, (m) => {
    m = m || { email, sharing: false, reports: [], createdAt: new Date().toISOString() };
    if (email && m.email !== email) m.email = email;
    const devices = m.devices || [];
    const known = devices.find((d) => d.h === deviceHash);
    if (known) {
      known.seen = new Date().toISOString();
      scope = 'full';
    } else if (!(m.reports || []).length) {
      m.devices = [{ h: deviceHash, at: new Date().toISOString() }];
      scope = 'full';
    }
    if (scope === 'full' && !m.devices) m.devices = devices;
    return m;
  });
  return scope;
}

async function hasDevice(memberId, deviceHash) {
  const m = await getMember(memberId);
  return !!(m && (m.devices || []).some((d) => d.h === deviceHash));
}

/** A one-time code, shown on a linked device, to add another one. */
async function newLinkCode(memberId) {
  const bytes = crypto.randomBytes(8);
  let code = '';
  for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
  const expiresAt = Date.now() + CODE_TTL_MS;
  await store.update(MEMBER(memberId), null, (m) => {
    if (!m) throw new Error('unknown member');
    m.linkCode = { h: hashCode(code), exp: expiresAt, tries: 0 };
    return m;
  });
  return { code: code.slice(0, 4) + '-' + code.slice(4), expiresAt: new Date(expiresAt).toISOString() };
}

/** Add this device with a code from a linked one. Returns true on success. */
async function linkDevice(memberId, deviceHash, code) {
  let ok = false;
  await store.update(MEMBER(memberId), null, (m) => {
    if (!m || !m.linkCode) return m;
    const lc = m.linkCode;
    if (Date.now() > lc.exp || lc.tries >= CODE_TRIES) {
      delete m.linkCode;
      return m;
    }
    const a = Buffer.from(hashCode(code));
    const b = Buffer.from(lc.h);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      const devices = (m.devices || []).filter((d) => d.h !== deviceHash);
      devices.push({ h: deviceHash, at: new Date().toISOString() });
      m.devices = devices.slice(-MAX_DEVICES);
      delete m.linkCode;
      ok = true;
    } else {
      lc.tries++;
      if (lc.tries >= CODE_TRIES) delete m.linkCode;
    }
    return m;
  });
  return ok;
}

async function setSharing(memberId, sharing) {
  const member = await store.update(MEMBER(memberId), null, (m) => {
    if (!m) throw new Error('unknown member');
    m.sharing = !!sharing;
    return m;
  });
  const metas = await Promise.all(member.reports.map((r) => store.getJson(META(r.id))));
  await store.update('shared.json', [], (list) => {
    const rest = list.filter((e) => e.memberId !== memberId);
    if (!member.sharing) return rest;
    for (const meta of metas) if (meta && meta.status === 'ready') rest.push(libraryEntry(meta));
    return rest.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  });
  return member;
}

function libraryEntry(meta) {
  return {
    id: meta.id,
    memberId: meta.memberId,
    name: meta.name,
    articleTitle: meta.docs.article ? meta.docs.article.title : '',
    createdAt: meta.createdAt,
  };
}

/* ---- limits ---------------------------------------------------------------- */

function today() {
  return new Date().toISOString().slice(0, 10);
}

/* Limits count creations, not the reports that still exist, so deleting a
   report does not free up another run. The member's creation times are kept
   on the member record; the store-wide daily count is kept in usage.json so a
   restart does not reset it. */
function recentCreations(member) {
  const since = Date.now() - 24 * 3600 * 1000;
  const log = member.created || (member.reports || []).map((r) => r.createdAt);
  return log.filter((t) => Date.parse(t) > since).length;
}

async function checkLimits(member) {
  if (recentCreations(member) >= config.perMemberPerDay) {
    return 'You can create ' + config.perMemberPerDay + ' MasterPlans a day. Please try again tomorrow.';
  }
  const usage = await store.getJson('usage.json', { day: today(), count: 0 });
  if (usage.day === today() && usage.count >= config.globalPerDay) {
    return 'The MasterPlan is busy today. Please try again tomorrow.';
  }
  return null;
}

async function countCreation() {
  await store.update('usage.json', { day: today(), count: 0 }, (u) =>
    u.day === today() ? { day: u.day, count: u.count + 1 } : { day: today(), count: 1 }
  );
}

/* ---- create -------------------------------------------------------------- */

/**
 * @param {object} p { memberId, email, form }  form is the validated request body
 */
async function createReport({ memberId, email, form }) {
  const member = await touchMember(memberId, email);
  const limited = await checkLimits(member);
  if (limited) throw Object.assign(new Error(limited), { userFacing: true, status: 429 });

  const resume = intake.readResume(form.resumeName, form.resumeBase64);

  const id = crypto.randomBytes(12).toString('base64url');
  const now = new Date().toISOString();
  const meta = {
    id,
    memberId,
    name: form.name || 'Your MasterPlan',
    status: 'queued',
    stage: 'queued',
    createdAt: now,
    updatedAt: now,
    docs: {},
    podcast: null,
  };
  const inputs = {
    name: form.name,
    pronouns: form.pronouns,
    city: form.city,
    region: form.region,
    postalCode: form.postalCode,
    country: form.country,
    links: form.links,
    pasted: form.pasted,
    resume,
  };

  await store.putJson(FILE(id, 'inputs.json'), inputs);
  await store.putJson(META(id), meta);
  const updated = await store.update(MEMBER(memberId), null, (m) => {
    /* Seed the creation log from the existing reports before adding this one,
       so this creation is counted exactly once. */
    m.created = (m.created || m.reports.map((r) => r.createdAt)).concat(now).slice(-50);
    m.reports.unshift({ id, createdAt: now });
    return m;
  });
  /* The sharing box on the form is the member's current choice. Going through
     setSharing keeps the Library in step with it (adding or removing the
     member's earlier reports), instead of flipping a flag behind its back. */
  if (typeof form.share === 'boolean' && form.share !== !!updated.sharing) {
    await setSharing(memberId, form.share);
  }
  await store.update('active.json', [], (list) => (list.includes(id) ? list : list.concat(id)));
  await countCreation();
  enqueue(id);
  return meta;
}

/* ---- queue ----------------------------------------------------------------- */

const queue = [];
let running = 0;
/* Reports this process is actually working on. A report marked "running" in
   storage but missing here was interrupted (a crash, a storage failure while
   recording the error) and is treated as failed so it can be retried. */
const inFlight = new Set();

function enqueue(id) {
  if (!queue.includes(id)) queue.push(id);
  pump();
}

function pump() {
  while (running < config.concurrency && queue.length) {
    const id = queue.shift();
    running++;
    inFlight.add(id);
    run(id)
      .catch((err) => console.error('[masterplan] job %s crashed: %s', id, err.stack || err))
      .finally(() => {
        inFlight.delete(id);
        running--;
        pump();
      });
  }
}

async function setMeta(id, patch) {
  return store.update(META(id), null, (m) => {
    if (!m) throw new Error('report vanished');
    Object.assign(m, patch, { updatedAt: new Date().toISOString() });
    return m;
  });
}

function monthYear(d) {
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}
function longDate(d) {
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/* Profile, cost research and the writing - everything that costs model
   calls. Returns what is saved as work.json. */
async function write(id, inputs, meta, now, usage, log) {
  const pages = await Promise.all((inputs.links || []).map((u) => intake.readProfilePage(u)));
  const profile = await writer.extractProfile(
    {
      name: inputs.name,
      pronouns: inputs.pronouns,
      city: inputs.city,
      region: inputs.region,
      postalCode: inputs.postalCode,
      country: inputs.country,
      today: longDate(now),
      resume: inputs.resume,
      social: { pages, pasted: inputs.pasted },
    },
    usage,
  );

  await setMeta(id, { stage: 'researching', name: profile.name || meta.name });
  const age =
    profile.age_estimate && profile.age_estimate.low
      ? (Number(profile.age_estimate.low) + Number(profile.age_estimate.high || profile.age_estimate.low)) / 2
      : null;
  const place = [inputs.city, inputs.region, inputs.postalCode].filter(Boolean).join(', ');
  const research = await costs.research(
    {
      place,
      country: inputs.country,
      today: longDate(now),
      role: profile.research_role || (profile.current_role && profile.current_role.title),
      employer: profile.current_role && profile.current_role.employer,
      seniority: profile.current_role && profile.current_role.level,
      age: age ? Math.round(age) : null,
      household: profile.household,
      hobbies: profile.hobbies_for_costing || profile.interests || [],
    },
    usage,
  );
  const model = costs.model(research, { age });

  const ctx = { profile, research, costs: model, month: monthYear(now), today: longDate(now) };
  const docs = await writer.writeDocuments(ctx, {
    usage,
    log,
    preparedBy: config.preparedBy,
    onStage: (stage) => setMeta(id, { stage }),
  });

  return {
    profile,
    research,
    figures: model.f,
    narrative: docs.narrative,
    article: docs.article,
    articleTitle: docs.articleTitle,
  };
}

async function run(id) {
  const started = Date.now();
  const meta = await store.getJson(META(id));
  if (!meta || meta.status === 'ready' || meta.status === 'deleted') {
    await store.update('active.json', [], (l) => l.filter((x) => x !== id));
    return;
  }
  const inputs = await store.getJson(FILE(id, 'inputs.json'));
  const usage = {};
  const warnings = [];
  const log = (msg) => {
    warnings.push(msg);
    console.warn('[masterplan] %s: %s', id, msg);
  };

  try {
    await setMeta(id, { status: 'running', stage: 'reading', error: null });
    const now = new Date();

    /* The writing is the expensive part, so its result is saved before
       rendering. A retry after a later failure renders from the saved drafts
       instead of paying for them again. */
    let work = await store.getJson(FILE(id, 'work.json'));
    if (!(work && work.narrative && work.article)) {
      work = await write(id, inputs, meta, now, usage, log);
      await store.putJson(FILE(id, 'work.json'), { ...work, warnings });
    } else {
      console.log('[masterplan] %s: re-rendering from saved drafts', id);
    }
    const { profile } = work;
    const docs = { narrative: work.narrative, article: work.article, articleTitle: work.articleTitle };

    await setMeta(id, { stage: 'rendering' });
    const narrativePdf = await render.toPdf(docs.narrative, {
      kind: 'narrative',
      title: profile.name + ' - The MasterPlan',
      footerText: profile.name + '   |   The MasterPlan',
      brandLine: config.brandLine,
    });
    const articlePdf = await render.toPdf(docs.article, {
      kind: 'article',
      title: docs.articleTitle,
      footerText: docs.articleTitle,
      brandLine: config.brandLine,
    });

    await store.put(FILE(id, DOCS.narrative), narrativePdf.buffer, 'application/pdf');
    await store.put(FILE(id, DOCS.article), articlePdf.buffer, 'application/pdf');

    const cost = llm.estimateCost(usage);
    const done = await setMeta(id, {
      status: 'ready',
      stage: 'ready',
      name: profile.name || meta.name,
      docs: {
        narrative: { title: 'The MasterPlan', pages: narrativePdf.pages, bytes: narrativePdf.buffer.length },
        article: { title: docs.articleTitle, pages: articlePdf.pages, bytes: articlePdf.buffer.length },
      },
      usage,
      costEstimateUsd: Math.round(cost * 100) / 100,
      seconds: Math.round((Date.now() - started) / 1000),
      warnings: warnings.length,
    });
    console.log(
      '[masterplan] %s ready in %ds, %d+%d pages, ~$%s',
      id,
      done.seconds,
      narrativePdf.pages,
      articlePdf.pages,
      done.costEstimateUsd,
    );

    const member = await getMember(done.memberId);
    if (member && member.sharing) {
      await store.update('shared.json', [], (list) => [libraryEntry(done)].concat(list.filter((e) => e.id !== id)));
    }
    if (member && member.email) {
      try {
        await mailer.sendReady({ to: member.email, name: done.name, articleTitle: docs.articleTitle, reportId: id });
      } catch (err) {
        console.error('[masterplan] %s email failed: %s', id, err.message);
      }
    }
  } catch (err) {
    console.error('[masterplan] %s failed: %s', id, err.stack || err);
    /* Recording the failure is retried once; if storage is down both times the
       report stays in active.json and is picked up again after a restart. */
    const failure = {
      status: 'failed',
      error:
        err instanceof llm.LlmError && err.code === 'refusal'
          ? 'The writer could not complete this MasterPlan from these documents.'
          : 'Something went wrong while writing your MasterPlan. You can try again.',
      usage,
    };
    let recorded = await setMeta(id, failure).then(() => true, () => false);
    if (!recorded) {
      await new Promise((r) => setTimeout(r, 2000));
      recorded = await setMeta(id, failure).then(() => true, () => false);
    }
    if (!recorded) {
      console.error('[masterplan] %s: could not record the failure; it will be retried after a restart', id);
      return;
    }
  }
  await store.update('active.json', [], (l) => l.filter((x) => x !== id)).catch(() => {});
}

/* A report that says running but that this process is not working on was
   interrupted. Show it as failed, so the member can retry or delete it. */
function effectiveStatus(meta) {
  if (meta && meta.status === 'running' && !inFlight.has(meta.id)) {
    return { ...meta, status: 'failed', error: 'This MasterPlan was interrupted. You can try again.' };
  }
  return meta;
}

async function retry(memberId, id) {
  const meta = effectiveStatus(await store.getJson(META(id)));
  if (!meta || meta.memberId !== memberId) return null;
  if (meta.status !== 'failed') return meta;
  if (queue.includes(id) || inFlight.has(id)) return meta;
  const updated = await setMeta(id, { status: 'queued', stage: 'queued', error: null });
  await store.update('active.json', [], (list) => (list.includes(id) ? list : list.concat(id)));
  enqueue(id);
  return updated;
}

/* ---- reading --------------------------------------------------------------- */

function publicMeta(meta, viewerId) {
  return {
    id: meta.id,
    name: meta.name,
    mine: meta.memberId === viewerId,
    status: meta.status,
    stage: meta.stage,
    error: meta.status === 'failed' ? meta.error : null,
    createdAt: meta.createdAt,
    docs: meta.docs,
    podcast: meta.podcast ? { ready: true } : null,
  };
}

async function listMine(memberId) {
  const member = await getMember(memberId);
  if (!member) return { sharing: false, reports: [] };
  const metas = await Promise.all(member.reports.map((r) => store.getJson(META(r.id))));
  return { sharing: !!member.sharing, reports: metas.filter(Boolean).map((m) => publicMeta(effectiveStatus(m), memberId)) };
}

/* The Library is a trade: members who have shared a finished MasterPlan of
   their own read the others. Sharing alone (with nothing in the Library) is
   not enough, so an empty account made up to look around sees nothing. */
async function contributes(memberId) {
  const list = await store.getJson('shared.json', []);
  return list.some((e) => e.memberId === memberId);
}

async function listLibrary(memberId) {
  const member = await getMember(memberId);
  if (!member || !member.sharing) return { sharing: false, reports: [] };
  const list = await store.getJson('shared.json', []);
  if (!list.some((e) => e.memberId === memberId)) return { sharing: true, waiting: true, reports: [] };
  return { sharing: true, reports: list.map((e) => ({ ...e, mine: e.memberId === memberId, memberId: undefined })) };
}

/** May this member open this report? Own reports always; others only while
    both sides share and the viewer has a shared MasterPlan of their own. */
async function canView(memberId, id) {
  const meta = await store.getJson(META(id));
  if (!meta || meta.status !== 'ready') return null;
  if (meta.memberId === memberId) return meta;
  const member = await getMember(memberId);
  if (!member || !member.sharing) return null;
  const list = await store.getJson('shared.json', []);
  if (!list.some((e) => e.memberId === memberId)) return null;
  return list.some((e) => e.id === id) ? meta : null;
}

async function readDoc(memberId, id, doc) {
  if (!DOCS[doc]) return null;
  const meta = await canView(memberId, id);
  if (!meta) return null;
  return store.get(FILE(id, DOCS[doc]));
}

async function remove(memberId, id) {
  const meta = effectiveStatus(await store.getJson(META(id)));
  if (!meta || meta.memberId !== memberId) return false;
  if (meta.status === 'running' || inFlight.has(id)) {
    throw Object.assign(new Error('This MasterPlan is still being written. Delete it once it finishes.'), {
      userFacing: true,
      status: 409,
    });
  }
  await store.update(MEMBER(memberId), null, (m) => {
    m.reports = m.reports.filter((r) => r.id !== id);
    return m;
  });
  await store.update('shared.json', [], (l) => l.filter((e) => e.id !== id));
  await store.update('active.json', [], (l) => l.filter((x) => x !== id));
  const i = queue.indexOf(id);
  if (i >= 0) queue.splice(i, 1);
  for (const name of ['narrative.pdf', 'article.pdf', 'work.json', 'inputs.json', 'meta.json']) {
    await store.del(FILE(id, name));
  }
  return true;
}

/* ---- boot ------------------------------------------------------------------ */

async function resumeActive() {
  const active = await store.getJson('active.json', []);
  for (const id of active) {
    const meta = await store.getJson(META(id));
    if (!meta || meta.status === 'ready') continue;
    if (meta.status === 'running') await setMeta(id, { status: 'queued', stage: 'queued' });
    enqueue(id);
  }
  if (active.length) console.log('[masterplan] resumed %d report(s) after restart', active.length);
}

module.exports = {
  touchMember,
  getMember,
  claimDevice,
  hasDevice,
  newLinkCode,
  linkDevice,
  contributes,
  setSharing,
  createReport,
  retry,
  listMine,
  listLibrary,
  readDoc,
  remove,
  resumeActive,
  _run: run,
};
