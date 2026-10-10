'use strict';

/* The rule this file proves: knowing - or faking - someone's email never
   shows their MasterPlans. Runs the real HTTP routes. No model calls. */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

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

const key = () => crypto.randomBytes(32).toString('base64url');

async function call(method, p, body, token) {
  const res = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, data: type.includes('json') ? await res.json() : await res.arrayBuffer() };
}

const session = (email, deviceKey) => call('POST', '/api/session', { signedIn: true, email, deviceKey });

/* A ready report, written straight into storage, owned by `email`. */
async function plantReport(token, id) {
  const mine = await call('GET', '/api/reports', null, token);
  assert.strictEqual(mine.status, 200);
  const memberFile = fs.readdirSync(path.join(tmp, 'masterplan', 'members'))[0];
  const memberId = memberFile.replace(/\.json$/, '');
  await store.putJson('reports/' + id + '/meta.json', {
    id, memberId, name: 'Victim', status: 'ready', stage: 'ready',
    createdAt: new Date().toISOString(), docs: { narrative: { title: 'The MasterPlan', pages: 1 } },
  });
  await store.put('reports/' + id + '/narrative.pdf', Buffer.from('%PDF-1.4 secret'), 'application/pdf');
  await store.update('members/' + memberId + '.json', null, (m) => {
    m.reports.unshift({ id, createdAt: new Date().toISOString() });
    return m;
  });
}

test("an attacker with the victim's email cannot read anything", async () => {
  const victimKey = key();
  const owner = await session('victim@example.com', victimKey);
  assert.strictEqual(owner.data.scope, 'full', 'first browser on an empty account owns it');
  await plantReport(owner.data.token, 'r_secret_1');

  /* Same email, different browser. */
  const attacker = await session('victim@example.com', key());
  assert.strictEqual(attacker.status, 200);
  assert.strictEqual(attacker.data.scope, 'link', 'a new browser on an account with MasterPlans must link first');
  const t = attacker.data.token;

  for (const [m, p] of [
    ['GET', '/api/reports'],
    ['GET', '/api/reports/r_secret_1/narrative'],
    ['GET', '/api/library'],
    ['POST', '/api/reports/r_secret_1/delete'],
    ['POST', '/api/reports/r_secret_1/retry'],
    ['POST', '/api/sharing'],
    ['POST', '/api/devices/code'],
    ['POST', '/api/reports'],
  ]) {
    const r = await call(m, p, m === 'POST' ? { sharing: true } : null, t);
    assert.strictEqual(r.status, 403, m + ' ' + p + ' must be refused, got ' + r.status);
  }

  /* Guessing codes: wrong codes fail, and there is no code to guess anyway. */
  for (let i = 0; i < 6; i++) {
    const r = await call('POST', '/api/devices/link', { code: 'AAAA-AAAA' }, t);
    assert.strictEqual(r.status, 400);
  }

  /* A forged token is rejected. */
  const forged = await call('GET', '/api/reports', null, t.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')));
  assert.strictEqual(forged.status, 401);

  /* The owner still reads everything. */
  const own = await call('GET', '/api/reports/r_secret_1/narrative', null, owner.data.token);
  assert.strictEqual(own.status, 200);
  assert.match(Buffer.from(own.data).toString(), /secret/);
});

test('a code from a linked browser adds a new one, once, for a while', async () => {
  const ownerKey = key();
  const owner = await session('pat@example.com', ownerKey);
  await plantReport(owner.data.token, 'r_pat_1');

  const phone = await session('pat@example.com', key());
  assert.strictEqual(phone.data.scope, 'link');

  /* Five wrong tries burn the code. */
  const code1 = (await call('POST', '/api/devices/code', null, owner.data.token)).data.code;
  for (let i = 0; i < 5; i++) await call('POST', '/api/devices/link', { code: 'ZZZZ-ZZZZ' }, phone.data.token);
  const late = await call('POST', '/api/devices/link', { code: code1 }, phone.data.token);
  assert.strictEqual(late.status, 400, 'a code is dead after five wrong tries');

  const code2 = (await call('POST', '/api/devices/code', null, owner.data.token)).data.code;
  const linked = await call('POST', '/api/devices/link', { code: code2.toLowerCase() }, phone.data.token);
  assert.strictEqual(linked.status, 200);
  assert.strictEqual(linked.data.scope, 'full');
  const read = await call('GET', '/api/reports/r_pat_1/narrative', null, linked.data.token);
  assert.strictEqual(read.status, 200);

  const again = await call('POST', '/api/devices/link', { code: code2 }, (await session('pat@example.com', key())).data.token);
  assert.strictEqual(again.status, 400, 'a code works once');
});

test("an empty account cannot be used to read another member's shared MasterPlan", async () => {
  const lurker = await session('lurker@example.com', key());
  assert.strictEqual(lurker.data.scope, 'full');
  await call('POST', '/api/sharing', { sharing: true }, lurker.data.token);
  const lib = await call('GET', '/api/library', null, lurker.data.token);
  assert.strictEqual(lib.status, 200);
  assert.deepStrictEqual(lib.data.reports, []);
  const peek = await call('GET', '/api/reports/r_secret_1/narrative', null, lurker.data.token);
  assert.strictEqual(peek.status, 404);
});

test('addresses from page code are not an identity', async () => {
  /* An account page with no email field once gave the page only an error
     tracker's key from its scripts; every such member would have shared it. */
  const deviceKey = 'k'.repeat(43);
  for (const email of ['4ed12ab34cd56ef7890a1b2c3d4e5f60@o282387.ingest.us.sentry.io', 'abc@sentry.io', 'logo@2x.png']) {
    const r = await call('POST', '/api/session', { signedIn: true, email, deviceKey });
    assert.strictEqual(r.status, 401, email);
    assert.strictEqual(r.data.reason, 'no_email', email);
  }
});

test('a session without a device key is refused', async () => {
  const r = await call('POST', '/api/session', { signedIn: true, email: 'x@example.com' });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.data.reason, 'no_device');
});
