'use strict';

/* Loads .env (no dependency - a five line parser is enough) then freezes the
   resolved config. Fails fast on anything missing that would silently
   downgrade security. */

const fs = require('fs');
const path = require('path');

(function loadDotEnv() {
  const file = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    if (process.env[key] !== undefined) continue; // real env wins
    let val = line.slice(eq + 1).trim();
    if (/^(".*"|'.*')$/s.test(val)) val = val.slice(1, -1);
    process.env[key] = val;
  }
})();

function str(key, fallback) {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}
function int(key, fallback) {
  const n = parseInt(process.env[key], 10);
  return Number.isFinite(n) ? n : fallback;
}
function list(key, fallback) {
  return str(key, fallback)
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

const env = str('NODE_ENV', 'development');
const isProd = env === 'production';

const config = {
  env,
  isProd,
  port: int('PORT', 8080),

  buddypro: {
    key: str('BUDDYPRO_API_KEY', ''),
    baseUrl: str('BUDDYPRO_BASE_URL', 'https://api.buddypro.ai').replace(/\/+$/, ''),
    timeoutMs: int('BUDDYPRO_TIMEOUT_MS', 120000),
  },

  memberIdSalt: str('MEMBER_ID_SALT', ''),

  session: {
    secret: str('SESSION_SECRET', ''),
    ttlSeconds: int('SESSION_TTL_SECONDS', 7200),
    cookieName: 'kris_sess',
  },

  store: {
    origin: str('STORE_ORIGIN', 'https://www.strategytraining.com').replace(/\/+$/, ''),
    joinUrl: str('JOIN_URL', 'https://www.strategytraining.com/join'),
    signInUrl: str('SIGN_IN_URL', 'https://www.strategytraining.com/sign_in'),
  },

  allowedFrameOrigins: list(
    'ALLOWED_FRAME_ORIGINS',
    'https://www.strategytraining.com,https://strategytraining.com'
  ),

  uscreen: {
    apiBase: str('USCREEN_API_BASE', '').replace(/\/+$/, ''),
    apiKey: str('USCREEN_API_KEY', ''),
    timeoutMs: int('USCREEN_TIMEOUT_MS', 8000),
  },

  /* strict | frame | open - see .env.example */
  gateMode: str('MEMBER_GATE_MODE', 'strict'),

  /* Voice is off because this BuddyPro instance does not process audio:
     audio-only requests return 500 "Error processing the message", and
     modalities:["text","audio"] returns 200 with no audio object. The client
     recorder is built and tested - flip this to true once BuddyPro enables
     audio on the instance, and verify with `npm run probe:audio`. */
  voiceEnabled: str('VOICE_ENABLED', 'false') === 'true',

  rate: {
    globalPerMin: int('RATE_GLOBAL_PER_MIN', 25),
    sessionPerMin: int('RATE_SESSION_PER_MIN', 12),
  },
};

/* ---- fail fast ---------------------------------------------------------- */
const problems = [];

if (!config.buddypro.key || config.buddypro.key.startsWith('bapi_replace')) {
  problems.push('BUDDYPRO_API_KEY is not set.');
} else if (!config.buddypro.key.startsWith('bapi_')) {
  problems.push('BUDDYPRO_API_KEY does not look like a BuddyPro key (expected a bapi_ prefix).');
}

for (const [key, val] of [
  ['SESSION_SECRET', config.session.secret],
  ['MEMBER_ID_SALT', config.memberIdSalt],
]) {
  if (!val || val.startsWith('replace_me')) problems.push(key + ' is not set.');
  else if (val.length < 32) problems.push(key + ' is too short - use at least 32 characters.');
}

if (!['strict', 'frame', 'open'].includes(config.gateMode)) {
  problems.push('MEMBER_GATE_MODE must be strict, frame or open.');
}
if (config.isProd && config.gateMode === 'open') {
  problems.push('MEMBER_GATE_MODE=open is refused in production - it disables the member gate.');
}
if (config.gateMode === 'strict' && !(config.uscreen.apiBase && config.uscreen.apiKey)) {
  problems.push(
    'MEMBER_GATE_MODE=strict needs USCREEN_API_BASE and USCREEN_API_KEY, ' +
      'otherwise every visitor is denied. Set them, or drop to MEMBER_GATE_MODE=frame.'
  );
}

if (problems.length) {
  console.error('\n[config] Refusing to start:\n' + problems.map((p) => '  - ' + p).join('\n') + '\n');
  process.exit(1);
}

/* Which BuddyPro surface the key belongs to. Owner keys let the instance owner
   read every profile's history; end-user keys do not. See README. */
config.buddypro.surface = config.buddypro.key.startsWith('bapi_B2C_') ? 'end-user' : 'owner';

module.exports = Object.freeze(config);
