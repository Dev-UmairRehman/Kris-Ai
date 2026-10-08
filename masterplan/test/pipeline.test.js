'use strict';

/* End-to-end run of one report with the model stubbed out: intake, profile,
   research, cost model, section assembly, lint, PDFs, storage, the library
   rules and delete. The stub answers each call with the matching part of the
   worked example, so no API credit is spent. */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-test-'));
Object.assign(process.env, {
  MP_ENABLED: 'true',
  MP_STORAGE: 'disk',
  MP_DISK_ROOT: tmp,
  MP_ANTHROPIC_API_KEY: 'test-key',
  MP_EMAIL_DRIVER: 'log',
});

const llm = require('../llm');
const knowledge = require('../knowledge');
const K = (f) => knowledge.read(f);
/* The worked example's own name (first heading, plus the sealed name list) is
   swapped for a test name, so the lint does not flag it. */
const exampleName = K('example-narrative.md').match(/^# (.+)$/m)[1].trim();
const privateNames = JSON.parse(K('private-names.json'));
const rename = (s) => {
  let out = s.split(exampleName).join('Alex Rivera');
  for (const n of privateNames) out = out.replace(new RegExp('\\b' + n + '\\b', 'g'), n === privateNames[0] ? 'Alex' : 'Rivera');
  return out.replace(/Alex Rivera Rivera/g, 'Alex Rivera');
};

const narrative = K('example-narrative.md');
function slice(from, to) {
  const a = narrative.indexOf(from);
  const b = to ? narrative.indexOf(to, a + 1) : narrative.length;
  return narrative.slice(a, b).trim();
}
const partTwo = slice('## Part Two', '### Exercise Three').replace(/\| Line \| Monthly \| Basis \|[\s\S]*?\n\n/, '[[COST_TABLE]]\n\n');
const CHUNKS = {
  '## Part One': slice('## Part One', '### Question 6'),
  '### Question 6': slice('### Question 6', '## Part Two'),
  '## Part Two': partTwo,
  '### Exercise Three': slice('### Exercise Three', '## Part Three'),
  '## Part Three': slice('## Part Three', '### Chapter Fifteen'),
  '### Chapter Fifteen': slice('### Chapter Fifteen', '### Chapter Eighteen'),
  '### Chapter Eighteen': slice('### Chapter Eighteen', '## Part Four'),
  '## Part Four': slice('## Part Four', '**Sources.**'),
};

const calls = [];
llm.generate = async (p) => {
  const blocks = Array.isArray(p.content) ? p.content : [{ type: 'text', text: p.content }];
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  calls.push(text.slice(-200));
  if (text.includes('extract a profile')) {
    return {
      text:
        '```json\n' +
        JSON.stringify({
          name: 'Alex Rivera',
          first_name: 'Alex',
          pronouns: 'they/them',
          resume_text: '',
          resume_date: 'July 2024',
          age_estimate: { low: 41, high: 42, basis: 'degree 2007' },
          current_role: { title: 'Senior Manager', employer: 'Acme', level: 'L7' },
          feed: { platforms: ['Instagram'], evidence_strength: 'thin', evidence_note: 'The public view shows only a bio and five post titles.' },
          hobbies_for_costing: ['painting'],
        }) +
        '\n```',
      usage: p.usage,
    };
  }
  if (text.includes('Find, for this place')) {
    return { text: '```json\n' + JSON.stringify(require('./costs.fixture.json')) + '\n```', usage: p.usage };
  }
  if (text.includes('<draft>')) {
    return { text: text.split('<draft>\n')[1].split('\n</draft>')[0], usage: p.usage };
  }
  if (text.includes('Write the whole leadership case article')) {
    return { text: rename(K('example-article.md')), usage: p.usage };
  }
  const key = Object.keys(CHUNKS).find((k) => text.includes('MasterPlan now: ' + k));
  assert.ok(key, 'unrecognised writing task: ' + text.slice(-300));
  return { text: rename(CHUNKS[key]), usage: p.usage };
};

const jobs = require('../jobs');
const store = require('../store');

const RESUME = Buffer.from(
  'Alex Rivera\nDublin, CA 94568\n\nEXPERIENCE\nAcme Corp, Senior Manager, June 2021 - present. Led a team of eight; multiyear savings of $198.2M.\n' +
    'Acme Corp, Principal Program Manager, March 2020 - June 2021.\n\nEDUCATION\nMBA, 2014. BSc, May 2007.\n\nINTERESTS\nPainting, organ, diving.\n'
).toString('base64');

async function waitFor(id, status) {
  for (let i = 0; i < 400; i++) {
    const meta = await store.getJson('reports/' + id + '/meta.json');
    if (meta && meta.status === status) return meta;
    if (meta && meta.status === 'failed') throw new Error('report failed: ' + meta.error);
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out');
}

test('a report runs end to end and the library rules hold', async () => {
  const form = {
    name: 'Alex Rivera', pronouns: 'they/them', city: 'Dublin', region: 'CA', postalCode: '94568', country: 'United States',
    links: [], pasted: 'Bio: Visited 40 countries.', resumeName: 'resume.txt', resumeBase64: RESUME, share: false,
  };
  const meta = await jobs.createReport({ memberId: 'mp_alex', email: 'alex@example.com', form });
  const done = await waitFor(meta.id, 'ready');

  assert.ok(done.docs.narrative.pages >= 15, 'narrative pages ' + done.docs.narrative.pages);
  assert.ok(done.docs.article.pages >= 5, 'article pages ' + done.docs.article.pages);
  assert.strictEqual(done.docs.article.title, "The Fixer's Dilemma");

  const work = await store.getJson('reports/' + meta.id + '/work.json');
  assert.match(work.narrative, /\| \*\*Total\*\* \| \*\*\$18,210¤\*\*/, 'cost table from code');
  assert.doesNotMatch(work.narrative, /\[\[COST_TABLE\]\]/);
  assert.doesNotMatch(work.narrative, /—/);
  assert.match(work.narrative, /^# Alex Rivera/);
  assert.match(work.narrative, /\*\*Sources\.\*\* Home prices, \[PropertyShark\]/);

  /* Owner can read; a stranger cannot. */
  assert.ok(await jobs.readDoc('mp_alex', meta.id, 'narrative'));
  assert.strictEqual(await jobs.readDoc('mp_other', meta.id, 'narrative'), null);
  assert.strictEqual(await jobs.readDoc('mp_alex', meta.id, '../inputs.json'), null);

  /* Sharing is mutual: both must share. */
  await jobs.touchMember('mp_other', 'other@example.com');
  await jobs.setSharing('mp_alex', true);
  assert.strictEqual(await jobs.readDoc('mp_other', meta.id, 'article'), null, 'viewer who does not share sees nothing');
  assert.deepStrictEqual((await jobs.listLibrary('mp_other')).reports, []);
  await jobs.setSharing('mp_other', true);
  /* Sharing with nothing to share opens nothing: an empty account made up to
     look around sees no one's MasterPlan. */
  assert.strictEqual(await jobs.readDoc('mp_other', meta.id, 'article'), null, 'no own shared MasterPlan, no Library');
  assert.strictEqual((await jobs.listLibrary('mp_other')).waiting, true);
  const otherOwn = await jobs.createReport({ memberId: 'mp_other', email: 'other@example.com', form: { ...form, share: true } });
  await waitFor(otherOwn.id, 'ready');
  assert.ok(await jobs.readDoc('mp_other', meta.id, 'article'));
  const lib = await jobs.listLibrary('mp_other');
  assert.strictEqual(lib.reports.length, 2, "alex's and other's own");
  assert.strictEqual(lib.reports[0].memberId, undefined, 'member ids are not exposed');
  await jobs.setSharing('mp_alex', false);
  assert.strictEqual(await jobs.readDoc('mp_other', meta.id, 'article'), null, 'unsharing withdraws access');

  /* Limits: two a day. */
  await jobs.createReport({ memberId: 'mp_alex', email: 'alex@example.com', form }).then((m) => waitFor(m.id, 'ready'));
  await assert.rejects(jobs.createReport({ memberId: 'mp_alex', email: 'alex@example.com', form }), /2 MasterPlans a day/);

  /* Delete removes everything. */
  assert.strictEqual(await jobs.remove('mp_alex', meta.id), true);
  assert.strictEqual(await store.get('reports/' + meta.id + '/narrative.pdf'), null);
  assert.strictEqual(await store.get('reports/' + meta.id + '/inputs.json'), null);
  assert.strictEqual(await jobs.remove('mp_other', meta.id), false);

  /* Deleting a report does not free up another run today. */
  await assert.rejects(jobs.createReport({ memberId: 'mp_alex', email: 'alex@example.com', form }), /2 MasterPlans a day/);

  /* The share box on the form keeps the Library in step: ticking it shares the
     member's ready reports, unticking takes them out again. */
  await jobs.touchMember('mp_sam', 'sam@example.com');
  const samForm = { ...form, share: true };
  const sam = await jobs.createReport({ memberId: 'mp_sam', email: 'sam@example.com', form: samForm });
  await waitFor(sam.id, 'ready');
  assert.ok((await jobs.listLibrary('mp_other')).reports.some((e) => e.id === sam.id), 'shared report is in the Library');
  await jobs.createReport({ memberId: 'mp_sam', email: 'sam@example.com', form: { ...form, share: false } }).then((m) => waitFor(m.id, 'ready'));
  assert.ok(!(await jobs.listLibrary('mp_other')).reports.some((e) => e.id === sam.id), 'unticking removes earlier reports');

  fs.writeFileSync(path.join(tmp, 'last-narrative.pdf'), await store.get('reports/' + (await jobs.listMine('mp_alex')).reports[0].id + '/narrative.pdf'));
  console.log('model calls:', calls.length, ' output dir:', tmp);
});

test('the lint catches names and dashes', () => {
  const writer = require('../writer');
  assert.strictEqual(writer.cleanup('A — B, 5–10 *x* **y**'), 'A, B, 5 to 10 ¤x¤ **y**');
  const issues = writer.problems('Like Ethan, she chose banking. Mail me at a@b.co', 'Alex Rivera');
  assert.ok(issues.some((i) => /Ethan/.test(i)));
  assert.ok(issues.some((i) => /email/.test(i)));
  assert.deepStrictEqual(writer.problems('Joe Smith led the review.', 'Joe Smith'), []);
});
