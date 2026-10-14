'use strict';

/* ---------------------------------------------------------------------------
   MasterPlan Digital - settings.

   A StrategyTraining.com product that rides on the Kris AI Memory server to
   avoid a second DigitalOcean app. It shares the member gate and nothing else:
   its own keys, its own storage, its own routes under /masterplan. It is NOT
   part of Michael AI and must never use Michael AI's services.

   Every key is prefixed MP_ so it cannot collide with the Kris AI settings.
   The root .env is already loaded by lib/config.js before this file runs.
   --------------------------------------------------------------------------- */

const path = require('path');

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
  enabled: bool('MP_ENABLED', false),

  anthropic: {
    /* openrouter | anthropic. OpenRouter is the default whenever its key is
       set; both reach the same Claude model. */
    provider: str('MP_LLM_PROVIDER', str('MP_OPENROUTER_API_KEY', str('OPENROUTER_API_KEY', '')) ? 'openrouter' : 'anthropic'),
    apiKey: str('MP_ANTHROPIC_API_KEY', ''),
    openrouterKey: str('MP_OPENROUTER_API_KEY', str('OPENROUTER_API_KEY', '')),
    model: '', // resolved below, per provider
    /* Writing quality is the product, so the essays run at high effort. */
    effort: str('MP_EFFORT', 'high'),
    researchEffort: str('MP_RESEARCH_EFFORT', 'medium'),
    maxSearches: int('MP_MAX_SEARCHES', 8),
  },

  storage: {
    /* supabase | disk. disk is for local development and the tests only:
       App Platform's filesystem is wiped on every deploy. disk stays the
       default so a laptop with the keys in .env never writes to production. */
    driver: str('MP_STORAGE', 'disk'),
    diskRoot: str('MP_DISK_ROOT', path.join(__dirname, '..', '.data')),
    prefix: 'masterplan',
    /* Supabase (schema: masterplan/sql/001_storage.sql). The secret key never
       leaves the server; the publishable key is not used at all. */
    supabaseUrl: str('MP_SUPABASE_URL', '').replace(/\/+$/, ''),
    supabaseKey: str('MP_SUPABASE_SECRET_KEY', ''),
    bucket: str('MP_SUPABASE_BUCKET', 'masterplan'),
    table: str('MP_SUPABASE_TABLE', 'mp_records'),
    /* Local copies of PDFs and podcasts, so a re-open is not a re-download. */
    cacheMb: int('MP_FILE_CACHE_MB', 256),
  },

  email: {
    /* resend | webhook | log. log writes the email to the app log, for
       development. resend needs a key from StrategyTraining's own Resend
       account (not Michael AI's) with strategytraining.com verified. */
    driver: str('MP_EMAIL_DRIVER', 'log'),
    resendKey: str('MP_RESEND_API_KEY', ''),
    replyTo: str('MP_EMAIL_REPLY_TO', ''),
    webhookUrl: str('MP_EMAIL_WEBHOOK_URL', ''),
    webhookSecret: str('MP_EMAIL_WEBHOOK_SECRET', ''),
    from: str('MP_EMAIL_FROM', 'StrategyTraining <no-reply@strategytraining.com>'),
  },

  /* Where members open their documents. Used in the email. */
  pageUrl: str('MP_PAGE_URL', 'https://www.strategytraining.com/pages/masterplan-digital'),

  /* Only members with a plan get in (membership.js). Off until the key is
     set; MasterPlan's own key, so Kris AI's settings are untouched. */
  membership: {
    apiKey: str('MP_USCREEN_API_KEY', ''),
    apiBase: str('MP_USCREEN_API_BASE', 'https://www.uscreen.io/publisher_api/v1').replace(/\/+$/, ''),
    timeoutMs: int('MP_USCREEN_TIMEOUT_MS', 6000),
    /* Empty: any active recurring plan counts. Otherwise only these product IDs. */
    planProductIds: str('MP_PLAN_PRODUCT_IDS', '')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0),
    staffDomains: str('MP_STAFF_DOMAINS', 'firmsconsulting.com,strategytraining.com')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  },

  /* Without the API key: the store page's own answer (index.js). enforce
     refuses a member the store turns away from the plan page; observe only
     logs; off ignores it. */
  pagePlanCheck: str('MP_PAGE_PLAN_CHECK', 'enforce'),

  /* Spend guards. One report is roughly a dozen model calls. */
  perMemberPerDay: int('MP_PER_MEMBER_PER_DAY', 2),
  globalPerDay: int('MP_GLOBAL_PER_DAY', 40),
  concurrency: int('MP_CONCURRENCY', 1),

  /* The third output: the two-host debate podcast (podcast.js). Needs the
     OpenRouter provider, which carries the speech model. */
  podcast: {
    enabled: bool('MP_PODCAST', true),
    model: str('MP_PODCAST_MODEL', 'openai/gpt-audio'),
    /* As in the client's sample: a woman leads (host A), a man is the sceptic (host B).
       Chosen 2026-10-14: of five pairs judged against the sample, sage + verse came
       closest (best in 3 of 4 rounds). They talk at about 161 words a minute against
       the sample's 179, so the episode is played 1.11 times as fast at the same pitch. */
    voiceA: str('MP_PODCAST_VOICE_A', 'sage'),
    voiceB: str('MP_PODCAST_VOICE_B', 'verse'),
    tempo: Math.min(1.4, Math.max(0.8, Number(process.env.MP_PODCAST_TEMPO || 1.11))),
    parallel: int('MP_PODCAST_PARALLEL', 4),
    /* How much the top end of each voice is softened (0 to 1), against the speech model's sizzle. */
    softenA: Math.min(1, Math.max(0, Number(process.env.MP_PODCAST_SOFTEN_A || 0.35))),
    softenB: Math.min(1, Math.max(0, Number(process.env.MP_PODCAST_SOFTEN_B || 0.35))),
    /* OpenAI's speech model with the client's own OpenAI key (podcast.js): each
       line voiced with a written direction matching the sample's hosts. */
    openai: {
      apiKey: str('MP_OPENAI_API_KEY', ''),
      model: str('MP_OPENAI_TTS_MODEL', 'gpt-4o-mini-tts'),
      voiceA: str('MP_OPENAI_VOICE_A', 'sage'), // the woman who leads
      voiceB: str('MP_OPENAI_VOICE_B', 'verse'), // the sceptic
      perMinute: Number(process.env.MP_OPENAI_TTS_PER_MINUTE || 0.015), // dollars per minute of speech, for the cost log
    },
    /* Google's two-speaker speech (podcast-gemini.js), used when the key is set: the closest to NotebookLM. */
    gemini: {
      apiKey: str('MP_GEMINI_API_KEY', ''),
      /* Chosen 2026-10-14 against the client's NotebookLM sample: of 10 set-ups,
         the 2.5 model directed with the sample's own description, Gacrux (the
         woman who leads) and Orus (the sceptic), sounded closest. */
      model: str('MP_GEMINI_TTS_MODEL', 'gemini-2.5-flash-preview-tts'),
      voiceA: str('MP_GEMINI_VOICE_A', 'Gacrux'),
      voiceB: str('MP_GEMINI_VOICE_B', 'Orus'),
      /* Pauses inside Google's speech made this much longer, to the sample's relaxed pace. */
      /* Words per request. Each request is voiced on its own, so a voice can come back a
         little different in the next part: bigger parts, fewer such joins. */
      partWords: int('MP_GEMINI_PART_WORDS', 1100), // tested: 1,050 words came back whole (5.6 min) in one request
      pauseFactor: Math.min(2, Math.max(1, Number(process.env.MP_GEMINI_PAUSE_FACTOR || 1.55))),
      /* Dollars per million tokens, for the cost log and the daily ceiling. */
      inputPerMillion: Number(process.env.MP_GEMINI_TTS_INPUT_PER_M || 0.5),
      outputPerMillion: Number(process.env.MP_GEMINI_TTS_OUTPUT_PER_M || 10),
    },
  },

  /* Brand line in every PDF footer, as the client asked: "Produced on
     strategytraining.com" and "with Michael AI". */
  brandLine: str('MP_BRAND_LINE', 'Produced on StrategyTraining.com with Michael AI'),
  preparedBy: str('MP_PREPARED_BY', 'Prepared by FIRMSconsulting / StrategyTraining.com'),

  /* Local development: the email used when the gate is open. */
  devEmail: str('MP_DEV_EMAIL', 'dev@example.com'),

  maxUploadBytes: int('MP_MAX_UPLOAD_BYTES', 8 * 1024 * 1024),
};

