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

  /* Spend guards. One report is roughly a dozen model calls. */
  perMemberPerDay: int('MP_PER_MEMBER_PER_DAY', 2),
  globalPerDay: int('MP_GLOBAL_PER_DAY', 40),
  concurrency: int('MP_CONCURRENCY', 1),

  /* The third output: the two-host debate podcast (podcast.js). Needs the
     OpenRouter provider, which carries the speech model. */
  podcast: {
    enabled: bool('MP_PODCAST', true),
    model: str('MP_PODCAST_MODEL', 'openai/gpt-audio'),
    voiceA: str('MP_PODCAST_VOICE_A', 'ash'),
    voiceB: str('MP_PODCAST_VOICE_B', 'coral'),
    parallel: int('MP_PODCAST_PARALLEL', 4),
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
