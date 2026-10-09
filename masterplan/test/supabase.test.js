'use strict';

/* The Supabase driver against the real project. Opt-in, because it talks to
   production storage: it writes under a throwaway key and deletes it again.

     MP_TEST_SUPABASE=1 MP_SUPABASE_URL=... MP_SUPABASE_SECRET_KEY=... \
       node --test masterplan/test/supabase.test.js
*/

const test = require('node:test');
const assert = require('node:assert');

const on = process.env.MP_TEST_SUPABASE === '1' && process.env.MP_SUPABASE_URL && process.env.MP_SUPABASE_SECRET_KEY;

test('records, files, cache and delete on Supabase', { skip: !on && 'set MP_TEST_SUPABASE=1 and the keys' }, async () => {
  process.env.MP_STORAGE = 'supabase';
  const store = require('../store');
  assert.strictEqual(store.driverName, 'supabase');
  const base = 'selftest/' + Date.now().toString(36) + '/';
  try {
    /* records */
    assert.strictEqual(await store.getJson(base + 'meta.json'), null);
    assert.deepStrictEqual(await store.getJson(base + 'meta.json', []), []);
    await store.putJson(base + 'meta.json', { status: 'queued', n: 1 });
    await store.update(base + 'meta.json', null, (m) => ({ ...m, n: m.n + 1 }));
    assert.deepStrictEqual(await store.getJson(base + 'meta.json'), { status: 'queued', n: 2 });
    /* concurrent updates on one key all land */
    await Promise.all(Array.from({ length: 5 }, () => store.update(base + 'list.json', [], (l) => l.concat(1))));
    assert.strictEqual((await store.getJson(base + 'list.json')).length, 5);

    /* files, including the resume-carrying inputs.json */
    const pdf = Buffer.from('%PDF-1.4 selftest ' + 'x'.repeat(5000));
    await store.put(base + 'narrative.pdf', pdf, 'application/pdf');
    assert.ok((await store.get(base + 'narrative.pdf')).equals(pdf));
    await store.putJson(base + 'inputs.json', { resumeBase64: 'abc' });
    assert.deepStrictEqual(await store.getJson(base + 'inputs.json'), { resumeBase64: 'abc' });
    assert.strictEqual(await store.get(base + 'missing.pdf'), null);
  } finally {
    for (const k of ['meta.json', 'list.json', 'narrative.pdf', 'inputs.json']) await store.del(base + k);
  }
  assert.strictEqual(await store.get(base + 'narrative.pdf'), null);
  assert.strictEqual(await store.getJson(base + 'meta.json'), null);
  assert.strictEqual(await store.getJson(base + 'inputs.json'), null);
});
