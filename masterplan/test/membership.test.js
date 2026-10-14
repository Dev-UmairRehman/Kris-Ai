'use strict';

/* Only members with a plan get in. A fake Uscreen Publisher API answers the
   calls membership.js makes, in the shapes the real API returned on
   2026-10-14 (GET /customers/{email} with "subscriber"; /subscription 200 or
   204; /accesses a list). */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const KEY = 'test-uscreen-key';
const past = Math.floor(Date.now() / 1000) - 86400;
const future = Math.floor(Date.now() / 1000) + 86400 * 20;

/* email -> { subscriber, subscription answer, accesses answer } */
const CUSTOMERS = {
  'active@example.com': { subscriber: true, sub: { status: 200, body: { id: 1, product_id: 11, canceled_at: null } }, acc: [] },
  'cancelled-paid@example.com': { subscriber: true, sub: { status: 200, body: { id: 3, product_id: 11, canceled_at: past, perform_action_at: future } }, acc: [] },
  'paused@example.com': { subscriber: false, sub: { status: 200, body: { id: 2, product_id: 11, canceled_at: null, pauses_at: past, resumes_at: future } }, acc: [] },
  'none@example.com': { subscriber: false, sub: { status: 204 }, acc: [] },
  'comped@example.com': { subscriber: true, sub: { status: 204 }, acc: [{ id: 9, product_type: 'recurring', product_id: 11, canceled_at: null, origin: 'assigned_by_admin' }] },
  'bundle@example.com': { subscriber: false, sub: { status: 204 }, acc: [{ id: 8, product_type: 'one_time', product_id: 50, canceled_at: null }] },
  'lapsed@example.com': { subscriber: false, sub: { status: 204 }, acc: [{ id: 7, product_type: 'recurring', product_id: 11, canceled_at: past, perform_action_at: past }] },
};
const calls = [];
let down = false;
let busyOnce = false;

const fake = http.createServer((req, res) => {
  calls.push(req.url);
  if (down) return res.writeHead(502).end('bad gateway');
  if (busyOnce) {
    busyOnce = false;
    return res.writeHead(429, { 'retry-after': '1' }).end('Retry later\n');
  }
  if (req.headers.authorization !== KEY) return res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"Unauthorized"}');
  const m = req.url.match(/^\/publisher_api\/v1\/customers\/([^/]+)(?:\/(subscription|accesses))?$/);
  const who = m && CUSTOMERS[decodeURIComponent(m[1]).toLowerCase()];
  if (!who) return res.writeHead(404, { 'content-type': 'application/json' }).end('{"message":"Record not found"}');
  const json = (body) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  if (!m[2]) return json({ id: 1, email: decodeURIComponent(m[1]), subscriber: who.subscriber });
  if (m[2] === 'accesses') return json(who.acc);
  if (who.sub.status === 204) return res.writeHead(204).end();
  json(who.sub.body);
});

let membership;
let config;
let base;
let server;

test.before(async () => {
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-plan-'));
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
    MP_LLM_PROVIDER: 'anthropic',
    MP_ANTHROPIC_API_KEY: 'test-key',
    MP_EMAIL_DRIVER: 'log',
    MP_USCREEN_API_KEY: KEY,
    MP_USCREEN_API_BASE: 'http://127.0.0.1:' + fake.address().port + '/publisher_api/v1',
    MP_PAGE_PLAN_CHECK: 'enforce',
  });
  membership = require('../membership');
  config = require('../config');
  const express = require('express');
  const { router } = require('..');
  const app = express();
  app.use(express.json({ limit: '12mb' }));
  app.use('/masterplan', router);
  await new Promise((r) => (server = app.listen(0, r)));
  base = 'http://127.0.0.1:' + server.address().port + '/masterplan';
});
test.after(() => {
  server.close();
  fake.close();
});

