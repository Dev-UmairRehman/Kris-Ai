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
    /* spaces | disk. disk is for local development only: App Platform's
       filesystem is wiped on every deploy. */
    driver: str('MP_STORAGE', 'disk'),
    diskRoot: str('MP_DISK_ROOT', path.join(__dirname, '..', '.data')),
    endpoint: str('MP_SPACES_ENDPOINT', '').replace(/\/+$/, ''), // https://fra1.digitaloceanspaces.com
    bucket: str('MP_SPACES_BUCKET', ''),
    key: str('MP_SPACES_KEY', ''),
    secret: str('MP_SPACES_SECRET', ''),
    prefix: str('MP_SPACES_PREFIX', 'masterplan'),
  },

  email: {
    /* log | webhook. The delivery method is still to be supplied; until then
       the email is written to the log so nothing is lost. */
    driver: str('MP_EMAIL_DRIVER', 'log'),
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

  /* Brand line in every PDF footer, as on Kris AI. */
  brandLine: str('MP_BRAND_LINE', 'FIRMSconsulting  ·  Michael.ai  ·  StrategyTraining.com'),
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
if (config.storage.driver === 'spaces') {
  for (const [k, v] of [
    ['MP_SPACES_ENDPOINT', config.storage.endpoint],
    ['MP_SPACES_BUCKET', config.storage.bucket],
    ['MP_SPACES_KEY', config.storage.key],
    ['MP_SPACES_SECRET', config.storage.secret],
  ]) {
    if (!v) config.problems.push(k + ' is not set.');
  }
} else if (config.storage.driver !== 'disk') {
  config.problems.push('MP_STORAGE must be spaces or disk.');
}

module.exports = config;
