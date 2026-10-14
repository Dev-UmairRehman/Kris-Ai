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

   Two request shapes (tested 2026-10-14): the 3.x speech models take each
   turn as its own part tagged with its speaker and refuse a separate style
   instruction; the 2.5 models take one transcript ("Alex: ...") with the
   style written above it. Audio comes back as WAV or raw 16-bit PCM.
   --------------------------------------------------------------------------- */

const config = require('./config');

const SAMPLE_RATE = 24000; // Gemini speech: 16-bit mono PCM at 24 kHz
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
    if (cur.length && n + w > config.podcast.gemini.partWords) {
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

/* The hosts as they sound in the client's NotebookLM sample (described by
   an audio model from the sample, 2026-10-14): the woman leads and argues the
   hopeful side, the man is the sceptic. */
const STYLE =
  'Voice this as an unscripted two-host debate podcast called "The Debate": the energy of sports talk radio applied to a career, but relaxed, natural conversational banter, unhurried, with real pauses between thoughts; polished but never like announcers reading. ' +
  SPEAKERS.A + ' (woman, mid-30s, General American) leads: warm, full, chest-resonant voice with no vocal fry, bright and forward, high and engaging energy with an upbeat, bouncy optimism and a wide pitch range, lifts her pitch on key words, smiles while she talks, says "Exactly" and "Spot on" with real enthusiasm, about 140 words a minute. ' +
  SPEAKERS.B + ' (man, around 40, General American) is the sceptical analyst: low-mid, dry, clear and grounded, a little vocal fry, punchy consonants, drops his pitch at the end of a point, clipped "Right" before pivoting to the counterpoint, quickens a little during analysis, about 145 words a minute. ' +
  'They react to each other in the moment, with breaths and light laughs where the words laugh. Read every word exactly as written.';

/* The 2.5 models: one transcript with the style above it. */
const transcriptStyle = (model) => /^gemini-2./.test(model);

function prompt(part, first, last) {
  const where = first ? '' : 'This continues a conversation already under way, with exactly the same voices, pace and energy as before: no greeting, no fresh start. ';
  const end = last ? '' : 'The conversation goes on after this part: do not wind down at the end. ';
  return STYLE + ' ' + where + end + '\n\n' + part.map((t) => SPEAKERS[t.host] + ': ' + t.text).join('\n');
}

function contents(part, first, last) {
  if (transcriptStyle(config.podcast.gemini.model)) return [{ parts: [{ text: prompt(part, first, last) }] }];
  return [{ role: 'user', parts: part.map((t) => ({ text: t.text, speechMetadata: { speaker: SPEAKERS[t.host] } })) }];
}

/* Raw 16-bit PCM from what came back: a WAV's data chunk, or the bytes as they are. */
function pcmFrom(buf) {
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'RIFF') return buf;
  let i = 12;
  while (i + 8 <= buf.length) {
    const id = buf.toString('latin1', i, i + 4);
    const n = buf.readUInt32LE(i + 4);
    if (id === 'fmt ') {
      const rate = buf.readUInt32LE(i + 12);
      const bits = buf.readUInt16LE(i + 22);
      const channels = buf.readUInt16LE(i + 10);
      if (rate !== SAMPLE_RATE || bits !== 16 || channels !== 1) throw new Error('gemini speech: unexpected audio ' + rate + ' Hz ' + bits + '-bit ' + channels + 'ch');
    }
    if (id === 'data') return buf.subarray(i + 8, Math.min(buf.length, i + 8 + n));
    i += 8 + n + (n % 2);
  }
  throw new Error('gemini speech: a WAV without audio');
}

async function voicePartOnce(part, first, last) {
  const g = config.podcast.gemini;
  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(g.model) + ':generateContent', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': g.apiKey },
    body: JSON.stringify({
      contents: contents(part, first, last),
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
    /* How long Google asks us to wait (free tier: a few requests a minute). */
    const retry = ((body.error && body.error.details) || []).find((d) => d.retryDelay);
    if (retry) err.retryMs = Math.round(parseFloat(retry.retryDelay) * 1000);
    throw err;
  }
  const chunks = [];
  for (const p of (((body.candidates || [])[0] || {}).content || {}).parts || []) {
    if (p.inlineData && p.inlineData.data) chunks.push(pcmFrom(Buffer.from(p.inlineData.data, 'base64')));
  }
  const pcm = Buffer.concat(chunks);
  if (pcm.length < SAMPLE_RATE * 2) throw new Error('gemini speech came back empty');
  const u = body.usageMetadata || {};
  const cost = ((u.promptTokenCount || 0) * g.inputPerMillion + (u.candidatesTokenCount || 0) * g.outputPerMillion) / 1e6;
  return { pcm, cost };
}

async function voicePart(part, first, last) {
  let lastErr;
  let waitMs = 0;
  for (let attempt = 0; attempt < 7; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, Math.min(65000, waitMs || 4000 * attempt * attempt)));
    try {
      return await voicePartOnce(part, first, last);
    } catch (err) {
      lastErr = err;
      waitMs = err.retryMs ? err.retryMs + 1000 : 0;
      if (err.status && err.status < 500 && err.status !== 429 && err.status !== 408) throw err;
    }
  }
  throw lastErr;
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
      const r = await voicePart(list[i], i === 0, i === list.length - 1);
      out[i] = r.pcm;
      usage.cost_usd = (usage.cost_usd || 0) + r.cost;
      done++;
      if (onProgress) onProgress(done, list.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(config.podcast.parallel, list.length) }, lane));
  return out;
}

module.exports = { available, voiceAll, toDialogue, parts, prompt, contents, pcmFrom, SPEAKERS, SAMPLE_RATE };
