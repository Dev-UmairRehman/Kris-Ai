'use strict';

/* ---------------------------------------------------------------------------
   The podcast's voices from Google: Gemini's two-speaker speech, the same
   family of speech technology NotebookLM's Audio Overviews are made with.

   The difference from the line-by-line voices (podcast.js): Gemini voices a
   stretch of the conversation in one pass, both hosts together, so turn
   timing, reactions, breaths and the way one host answers the other come
   from the model, as in the client's NotebookLM sample - not from a mix.

   The script is sent in parts of about two minutes (a request's audio is
   capped at a few minutes), split between turns, voiced a few at a time and
   joined. Needs MP_GEMINI_API_KEY (Google AI Studio); without it the
   podcast uses the line-by-line voices.
   --------------------------------------------------------------------------- */

const config = require('./config');

const SAMPLE_RATE = 24000; // Gemini speech: 16-bit mono PCM at 24 kHz
const PART_WORDS = 330; // about two minutes of speech per request
const SPEAKERS = { A: 'Alex', B: 'Sam' }; // names the model uses to tell the hosts apart; never spoken

function available() {
  return !!config.podcast.gemini.apiKey;
}

/* The script as Gemini reads it: reactions become the other host's quick
   word at the start of their next turn, or a turn of their own. */
function toDialogue(turns) {
  const out = [];
  turns.forEach((t, i) => {
    out.push({ host: t.host, text: t.text });
    if (!t.react) return;
    const other = t.host === 'A' ? 'B' : 'A';
    const next = turns[i + 1];
    if (next && next.host === other) next.text = t.react + ' ' + next.text;
    else out.push({ host: other, text: t.react });
  });
  return out;
}

/* Parts of about PART_WORDS words, split between turns. */
function parts(dialogue) {
  const out = [];
  let cur = [];
  let n = 0;
  for (const t of dialogue) {
    const w = t.text.split(/\s+/).length;
    if (cur.length && n + w > PART_WORDS) {
      out.push(cur);
      cur = [];
      n = 0;
    }
    cur.push(t);
    n += w;
  }
  if (cur.length) out.push(cur);
  return out;
}

const STYLE =
  'Voice this as an unscripted, lively two-host podcast conversation called "The Debate": two friends who borrow sports-analyst language, talking in one room, never like announcers or narrators. ' +
  SPEAKERS.A + ' is warm, upbeat and optimistic; ' + SPEAKERS.B + ' is calm, dry and sceptical with a wry edge. ' +
  'Natural pace that speeds up and slows down with the thought, quick back-and-forth, real reactions to each other, breaths, and laughs where the words laugh. Read every word exactly as written.';

function prompt(part, first, last) {
  const where = first ? '' : 'This continues a conversation already under way: no greeting, no fresh start. ';
  const end = last ? '' : 'The conversation goes on after this part: do not wind down at the end. ';
  return STYLE + ' ' + where + end + '\n\n' + part.map((t) => SPEAKERS[t.host] + ': ' + t.text).join('\n');
}

async function voicePartOnce(text) {
  const g = config.podcast.gemini;
  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(g.model) + ':generateContent', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': g.apiKey },
    body: JSON.stringify({
      contents: [{ parts: [{ text }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          multiSpeakerVoiceConfig: {
            speakerVoiceConfigs: [
              { speaker: SPEAKERS.A, voiceConfig: { prebuiltVoiceConfig: { voiceName: g.voiceA } } },
              { speaker: SPEAKERS.B, voiceConfig: { prebuiltVoiceConfig: { voiceName: g.voiceB } } },
            ],
          },
        },
      },
    }),
    signal: AbortSignal.timeout(300000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error('gemini speech ' + res.status + ': ' + JSON.stringify(body.error || body).slice(0, 200));
    err.status = res.status;
    throw err;
  }
  const chunks = [];
  for (const p of (((body.candidates || [])[0] || {}).content || {}).parts || []) {
    if (p.inlineData && p.inlineData.data) chunks.push(Buffer.from(p.inlineData.data, 'base64'));
  }
  const pcm = Buffer.concat(chunks);
  if (pcm.length < SAMPLE_RATE * 2) throw new Error('gemini speech came back empty');
  const u = body.usageMetadata || {};
  const cost = ((u.promptTokenCount || 0) * g.inputPerMillion + (u.candidatesTokenCount || 0) * g.outputPerMillion) / 1e6;
  return { pcm, cost };
}

async function voicePart(text) {
  let last;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 4000 * attempt * attempt));
    try {
      return await voicePartOnce(text);
    } catch (err) {
      last = err;
      if (err.status && err.status < 500 && err.status !== 429 && err.status !== 408) throw err;
    }
  }
  throw last;
}

/** Every part, a few at a time, in order. Returns raw PCM buffers. */
async function voiceAll(turns, usage, onProgress) {
  const list = parts(toDialogue(turns.map((t) => ({ ...t }))));
  const out = new Array(list.length);
  let next = 0;
  let done = 0;
  async function lane() {
    while (next < list.length) {
      const i = next++;
      const r = await voicePart(prompt(list[i], i === 0, i === list.length - 1));
      out[i] = r.pcm;
      usage.cost_usd = (usage.cost_usd || 0) + r.cost;
      done++;
      if (onProgress) onProgress(done, list.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(config.podcast.parallel, list.length) }, lane));
  return out;
}

module.exports = { available, voiceAll, toDialogue, parts, prompt, SPEAKERS, SAMPLE_RATE };
