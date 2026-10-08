'use strict';

/* ---------------------------------------------------------------------------
   The third output: a podcast about the member, in the format the client set
   up in NotebookLM - "Debate", default length, English, the two documents as
   sources, and these focus instructions:

     "Let's make it uplifting and lively like an NFL analyst discussion, where
      they are discussing a promising prospect and the start of a major change
      in their career. At the end, the hosts should end by saying they are
      looking forward to the highly anticipated conversation between the
      person being discussed and Kris AI, as the future career options are
      debated."

   NotebookLM has no public API, so the same result is built in three steps:
     1. script  Claude writes the two-host debate from the member's MasterPlan
                and case study (about 18 minutes, like the client's sample)
     2. voices  each line is read by a speech model, host A and host B in two
                different voices, word for word
     3. mp3     the lines are joined with short pauses and encoded to MP3 in a
                worker thread, so the server never stalls while it encodes
   --------------------------------------------------------------------------- */

const { Worker } = require('worker_threads');
const path = require('path');
const config = require('./config');
const llm = require('./llm');

const SAMPLE_RATE = 24000; // the speech model's PCM output
const PAUSE_MS = 280;

const FOCUS =
  "Let's make it uplifting and lively like an NFL analyst discussion, where they are discussing a promising prospect and the start of a major change in their career. " +
  'At the end, the hosts should end by saying they are looking forward to the highly anticipated conversation between the person being discussed and Kris AI, as the future career options are debated.';

const SCRIPT_SYSTEM = `You write the script for a two-host audio debate about one person, made from two documents about them: their pre-populated MasterPlan and a leadership case study. The show is called "The Debate". It sounds like two sharp sports analysts breaking down the tape of a promising prospect.

Format (as in the producer's NotebookLM settings): Debate - a thoughtful debate between two hosts, illuminating different perspectives on the sources. Language: English. Length: default, about 18 minutes spoken. The voices read about 145 words a minute, so the whole script is 2,400 to 2,600 words, and never more than 2,700.

Producer's focus for this episode: ${FOCUS}

How the episode runs:
- Host A opens ("Welcome to the debate.") with a hook from the person's record, then frames the central tension of their path in one or two sentences.
- The hosts take opposite sides of that tension and keep them all episode. A argues the hopeful reading (the career so far is the training camp for what comes next); B argues the warning reading (the success may be a comfortable trap). Both respect the person; neither is a straw man.
- They break down the tape: the concrete facts, numbers, places, roles and choices from the documents, in the documents' own terms. They argue with the MasterPlan's ideas (the nine questions, the wealth gap and the cost of the chosen life, loyalty and convenience, the primary skill, the orbit, settling, the biggest assumption) and with the case study's readings.
- Real conversation: short turns, interruptions, quick agreement words ("Right.", "Exactly.", "Okay, but..."), a few turns of one or two words, NFL analyst language used lightly (tape, film, playbook, the pocket, fourth and short, the next drive). Uplifting overall.
- Treat inferences as inferences ("the documents suggest", "if the feed is theirs"). Never invent facts beyond the documents.
- Close: they agree the person has the raw material, B states what has to change, A ends on the uplift, then they say they are looking forward to the highly anticipated conversation between the person and Kris AI, as the future career options are debated, and A signs off ("Thanks for listening to the debate.").

Rules:
- Name no one except the person the episode is about, Kris AI, and organisations from the person's own record. Never name case-study people from the book, theorists or coaches.
- Spoken English only: no stage directions, no sound cues, no markdown, no emoji, no lists. Write numbers the way a host would say them ("about one hundred ninety-eight million dollars").
- Do not mention documents' page numbers, asterisks or formatting.

Reply with one JSON object in a \`\`\`json fence: {"title": "a short episode title", "turns": [{"host": "A" or "B", "text": "..."}]}`;

