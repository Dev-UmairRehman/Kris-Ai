'use strict';

/* The rules this file proves, through the real HTTP routes (no model calls):
   a member who does not share is read by no one but themselves; the Library
   opens only to members who share a finished MasterPlan of their own; and
   nothing that only looks like an email becomes an identity. */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-sec-'));
Object.assign(process.env, {
  NODE_ENV: 'development',
  MEMBER_GATE_MODE: 'open',
  MP_ENABLED: 'true',
  MP_STORAGE: 'disk',
  MP_DISK_ROOT: tmp,
  MP_LLM_PROVIDER: 'anthropic',
  MP_ANTHROPIC_API_KEY: 'test-key',
  MP_EMAIL_DRIVER: 'log',
  USCREEN_API_BASE: '',
  USCREEN_API_KEY: '',
});

const express = require('express');
const { router } = require('..');
const store = require('../store');

let base;
let server;

test.before(async () => {
  const app = express();
  app.use(express.json({ limit: '12mb' }));
  app.use('/masterplan', router);
  await new Promise((r) => (server = app.listen(0, r)));
  base = 'http://127.0.0.1:' + server.address().port + '/masterplan';
});
test.after(() => server.close());

async function call(method, p, body, token) {
  const res = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, data: type.includes('json') ? await res.json() : await res.arrayBuffer() };
}

async function signIn(email) {
  const r = await call('POST', '/api/session', { signedIn: true, email });
  assert.strictEqual(r.status, 200, 'session for ' + email);
  return r.data.token;
}

function memberIdOf(email) {
  const dir = path.join(tmp, 'masterplan', 'members');
  const f = fs.readdirSync(dir).find((n) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')).email === email);
  assert.ok(f, 'member file for ' + email);
  return f.replace(/\.json$/, '');
}

/* A finished MasterPlan with all three outputs, written straight into storage. */
async function plantReport(email, id) {
  const memberId = memberIdOf(email);
  await store.putJson('reports/' + id + '/meta.json', {
    id, memberId, name: 'Owner of ' + id, status: 'ready', stage: 'ready', createdAt: new Date().toISOString(),
    docs: { narrative: { title: 'The MasterPlan', pages: 1 }, article: { title: 'A Case', pages: 1 } },
    podcast: { status: 'ready', title: 'An Episode', seconds: 60 },
  });
  for (const f of ['narrative.pdf', 'article.pdf', 'podcast.mp3']) {
    await store.put('reports/' + id + '/' + f, Buffer.from('secret ' + id + ' ' + f));
  }
  await store.update('members/' + memberId + '.json', null, (m) => {
    m.reports.unshift({ id, createdAt: new Date().toISOString() });
    return m;
  });
}

const DOCS = ['narrative', 'article', 'podcast'];
/* All three outputs open, or none of them does. */
async function canRead(token, id) {
  const got = await Promise.all(DOCS.map((d) => call('GET', '/api/reports/' + id + '/' + d, null, token)));
  const codes = got.map((r) => r.status);
  if (codes.every((c) => c === 200)) return true;
  assert.deepStrictEqual(codes, [404, 404, 404], 'all or nothing for ' + id);
  return false;
}
const inLibrary = async (token, id) => ((await call('GET', '/api/library', null, token)).data.reports || []).some((e) => e.id === id);

test('a member who does not share is read by no one else', async () => {
  const private_ = await signIn('private@example.com');
  const sharer = await signIn('sharer@example.com');
  await plantReport('private@example.com', 'r_private');
  await plantReport('sharer@example.com', 'r_sharer');
  await call('POST', '/api/sharing', { sharing: true }, sharer);

  /* The sharing member, Library open with their own plan, sees nothing of
     the private one: not in the Library, not in their list, not by its id. */
  assert.ok(await inLibrary(sharer, 'r_sharer'), "the sharer's own plan is in the Library");
  assert.ok(!(await inLibrary(sharer, 'r_private')), 'a private plan is not in the Library');
  assert.ok(!(await call('GET', '/api/reports', null, sharer)).data.reports.some((r) => r.id === 'r_private'));
  assert.strictEqual(await canRead(sharer, 'r_private'), false, 'no document, case study or podcast of a private plan');
  for (const p of ['/api/reports/r_private/delete', '/api/reports/r_private/retry']) {
    assert.strictEqual((await call('POST', p, {}, sharer)).status, 404, p);
  }

  /* Not sharing works both ways: the private member reads no one else. */
  assert.strictEqual(await canRead(private_, 'r_sharer'), false);
  assert.deepStrictEqual((await call('GET', '/api/library', null, private_)).data.reports, []);
  assert.strictEqual(await canRead(private_, 'r_private'), true, 'owners always read their own');

  /* Sharing opens both ways, and stopping closes both ways at once. */
  await call('POST', '/api/sharing', { sharing: true }, private_);
  assert.strictEqual(await canRead(sharer, 'r_private'), true);
  assert.strictEqual(await canRead(private_, 'r_sharer'), true);
  await call('POST', '/api/sharing', { sharing: false }, private_);
  assert.strictEqual(await canRead(sharer, 'r_private'), false, 'unsharing withdraws the plan at once');
  assert.strictEqual(await canRead(private_, 'r_sharer'), false, 'and closes the Library to them');
  assert.ok(!(await inLibrary(sharer, 'r_private')));
});

test("an account with nothing shared cannot read another member's shared MasterPlan", async () => {
  const lurker = await signIn('lurker@example.com');
  await call('POST', '/api/sharing', { sharing: true }, lurker);
  const lib = await call('GET', '/api/library', null, lurker);
  assert.strictEqual(lib.status, 200);
  assert.deepStrictEqual(lib.data.reports, []);
  assert.strictEqual(lib.data.waiting, true);
  assert.strictEqual(await canRead(lurker, 'r_sharer'), false);
});

test('no token, a forged token or a path trick opens nothing', async () => {
  const t = await signIn('owner2@example.com');
  await plantReport('owner2@example.com', 'r_owner2');
  assert.strictEqual((await call('GET', '/api/reports', null, null)).status, 401);
  assert.strictEqual((await call('GET', '/api/reports/r_owner2/narrative', null, null)).status, 401);
  const forged = t.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
  assert.strictEqual((await call('GET', '/api/reports/r_owner2/narrative', null, forged)).status, 401);
  assert.strictEqual((await call('GET', '/api/reports/r_owner2/..%2Finputs.json', null, t)).status, 404);
});

test('addresses from page code are not an identity', async () => {
  /* An account page with no email field once gave the page only an error
     tracker's key from its scripts; every such member would have shared it. */
  for (const email of ['4ed12ab34cd56ef7890a1b2c3d4e5f60@o282387.ingest.us.sentry.io', 'abc@sentry.io', 'logo@2x.png']) {
    const r = await call('POST', '/api/session', { signedIn: true, email });
    assert.strictEqual(r.status, 401, email);
    assert.strictEqual(r.data.reason, 'no_email', email);
  }
});
