'use strict';

/* ---------------------------------------------------------------------------
   BuddyPro client.

   Contract highlights that shape this file (docs.buddypro.ai):
     - POST {base}/v1/chat/completions, OpenAI shaped, Bearer bapi_ key.
     - Send EXACTLY ONE user message. BuddyPro keeps the whole conversation
       history and long term memory server side, so replaying prior turns is
       both unnecessary and wrong.
     - No streaming. One request, one complete answer.
     - `model` is accepted and ignored.
     - `user` selects an isolated profile with its own history and memory. We
       pass a salted hash of the StrategyTraining member id, so each member
       gets a private thread and BuddyPro never sees who they are.
     - An error can arrive with HTTP 200 and an `error` object in the body.
       Always inspect the body.
     - The prompt override fields exist on the Owner API only; the End-user API
       rejects them with 400 unsupported_parameter. They are opt in here.
   --------------------------------------------------------------------------- */

const crypto = require('crypto');
const config = require('./config');

const ENDPOINT = config.buddypro.baseUrl + '/v1/chat/completions';
const MAX_TEXT_CHARS = 50000;

class BuddyProError extends Error {
  constructor(message, { status = 502, code = 'upstream_error', retryAfter = null } = {}) {
    super(message);
    this.name = 'BuddyProError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

/* Maps BuddyPro's error codes onto what the browser should be told. The member
   never sees billing or key problems - those are ours to fix. */
function describeUpstreamError(code, status) {
  switch (code) {
    case 'missing_api_key':
    case 'invalid_api_key':
      return { status: 503, message: 'Kris AI is not configured correctly. Please try again later.' };
    case 'billing_not_set_up':
    case 'insufficient_credits':
    case 'insufficient_credits_recharging':
    case 'owner_billing_unavailable':
      return { status: 503, message: 'Kris AI is temporarily unavailable. Please try again later.' };
    case 'insufficient_permissions':
      return { status: 503, message: 'Kris AI is temporarily unavailable. Please try again later.' };
    case 'rate_limit_exceeded':
      return { status: 429, message: 'Kris is answering a lot of questions right now. Try again in a moment.' };
    case 'invalid_text_content':
    case 'invalid_value':
    case 'missing_required_parameter':
      return { status: 400, message: 'That message could not be sent. Try rephrasing it.' };
    default:
      return {
        status: status >= 500 ? 502 : 502,
        message: 'That did not go through. Try again in a moment.',
      };
  }
}

/** BuddyPro caps X-Client-Request-Id at 64 chars of [A-Za-z0-9_-]. */
function requestId() {
  return 'kris-' + crypto.randomBytes(12).toString('hex');
}

/**
 * Ask Kris one question.
 *
 * @param {object}  opts
 * @param {string}  opts.text          the member's message
 * @param {string}  opts.profileId     BuddyPro `user` - isolated per member
 * @param {boolean} [opts.wantAudio]   also return spoken audio
 * @param {boolean} [opts.saveHistory] persist to history/memory (default true)
 * @param {string}  [opts.audioInput]  base64 audio instead of text
 * @param {string}  [opts.audioFormat] mp3 | wav | ogg | aac | flac
 * @returns {Promise<{content:string, audio:?object, image:?object, id:string}>}
 */
async function ask(opts) {
  const {
    text,
    profileId,
    wantAudio = false,
    saveHistory = true,
    audioInput = null,
    audioFormat = 'mp3',
  } = opts || {};

  const hasAudio = typeof audioInput === 'string' && audioInput.length > 0;
  const trimmed = typeof text === 'string' ? text.trim() : '';

  if (!hasAudio && !trimmed) {
    throw new BuddyProError('Empty message.', { status: 400, code: 'empty_message' });
  }
  if (trimmed.length > MAX_TEXT_CHARS) {
    throw new BuddyProError('Message too long.', { status: 400, code: 'invalid_text_content' });
  }

  /* Exactly one user message. Audio input replaces text when present. */
  const content = hasAudio
    ? [{ type: 'input_audio', input_audio: { data: audioInput, format: audioFormat } }]
    : trimmed;

  const body = {
    messages: [{ role: 'user', content }],
    user: profileId,
    x_buddy_saveToHistory: saveHistory,
  };

  if (wantAudio) {
    body.modalities = ['text', 'audio'];
    body.audio = { format: 'mp3' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.buddypro.timeoutMs);

  let res;
  let payload;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + config.buddypro.key,
        'Content-Type': 'application/json',
        'X-Client-Request-Id': requestId(),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const raw = await res.text();
    try {
      payload = raw ? JSON.parse(raw) : null;
    } catch {
      throw new BuddyProError('Upstream returned a non JSON response.', { status: 502 });
    }
  } catch (err) {
    if (err instanceof BuddyProError) throw err;
    if (err.name === 'AbortError') {
      throw new BuddyProError('Kris took too long to answer. Try again.', {
        status: 504,
        code: 'timeout',
      });
    }
    throw new BuddyProError('Could not reach Kris AI. Try again in a moment.', { status: 502 });
  } finally {
    clearTimeout(timer);
  }

  /* An error may be present even on HTTP 200. */
  const upstreamError = payload && payload.error;
  if (upstreamError || !res.ok) {
    const code = (upstreamError && upstreamError.code) || 'upstream_error';
    const status = (upstreamError && upstreamError.statusCode) || res.status;
    const mapped = describeUpstreamError(code, status);

    /* Log the real cause; never leak it to the browser. */
    console.error(
      '[buddypro] %s %s: %s',
      status,
      code,
      (upstreamError && upstreamError.message) || 'no message'
    );

    throw new BuddyProError(mapped.message, {
      status: mapped.status,
      code,
      retryAfter: res.headers.get('retry-after'),
    });
  }

  const choice = payload.choices && payload.choices[0];
  const message = choice && choice.message;

  if (!message || typeof message.content !== 'string') {
    throw new BuddyProError('Kris returned an empty answer. Try again.', { status: 502 });
  }

  return {
    id: payload.id || null,
    content: message.content,
    /* Audio and images come back base64. Turned into data URLs at the edge of
       the API layer so the browser can use them directly. */
    audio: message.audio
      ? {
          dataUrl: 'data:' + (message.audio.media_type || 'audio/mpeg') + ';base64,' + message.audio.data,
          transcript: message.audio.transcript || null,
        }
      : null,
    image: message.image
      ? {
          dataUrl: 'data:' + (message.image.media_type || 'image/png') + ';base64,' + message.image.data,
          caption: message.image.caption || null,
        }
      : null,
  };
}

module.exports = { ask, BuddyProError, ENDPOINT, MAX_TEXT_CHARS };
