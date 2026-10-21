'use strict';

/* The member's feeds read in depth (feeds.js), with Apify, YouTube and the
   web pages stubbed: what each platform gives the MasterPlan, and what
   happens when a reader fails or is not switched on. */

Object.assign(process.env, { YMA_APIFY_TOKEN: 'test-token', MP_OPENAI_API_KEY: '', MP_GEMINI_API_KEY: '' });

const test = require('node:test');
const assert = require('node:assert');
const intake = require('../intake');
const social = require('../../agency/social');
const channels = require('../../agency/channels');
const feeds = require('../feeds');
const llm = require('../llm');
const writer = require('../writer');

intake.readProfilePage = async (url) => ({ url, ok: true, title: 'Page of ' + url, description: 'A description', note: '' });
const actors = [];
social.runActor = async (actor, input) => {
  actors.push(actor);
  if (actor === 'harvestapi~linkedin-profile-scraper') {
    return {
      costUsd: 0.004,
      items: [{
        firstName: 'Ana', lastName: 'Lima', headline: 'Head of Operations at Acme', about: 'I build calm teams.',
        location: { linkedinText: 'Lisbon, Portugal' }, followerCount: 4200, connectionsCount: 500,
        experience: [{ position: 'Head of Operations', companyName: 'Acme', startDate: { text: '2021' }, endDate: { text: 'Present' }, description: 'Led 40 people.' }],
        education: [{ schoolName: 'Nova SBE', degree: 'MSc', fieldOfStudy: 'Management' }],
        skills: [{ name: 'Operations' }], receivedRecommendations: [{ description: 'Ana turned our worst quarter around.' }],
      }],
    };
  }
  if (actor === 'harvestapi~linkedin-profile-posts') {
    return { costUsd: 0.004, items: [{ content: 'Calm is a skill, not a trait.', postedAt: { date: '2026-09-02T10:00:00Z' }, engagement: { likes: 812, comments: 64, shares: 9 } }] };
  }
  if (actor === 'apify~instagram-profile-scraper') {
    return { costUsd: 0.003, items: [{ username: 'ana.lima', fullName: 'Ana Lima', biography: 'Ops by day, ceramics by night', followersCount: 1300, followsCount: 200, postsCount: 90 }] };
  }
  throw new Error('unexpected actor ' + actor);
};
social.read = async (platform, handle, limit, opts) => {
  assert.ok(opts && opts.full, 'whole captions asked for');
  const v = { published: '2026-08-01T00:00:00Z', views: 5400, likes: 300, comments: 12, shares: 4, text: 'The whole caption of a ' + platform + ' post.' };
  return platform === 'tiktok'
    ? { title: 'Ana', followers: 800, bio: 'Small rituals', following: 50, totalLikes: 9000, videoCount: 31, verified: false, costUsd: 0.04, videos: [v] }
    : { title: 'Ana Lima', costUsd: 0.03, videos: [v] };
};
channels.channel = async () => ({ title: 'Ana on operations', videos: [{ id: 'x', title: 'Why calm teams win', views: 12000, published: '2026-07-01T00:00:00Z', short: false }] });

test('every platform is read in depth', async () => {
  const r = await feeds.gather([
    'https://www.linkedin.com/in/ana-lima/',
    'https://www.youtube.com/@analima',
    'https://www.instagram.com/ana.lima/',
    'https://www.tiktok.com/@analima',
    'https://analima.com',
  ]);
  assert.deepStrictEqual(r.feeds.map((f) => f.platform), ['LinkedIn', 'YouTube', 'Instagram', 'TikTok']);
  const li = r.feeds[0];
  assert.strictEqual(li.headline, 'Head of Operations at Acme');
  assert.strictEqual(li.experience[0].description, 'Led 40 people.');
  assert.deepStrictEqual(li.recommendations, ['Ana turned our worst quarter around.']);
  assert.deepStrictEqual(li.posts[0], { date: '2026-09-02', text: 'Calm is a skill, not a trait.', reactions: 812, comments: 64, shares: 9, repost: false });
  assert.strictEqual(r.feeds[1].videos[0].title, 'Why calm teams win');
  assert.strictEqual(r.feeds[2].bio, 'Ops by day, ceramics by night');
  assert.strictEqual(r.feeds[2].reels[0].text, 'The whole caption of a instagram post.');
  assert.strictEqual(r.feeds[3].bio, 'Small rituals');
  assert.strictEqual(r.feeds[3].total_likes, 9000);
  assert.ok(r.costUsd > 0.08 && r.costUsd < 0.09, 'cost counted: ' + r.costUsd);
  assert.strictEqual(r.pages.length, 5, 'every link keeps its page title and description');
  assert.strictEqual(r.pages[4].depth, 'page title and description', 'a website stays a page');
  assert.ok(r.feeds.every((f) => !('costUsd' in f)), 'no cost inside what the model reads');
});

test('a reader that fails, or Apify switched off, falls back to the page', async () => {
  const saved = social.runActor;
  social.runActor = async () => { throw new Error('Apify answered 402'); };
  const r = await feeds.gather(['https://www.linkedin.com/in/ana-lima/']);
  assert.strictEqual(r.feeds.length, 0);
  assert.match(r.pages[0].depth, /page title and description only \(Apify answered 402\)/);
  social.runActor = saved;

  const savedAvail = social.available;
  social.available = () => false;
  const off = await feeds.gather(['https://www.tiktok.com/@analima', 'https://www.youtube.com/@analima']);
  assert.deepStrictEqual(off.feeds.map((f) => f.platform), ['YouTube'], 'YouTube needs no key; TikTok waits for Apify');
  assert.match(off.pages[0].depth, /not switched on/);
  social.available = savedAvail;
});

test('the feeds reach the model, shortened when they are long', async () => {
  const long = [{ platform: 'LinkedIn', url: 'u', posts: Array.from({ length: 15 }, (_, i) => ({ date: '2026-01-0' + (i % 9), text: 'x'.repeat(900) })) }];
  const full = feeds.asText(long, 100000);
  const short = feeds.asText(long, 6000);
  assert.ok(full.length > 13000);
  assert.ok(short.length <= 6000 && short.includes('LinkedIn'), 'kept within the limit: ' + short.length);

  const r = await feeds.gather(['https://www.linkedin.com/in/ana-lima/']);
  let seen = '';
  const savedGen = llm.generate;
  llm.generate = async (p) => {
    seen = p.content.map((c) => c.text || '').join('\n');
    return { text: '```json\n{"name":"Ana Lima","first_name":"Ana","feed":{"platforms":["LinkedIn"]}}\n```', usage: {} };
  };
  try {
    await writer.extractProfile({ name: '', pronouns: '', city: 'Lisbon', today: '21 October 2026', resume: { text: 'Ana Lima, operations.' }, social: { pages: r.pages, feeds: r.feeds, pasted: '' } }, {});
  } finally {
    llm.generate = savedGen;
  }
  assert.match(seen, /<social_feeds_read_in_depth>/);
  assert.match(seen, /Calm is a skill, not a trait\./, 'the member\'s own post reaches the profile step');
  assert.match(seen, /read: read in depth/);
});