test('who has a plan: Uscreen\'s own "subscriber" verdict, one request each', async () => {
  membership._cache.clear();
  const expect = {
    'active@example.com': true,
    'Active@Example.com': true,
    'cancelled-paid@example.com': true,
    'comped@example.com': true,
    'paused@example.com': false,
    'none@example.com': false,
    'lapsed@example.com': false,
    'stranger@example.com': false,
  };
  for (const [email, ok] of Object.entries(expect)) {
    membership._cache.clear();
    const before = calls.length;
    const v = await membership.check(email);
    assert.strictEqual(v.ok, ok, email + ' -> ' + JSON.stringify(v));
    assert.strictEqual(calls.length - before, 1, email + ': one request');
  }
  assert.strictEqual((await membership.check('stranger@example.com')).reason, 'customer_not_found');
  assert.strictEqual((await membership.check('none@example.com')).reason, 'not_subscribed');
  await membership.check('active@example.com');
  const before = calls.length;
  await membership.check('active@example.com');
  assert.strictEqual(calls.length, before, 'answers are reused for a while');
});

test('with plan product ids: the plan itself is read; a cancelled plan runs to the end of what was paid', async () => {
  config.membership.planProductIds = [11, 50];
  try {
    const expect = {
      'active@example.com': true,
      'cancelled-paid@example.com': true,
      'comped@example.com': true,
      'bundle@example.com': true,
      'paused@example.com': false,
      'lapsed@example.com': false,
      'none@example.com': false,
    };
    for (const [email, ok] of Object.entries(expect)) {
      membership._cache.clear();
      assert.strictEqual((await membership.check(email)).ok, ok, email);
    }
  } finally {
    config.membership.planProductIds = [];
  }
});

test('the team gets in without asking Uscreen', async () => {
  const before = calls.length;
  assert.strictEqual((await membership.check('kris@firmsconsulting.com')).ok, true);
  assert.strictEqual((await membership.check('someone@strategytraining.com')).ok, true);
  assert.strictEqual(calls.length, before);
});

test('Uscreen busy once is waited out; busy, down or a refused key hand over to the page check', async () => {
  membership._cache.clear();
  busyOnce = true;
  assert.strictEqual((await membership.check('active@example.com')).ok, true, 'a 429 is waited out once');

  membership._cache.clear();
  config.membership.apiKey = 'wrong';
  assert.strictEqual((await membership.check('active@example.com')).ok, null);
  config.membership.apiKey = KEY;
  down = true;
  assert.strictEqual((await membership.check('none@example.com')).ok, null, 'Uscreen down: no verdict');
  down = false;
});

test('the routes: sign-in and creating a MasterPlan need a plan', async () => {
  membership._cache.clear();
  const post = (p, body, token) =>
    fetch(base + p, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
      body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, data: await r.json() }));

  const no = await post('/api/session', { signedIn: true, email: 'none@example.com', plan: 'yes' });
  assert.strictEqual(no.status, 403, 'Uscreen says no: the page cannot overrule it');
  assert.strictEqual(no.data.reason, 'not_subscribed');
  assert.ok(no.data.joinUrl, 'the page gets the join link');

  const yes = await post('/api/session', { signedIn: true, email: 'active@example.com', plan: 'no' });
  assert.strictEqual(yes.status, 200, 'Uscreen says yes: in, whatever the page saw');

  /* Uscreen cannot answer: the store page's own check decides. */
  membership._cache.clear();
  down = true;
  try {
    assert.strictEqual((await post('/api/session', { signedIn: true, email: 'none@example.com', plan: 'no' })).status, 403);
    assert.strictEqual((await post('/api/session', { signedIn: true, email: 'none@example.com', plan: 'yes' })).status, 200);
  } finally {
    down = false;
  }

  /* A plan that lapses during the session: creating is refused. */
  CUSTOMERS['active@example.com'] = { subscriber: false, sub: { status: 204 }, acc: [] };
  membership._cache.clear();
  const made = await post('/api/reports', { resumeBase64: Buffer.from('cv').toString('base64'), resumeName: 'cv.txt', confirm: true }, yes.data.token);
  assert.strictEqual(made.status, 403);
  assert.match(made.data.error, /plan/);
});
