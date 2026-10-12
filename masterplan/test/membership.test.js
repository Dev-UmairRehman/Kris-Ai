'use strict';

/* Only members with a plan get in. A fake Uscreen Publisher API answers the
   two calls membership.js makes, in the shapes of Uscreen's published spec. */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const KEY = 'test-uscreen-key';
const past = Math.floor(Date.now() / 1000) - 86400;
const future = Math.floor(Date.now() / 1000) + 86400;

/* email -> [subscription answer, accesses answer] */
const CUSTOMERS = {
  'active@example.com': [{ status: 200, body: { id: 1, product_id: 11, canceled_at: null } }, null],
  'paused@example.com': [{ status: 200, body: { id: 2, product_id: 11, canceled_at: null, pauses_at: past, resumes_at: future } }, { status: 200, body: [] }],
  'none@example.com': [{ status: 204 }, { status: 200, body: [] }],
  'comped@example.com': [{ status: 204 }, { status: 200, body: [{ id: 9, product_type: 'recurring', product_id: 11, canceled_at: null, origin: 'assigned_by_admin' }] }],
  'rental@example.com': [{ status: 204 }, { status: 200, body: [{ id: 8, product_type: 'rent', product_id: 50, canceled_at: null, perform_action_at: future }] }],
  'lapsed@example.com': [{ status: 204 }, { status: 200, body: [{ id: 7, product_type: 'recurring', product_id: 11, canceled_at: past }] }],
};
const calls = [];
let down = false;

const fake = http.createServer((req, res) => {
  calls.push(req.url);
  if (down) return res.writeHead(502).end('bad gateway');
  if (req.headers.authorization !== KEY) return res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"Unauthorized"}');
  const m = req.url.match(/^\/publisher_api\/v1\/customers\/([^/]+)\/(subscription|accesses)$/);
  const who = m && CUSTOMERS[decodeURIComponent(m[1]).toLowerCase()];
  if (!who) return res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"Not found"}');
  const a = who[m[2] === 'subscription' ? 0 : 1];
  if (a.status === 204) return res.writeHead(204).end();
  res.writeHead(a.status, { 'content-type': 'application/json' }).end(JSON.stringify(a.body));
});

let membership;
let base;
let server;

test.before(async () => {
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-plan-'));
  Object.assign(process.env, {
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
  });
  membership = require('../membership');
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

test('who has a plan', async () => {
  const expect = {
    'active@example.com': true,
    'Active@Example.com': true,
    'comped@example.com': true,
    'paused@example.com': false,
    'none@example.com': false,
    'rental@example.com': false,
    'lapsed@example.com': false,
    'stranger@example.com': false,
  };
  for (const [email, ok] of Object.entries(expect)) {
    const v = await membership.check(email);
    assert.strictEqual(v.ok, ok, email + ' -> ' + JSON.stringify(v));
  }
  assert.strictEqual((await membership.check('stranger@example.com')).reason, 'customer_not_found');
  assert.strictEqual((await membership.check('none@example.com')).reason, 'not_subscribed');
});

test('the team gets in without asking Uscreen', async () => {
  const before = calls.length;
  assert.strictEqual((await membership.check('kris@firmsconsulting.com')).ok, true);
  assert.strictEqual((await membership.check('someone@strategytraining.com')).ok, true);
  assert.strictEqual(calls.length, before);
});

test('a refused key lets nobody in; an outage lets members in', async () => {
  membership._cache.clear();
  const config = require('../config');
  config.membership.apiKey = 'wrong';
  assert.deepStrictEqual(await membership.check('active@example.com'), { ok: false, reason: 'verification_unavailable' });
  config.membership.apiKey = KEY;
  down = true;
  assert.strictEqual((await membership.check('none@example.com')).ok, true, 'Uscreen down: not locked out');
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

  const no = await post('/api/session', { signedIn: true, email: 'none@example.com' });
  assert.strictEqual(no.status, 403);
  assert.strictEqual(no.data.reason, 'not_subscribed');
  assert.ok(no.data.joinUrl, 'the page gets the join link');

  const yes = await post('/api/session', { signedIn: true, email: 'active@example.com' });
  assert.strictEqual(yes.status, 200);

  /* A plan that lapses during the session: creating is refused. */
  CUSTOMERS['active@example.com'] = [{ status: 204 }, { status: 200, body: [] }];
  membership._cache.clear();
  const made = await post('/api/reports', { resumeBase64: Buffer.from('cv').toString('base64'), resumeName: 'cv.txt', confirm: true }, yes.data.token);
  assert.strictEqual(made.status, 403);
  assert.match(made.data.error, /plan/);
});