/* Reasons the module cannot run. Reported on /masterplan/healthz and in the
   log - never fatal, because the Kris AI widget on the same server must keep
   working whatever state this module is in. */
config.anthropic.model = str(
  'MP_MODEL',
  config.anthropic.provider === 'openrouter' ? 'anthropic/claude-opus-5.5' : 'claude-opus-5-5'
);

config.problems = [];
if (config.anthropic.provider === 'openrouter') {
  if (!config.anthropic.openrouterKey) config.problems.push('MP_OPENROUTER_API_KEY is not set.');
} else if (config.anthropic.provider === 'anthropic') {
  if (!config.anthropic.apiKey) config.problems.push('MP_ANTHROPIC_API_KEY is not set.');
} else {
  config.problems.push('MP_LLM_PROVIDER must be openrouter or anthropic.');
}
if (config.storage.driver === 'supabase') {
  if (!config.storage.supabaseUrl) config.problems.push('MP_SUPABASE_URL is not set.');
  if (!config.storage.supabaseKey) config.problems.push('MP_SUPABASE_SECRET_KEY is not set.');
} else if (config.storage.driver !== 'disk') {
  config.problems.push('MP_STORAGE must be supabase or disk.');
}
if (config.email.driver === 'resend' && !config.email.resendKey) config.problems.push('MP_RESEND_API_KEY is not set.');

module.exports = config;
