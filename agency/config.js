'use strict';

/* ---------------------------------------------------------------------------
   Your Marketing Agency - settings.

   A StrategyTraining.com product that lives next to MasterPlan Digital on the
   Kris AI Memory server and shares its member login, plan check, storage and
   model access. Its own settings are prefixed YMA_.

   Every job uses the cheapest model that does it well; the strongest model
   only writes what the member reads and publishes. Every paid job has a daily
   limit per member and for the whole site.
   --------------------------------------------------------------------------- */

const mp = require('../masterplan/config');

function str(key, fallback) {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}
function int(key, fallback) {
  const n = parseInt(process.env[key], 10);
  return Number.isFinite(n) ? n : fallback;
}
function bool(key, fallback) {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return v === 'true' || v === '1';
}

const config = {
  enabled: bool('YMA_ENABLED', false),

  models: {
    /* Audio to text. About 7 cents for an hour of speech. */
    transcribe: str('YMA_MODEL_TRANSCRIBE', 'google/gemini-3.5-flash-lite'),
    /* Reads each answer into the profile and story bank; judges what is private. */
    profile: str('YMA_MODEL_PROFILE', 'anthropic/claude-sonnet-5.5'),
    /* Topic ideas. */
    ideas: str('YMA_MODEL_IDEAS', 'anthropic/claude-sonnet-5.5'),
    /* Scripts, posts and titles: what the member publishes. */
    write: str('YMA_MODEL_WRITE', 'anthropic/claude-opus-5.5'),
    /* Cover pictures; the title text is drawn by the page, not the model. */
    image: str('YMA_MODEL_IMAGE', 'google/gemini-3.1-flash-image'),
    /* Reads the numbers off an analytics screenshot. */
    vision: str('YMA_MODEL_VISION', 'google/gemini-3.5-flash-lite'),
  },

  /* Instagram and TikTok numbers from the member's @handle (social.js), read
     through Apify. Off without a token; the member can still type views. */
  social: {
    apifyToken: str('YMA_APIFY_TOKEN', ''),
    instagramActor: str('YMA_APIFY_INSTAGRAM_ACTOR', 'apify~instagram-reel-scraper'),
    tiktokActor: str('YMA_APIFY_TIKTOK_ACTOR', 'clockworks~tiktok-scraper'),
    /* Charged per video: the first read takes this many, later reads only the newest few. */
    videosPerRead: int('YMA_SOCIAL_VIDEOS_PER_READ', 12),
    refreshVideos: int('YMA_SOCIAL_REFRESH_VIDEOS', 6),
    /* Re-read a connected account when its numbers are older than this. */
    refreshHours: int('YMA_SOCIAL_REFRESH_HOURS', 24),
  },

  /* A new question every few days once the starter questions are answered. */
  nextEveryDays: int('YMA_NEXT_EVERY_DAYS', 2),

  /* Per member per day, then for the whole site per day. */
  limits: {
    answers: int('YMA_ANSWERS_PER_DAY', 15),
    audioMinutes: int('YMA_AUDIO_MINUTES_PER_DAY', 90),
    ideas: int('YMA_IDEA_BATCHES_PER_DAY', 4),
    packs: int('YMA_PACKS_PER_DAY', 8),
    covers: int('YMA_COVERS_PER_DAY', 8),
    insights: int('YMA_INSIGHTS_PER_DAY', 3),
    socialReads: int('YMA_SOCIAL_READS_PER_DAY', 8),
    screenshots: int('YMA_SCREENSHOTS_PER_DAY', 15),
    globalCost: int('YMA_GLOBAL_DOLLARS_PER_DAY', 40),
  },
  maxAudioBytes: int('YMA_MAX_AUDIO_BYTES', 40 * 1024 * 1024),
  maxAudioMinutes: int('YMA_MAX_AUDIO_MINUTES', 45),
  maxPhotoBytes: int('YMA_MAX_PHOTO_BYTES', 6 * 1024 * 1024),
  maxScreenshotBytes: int('YMA_MAX_SCREENSHOT_BYTES', 8 * 1024 * 1024),
  maxAnswerChars: int('YMA_MAX_ANSWER_CHARS', 60000),

  /* The page the member works on (used in links). */
  pageUrl: str('YMA_PAGE_URL', 'https://www.strategytraining.com/pages/your-marketing-agency'),
};

/* It runs on MasterPlan's model access and storage, so it can only run where
   MasterPlan can. */
config.problems = [];
if (mp.anthropic.provider !== 'openrouter') config.problems.push('Your Marketing Agency needs MP_LLM_PROVIDER=openrouter (it uses several models).');
if (!mp.anthropic.openrouterKey) config.problems.push('MP_OPENROUTER_API_KEY is not set.');
for (const p of mp.problems) if (!config.problems.includes(p)) config.problems.push(p);

module.exports = config;