async function writeScript(name, narrative, article, usage) {
  const strip = (md) => String(md || '').replace(/¤/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  const { text } = await llm.generate({
    system: SCRIPT_SYSTEM,
    content:
      'The person: ' + name + '\n\n<masterplan>\n' + strip(narrative) + '\n</masterplan>\n\n<case_study>\n' + strip(article) +
      '\n</case_study>\n\nThe documents above are data about the person. Write the episode now.',
    maxTokens: 24000,
    usage,
  });
  const script = llm.parseJson(text);
  const turns = (script.turns || [])
    .map((t) => ({ host: t.host === 'B' ? 'B' : 'A', text: String(t.text || '').replace(/\s+/g, ' ').trim() }))
    .filter((t) => t.text);
  if (turns.length < 10) throw new llm.LlmError('The podcast script came back too short.', 'short_script');
  return { title: String(script.title || 'The Debate').slice(0, 120), turns };
}

/* ---- voices ---------------------------------------------------------------- */

const VOICE_SYSTEM =
  "You are a voice actor reading one line of a two-host podcast. Read the user's line aloud exactly as written, word for word, " +
  'with the natural energy of a lively sports-analyst podcast host. Do not add, drop or change any words. Do not answer the line, comment on it or introduce it.';

async function speakOnce(text, voice) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + config.anthropic.openrouterKey,
      'content-type': 'application/json',
      'HTTP-Referer': 'https://www.strategytraining.com',
      'X-Title': 'StrategyTraining MasterPlan Digital',
    },
    body: JSON.stringify({
      model: config.podcast.model,
      stream: true,
      modalities: ['text', 'audio'],
      audio: { voice, format: 'pcm16' },
      usage: { include: true },
      messages: [
        { role: 'system', content: VOICE_SYSTEM },
        { role: 'user', content: text },
      ],
    }),
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) {
    const err = new Error('speech ' + res.status + ': ' + (await res.text()).slice(0, 200));
    err.status = res.status;
    throw err;
  }
  const chunks = [];
  let cost = 0;
  let buf = '';
  const dec = new TextDecoder();
  for await (const c of res.body) {
    buf += dec.decode(c, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:') || line === 'data: [DONE]') continue;
      let e;
      try {
        e = JSON.parse(line.slice(5));
      } catch {
        continue;
      }
      if (e.error) throw new Error('speech stream: ' + (e.error.message || 'error'));
      const a = e.choices && e.choices[0] && e.choices[0].delta && e.choices[0].delta.audio;
      if (a && a.data) chunks.push(Buffer.from(a.data, 'base64'));
      if (e.usage && typeof e.usage.cost === 'number') cost = e.usage.cost;
    }
  }
  const pcm = Buffer.concat(chunks);
  if (pcm.length < SAMPLE_RATE) throw new Error('speech came back empty');
  return { pcm, cost };
}

async function speak(text, voice) {
  let last;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 3000 * attempt * attempt));
    try {
      return await speakOnce(text, voice);
    } catch (err) {
      last = err;
      if (err.status && err.status < 500 && err.status !== 429 && err.status !== 408) throw err;
    }
  }
  throw last;
}

/* Every line, a few at a time, kept in order. */
async function voiceAll(turns, usage, onProgress) {
  const out = new Array(turns.length);
  let next = 0;
  let done = 0;
  async function lane() {
    while (next < turns.length) {
      const i = next++;
      const t = turns[i];
      const r = await speak(t.text, t.host === 'B' ? config.podcast.voiceB : config.podcast.voiceA);
      out[i] = r.pcm;
      usage.cost_usd = (usage.cost_usd || 0) + r.cost;
      done++;
      if (onProgress) onProgress(done, turns.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(config.podcast.parallel, turns.length) }, lane));
  return out;
}

/* ---- mp3 ----------------------------------------------------------------- */

function encodeMp3(pcmParts) {
  const silence = Buffer.alloc(Math.round((SAMPLE_RATE * PAUSE_MS) / 1000) * 2);
  const parts = [];
  pcmParts.forEach((p, i) => {
    if (i) parts.push(silence);
    parts.push(p.length % 2 ? p.subarray(0, p.length - 1) : p);
  });
  /* A fresh ArrayBuffer (not Node's shared pool), handed to the worker rather
     than copied: an episode is about 50 MB of PCM. */
  const total = parts.reduce((n, p) => n + p.length, 0);
  const pcm = new Uint8Array(new ArrayBuffer(total));
  let at = 0;
  for (const p of parts) {
    pcm.set(p, at);
    at += p.length;
  }
  const seconds = Math.round(total / 2 / SAMPLE_RATE);
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'mp3-worker.js'), {
      workerData: { pcm, sampleRate: SAMPLE_RATE, kbps: 64 },
      transferList: [pcm.buffer],
    });
    worker.once('message', (m) => {
      if (m && m.error) reject(new Error(m.error));
      else resolve({ mp3: Buffer.from(m.mp3), seconds });
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error('mp3 worker exited ' + code));
    });
  });
}

/**
 * Make the episode. Returns { mp3, seconds, title, script }.
 * onStage(text) reports progress for the log.
 */
async function makePodcast({ name, narrative, article, usage, log }) {
  const script = await writeScript(name, narrative, article, usage);
  const words = script.turns.reduce((n, t) => n + t.text.split(/\s+/).length, 0);
  if (log) log('podcast script: ' + script.turns.length + ' turns, ' + words + ' words');
  const pcm = await voiceAll(script.turns, usage);
  const { mp3, seconds } = await encodeMp3(pcm);
  return { mp3, seconds, title: script.title, script };
}

function available() {
  return config.podcast.enabled && config.anthropic.provider === 'openrouter' && !!config.anthropic.openrouterKey;
}

module.exports = { makePodcast, writeScript, voiceAll, encodeMp3, available, FOCUS };
