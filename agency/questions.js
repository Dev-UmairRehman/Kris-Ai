'use strict';

/* ---------------------------------------------------------------------------
   The question bank (questions.json, from the client's Authority Based
   Business spreadsheet: 10 levels) and which question a member sees next.

   A member starts with one question from each level (the "starters"). After
   those, one new question is unlocked every few days, taking the levels in
   turn so the profile grows evenly. Level 10 pulls everything together, so
   its other questions wait until most of the bank is answered. A member can
   always answer any unlocked question, and re-answer any question.
   --------------------------------------------------------------------------- */

const bank = require('./questions.json');

const levels = bank.levels;
const byId = new Map();
for (const l of levels) for (const q of l.questions) byId.set(q.id, { ...q, level: l.n, levelTitle: l.title });

const starters = levels.map((l) => l.starter);
const DAY = 24 * 3600 * 1000;

/* The order new questions are offered in: the second question of every
   level, then the third of every level, and so on. Level 10 comes last. */
const queue = (() => {
  const rest = levels.filter((l) => l.n !== 10).map((l) => l.questions.filter((q) => q.id !== l.starter));
  const out = [];
  for (let i = 0; rest.some((r) => i < r.length); i++) for (const r of rest) if (r[i]) out.push(r[i].id);
  for (const q of levels.find((l) => l.n === 10).questions) if (q.id !== levels[9].starter) out.push(q.id);
  return out;
})();

function get(id) {
  return byId.get(id) || null;
}

/**
 * What is open to this member: the starters, then one more question every
 * `everyDays` days after the starters were finished (and never fewer than the
 * number they have already answered, so answering early is not punished).
 * member.answered: { [qid]: isoDate }, member.startersDoneAt: iso or null.
 */
function earnedExtras(member, everyDays, now) {
  if (!member.startersDoneAt) return 0;
  const since = Date.parse(member.startersDoneAt);
  return 1 + Math.floor(Math.max(0, now - since) / (everyDays * DAY));
}

function unlocked(member, everyDays, now = Date.now()) {
  const answered = member.answered || {};
  const open = new Set(starters);
  const earned = earnedExtras(member, everyDays, now);
  const answeredCount = Object.keys(answered).length;
  let given = 0;
  for (const id of queue) {
    if (given >= earned) break;
    /* Level 10's summary questions open once most of the bank is answered. */
    if (get(id).level === 10 && answeredCount < Math.floor(byId.size * 0.6)) continue;
    open.add(id);
    given++;
  }
  for (const id of Object.keys(answered)) if (byId.has(id)) open.add(id);
  return open;
}

/** The question on the dashboard card: the first open one not yet answered. */
function next(member, everyDays, now = Date.now()) {
  const answered = member.answered || {};
  const open = unlocked(member, everyDays, now);
  for (const id of starters) if (!answered[id]) return get(id);
  for (const id of queue) if (open.has(id) && !answered[id]) return get(id);
  return null;
}

/** When the next new question appears, for "your next question arrives on ...". */
function nextAt(member, everyDays, now = Date.now()) {
  if (!member.startersDoneAt) return null;
  const since = Date.parse(member.startersDoneAt);
  return new Date(since + earnedExtras(member, everyDays, now) * everyDays * DAY).toISOString();
}

module.exports = { levels, starters, queue, get, unlocked, next, nextAt, total: byId.size };
