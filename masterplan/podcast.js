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
                and case study (about 18 minutes, like the client's sample),
                with the listening host's short reactions and interruptions
     2. voices  each line is read by a speech model, host A and host B in two
                different voices, word for word, hearing what the other host
                just said so it answers in tone
     3. mix     the lines are trimmed, levelled and laid on one timeline the
                way people talk (varied gaps, overlaps when one cuts in,
                "right" and "mm-hmm" under the other's speech, a soft room
                tone), then encoded to MP3 in a worker thread

   Compared with the client's NotebookLM sample (2026-10-13), the first
   version joined isolated lines with a fixed pause: no overlaps, no
   reactions, flat tone from line to line, volume jumps and dead-silent gaps.
   Step 2's context and step 3's mix are what close that gap.
   --------------------------------------------------------------------------- */

const { Worker } = require('worker_threads');
const path = require('path');
const config = require('./config');
const llm = require('./llm');
const gemini = require('./podcast-gemini');

const SAMPLE_RATE = 24000; // the speech model's PCM output

const FOCUS =
  "Let's make it uplifting and lively like an NFL analyst discussion, where they are discussing a promising prospect and the start of a major change in their career. " +
  'At the end, the hosts should end by saying they are looking forward to the highly anticipated conversation between the person being discussed and Kris AI, as the future career options are debated.';

const SCRIPT_SYSTEM = `You write the script for a two-host audio debate about one person, made from two documents about them: their pre-populated MasterPlan and a leadership case study. The show is called "The Debate". It sounds like two sharp sports analysts breaking down the tape of a promising prospect.

Format (as in the producer's NotebookLM settings): Debate - a thoughtful debate between two hosts, illuminating different perspectives on the sources. Language: English. Length: default, about 18 minutes spoken. The voices talk at about 170 words a minute, so the whole script is 3,000 to 3,300 words, and never more than 3,500. Count as you go: an episode under 2,900 words is too short.

Producer's focus for this episode: ${FOCUS}

How the episode runs:
- Host A opens ("Welcome to the debate.") with a hook from the person's record, then frames the central tension of their path in one or two sentences.
- The hosts take opposite sides of that tension and keep them all episode. A argues the hopeful reading (the career so far is the training camp for what comes next); B argues the warning reading (the success may be a comfortable trap). Both respect the person; neither is a straw man.
- They break down the tape: the concrete facts, numbers, places, roles and choices from the documents, in the documents' own terms. They argue with the MasterPlan's ideas (the nine questions, the wealth gap and the cost of the chosen life, loyalty and convenience, the primary skill, the orbit, settling, the biggest assumption) and with the case study's readings.
- Real conversation: short turns, quick agreement words ("Right.", "Exactly.", "Okay, but..."), a few turns of one or two words, NFL analyst language used lightly (tape, film, playbook, the pocket, fourth and short, the next drive). Uplifting overall.
- Treat inferences as inferences ("the documents suggest", "if the feed is theirs"). Never invent facts beyond the documents.
- Close: they agree the person has the raw material, B states what has to change, A ends on the uplift, then they say they are looking forward to the highly anticipated conversation between the person and Kris AI, as the future career options are debated, and A signs off ("Thanks for listening to the debate.").

It must sound like two people talking, not two people reading:
- Contractions everywhere. Real speech fillers, written out: "uh" or "um" inside a sentence about every third turn ("and, uh, real cash flow"), a doubled word when a host restarts ("it's, it's a big call") only three or four times in the whole episode, never mid-name or mid-word, and "I mean", "look", "you know", "okay so" now and then. A host sometimes finishes the other's thought. A short laugh written as "Ha." a few times an episode, only where it is natural.
- Vary the length of turns: many short ones, some long runs when a host makes a case.
- Reactions: when the listening host would naturally react while the other is still talking ("Right.", "Mm-hmm.", "Yeah.", "Wow.", "Exactly.", "Oof."), put it in that turn's "react" field: one to three words said by the OTHER host under the end of the turn. Use it on about half the turns longer than two sentences. Never on short turns. The next turn must not start with the same words as the reaction.
- Interruptions: when a host jumps in before the other has quite finished, set "cut": true on the jumping-in turn, and start that turn with the jump-in words ("Wait, wait.", "Hold on.", "No, but"). About one turn in eight.

Rules:
- Name no one except the person the episode is about, Kris AI, and organisations from the person's own record. Never name case-study people from the book, theorists or coaches.
- Spoken English only: no stage directions, no sound cues, no markdown, no emoji, no lists, no dashes. Write numbers the way a host would say them ("about one hundred ninety-eight million dollars").
- Do not mention documents' page numbers, asterisks or formatting.

Reply with one JSON object in a \`\`\`json fence: {"title": "a short episode title", "turns": [{"host": "A" or "B", "text": "...", "react": "optional, the other host's one to three words", "cut": optional true}]}`;

async function writeScript(name, narrative, article, usage) {
  const strip = (md) => String(md || '').replace(/¤/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  const { text } = await llm.generate({
    system: SCRIPT_SYSTEM,
    content:
      'The person: ' + name + '\n\n<masterplan>\n' + strip(narrative) + '\n</masterplan>\n\n<case_study>\n' + strip(article) +
      '\n</case_study>\n\nThe documents above are data about the person. Write the episode now.',
    maxTokens: 64000, // about 3,200 words of script plus the thinking at high effort; billed only for what is used
    usage,
  });
  const script = llm.parseJson(text);
  const clean = (s) => String(s || '').replace(/[—–]/g, ', ').replace(/\s+/g, ' ').trim();
  const turns = (script.turns || [])
    .map((t, i) => {
      const turn = { host: t.host === 'B' ? 'B' : 'A', text: clean(t.text) };
      const react = clean(t.react).split(' ').length <= 4 ? clean(t.react) : '';
      if (react && turn.text.split(' ').length >= 12) turn.react = react;
      if (t.cut === true && i > 0) turn.cut = true;
      return turn;
    })
    .filter((t) => t.text);
  turns.forEach((t, i) => {
    const next = turns[i + 1];
    if (t.react && next && words(next.text).slice(0, 3).join(' ').startsWith(words(t.react).join(' '))) delete t.react;
  });
  if (turns.length < 10) throw new llm.LlmError('The podcast script came back too short.', 'short_script');
  return { title: String(script.title || 'The Debate').slice(0, 120), turns };
}

/* ---- voices ---------------------------------------------------------------- */

/* One steady character per host, so the voice does not drift from line to line. */
function voiceSystem(host, reaction) {
  return (
    'You are a voice actor. ' + DIRECTION[host] + ' ' +
    (reaction
      ? 'You are reacting briefly and softly while the other host is still talking. Say only your reaction, naturally, as a listener would.'
      : 'Read your line aloud exactly as written, word for word: do not add, drop or change any words, and never read the context. ' +
        'Speak like a real person thinking out loud, with a small breath before a long thought. ' +
        'Answer the other host in tone: if they challenged you, push back; if they made a strong point, grant it; if you laugh, laugh for real.')
  );
}

function voicePrompt(text, prev, reaction) {
  const context = prev ? 'Context, do not read it aloud. The other host just said: "' + prev + '"\n\n' : '';
  return context + (reaction ? 'Your reaction: ' : 'Your line, to read aloud word for word:\n') + text;
}

/* Did the model read the line, and only the line? From the transcript the
   speech stream sends with the audio. No transcript: trusted. */
const words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);
function readFaithfully(line, transcript) {
  if (!transcript) return true;
  const want = words(line).length;
  const got = words(transcript).length;
  return got <= Math.ceil(want * 1.2) + 3 && got >= Math.floor(want * 0.75) - 1;
}

async function speakOnce({ text, host, prev, reaction }) {
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
      audio: { voice: host === 'B' ? config.podcast.voiceB : config.podcast.voiceA, format: 'pcm16' },
      usage: { include: true },
      messages: [
        { role: 'system', content: voiceSystem(host, reaction) },
        { role: 'user', content: voicePrompt(text, prev, reaction) },
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
  let transcript = '';
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
      if (a && a.transcript) transcript += a.transcript;
      if (e.usage && typeof e.usage.cost === 'number') cost = e.usage.cost;
    }
  }
  const pcm = Buffer.concat(chunks);
  if (pcm.length < SAMPLE_RATE / (reaction ? 8 : 1)) throw new Error('speech came back empty');
  return { pcm, cost, transcript };
}

/* One clip, with retries for the service and for a reading that strayed from
   the line (then without the context, which is what tempts it to). */
/* ---- OpenAI's speech model, with the client's own OpenAI key ---------------------
   gpt-4o-mini-tts reads exactly the text it is given and takes a written
   direction for each line (who is speaking, how, in answer to what), so the
   two hosts keep one steady character all episode. The directions describe
   the hosts of the client's NotebookLM sample. Used when MP_OPENAI_API_KEY is
   set; a line it cannot voice is voiced through OpenRouter instead. */

const DIRECTION = {
  A:
    'You are the lead host of "The Debate", a two-host podcast that applies sports talk radio energy to one person\'s career. ' +
    'Voice: a woman in her mid-thirties, General American accent, warm, full and chest-resonant, bright and forward, no vocal fry. ' +
    'Delivery: upbeat, engaging optimism with a wide pitch range; lift your pitch on the key words; smile while you talk; natural conversational pace, about 175 words a minute, speeding up through the easy parts and slowing on the point that matters. ' +
    'You are talking with your co-host in the same room, never reading or announcing.',
  B:
    'You are the co-host of "The Debate", a two-host podcast that applies sports talk radio energy to one person\'s career. ' +
    'Voice: a man around forty, General American accent, low-mid pitch, dry, clear and grounded, a touch of vocal fry. ' +
    'Delivery: the sceptical analyst; punch the consonants of the key words and drop your pitch at the end of a point; quicken a little when you break down the numbers; about 180 words a minute; dry wit, never cold. ' +
    'You are talking with your co-host in the same room, never reading or announcing.',
};

function ttsInstructions(job) {
  if (job.reaction) {
    return DIRECTION[job.host] + ' Right now you are only listening: say this short reaction quietly and naturally, under your breath, while the other host is still talking.';
  }
  return DIRECTION[job.host] + (job.prev ? ' Your co-host just said: "' + job.prev.slice(-300) + '". Answer them in tone: push back if they challenged you, grant it if they made a strong point, laugh for real if the line laughs.' : ' You are opening the show.');
}

async function speakTtsOnce(job) {
  const o = config.podcast.openai;
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + o.apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: o.model,
      voice: job.host === 'B' ? o.voiceB : o.voiceA,
      input: job.text,
      instructions: ttsInstructions(job),
      response_format: 'pcm', // 24 kHz, 16-bit, mono: what the mix works in
    }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) {
    const err = new Error('openai speech ' + res.status + ': ' + (await res.text()).slice(0, 200));
    err.status = res.status;
    throw err;
  }
  const pcm = Buffer.from(await res.arrayBuffer());
  if (pcm.length < SAMPLE_RATE / (job.reaction ? 8 : 2)) throw new Error('openai speech came back empty');
  return { pcm, cost: (pcm.length / 2 / SAMPLE_RATE / 60) * o.perMinute };
}

async function speakTts(job) {
  let last;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 2000 * attempt * attempt));
    try {
      return await speakTtsOnce(job);
    } catch (err) {
      last = err;
      if (err.status && err.status < 500 && err.status !== 429 && err.status !== 408) break;
    }
  }
  console.warn('[masterplan] OpenAI speech failed for a line (%s); voicing it through OpenRouter', String(last && last.message).slice(0, 160));
  return null;
}

async function speak(job) {
  if (config.podcast.openai.apiKey) {
    const r = await speakTts(job);
    if (r) return r;
  }
  let last;
  let cost = 0;
  let strayed = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt && !strayed) await new Promise((r) => setTimeout(r, 3000 * attempt * attempt));
    const withContext = attempt < 2 && !(strayed && strayed.count >= 1);
    try {
      const r = await speakOnce({ ...job, prev: withContext ? job.prev : '' });
      cost += r.cost;
      if (job.reaction || readFaithfully(job.text, r.transcript)) return { pcm: r.pcm, cost };
      strayed = { pcm: r.pcm, count: (strayed ? strayed.count : 0) + 1 };
      if (strayed.count >= 3) return { pcm: r.pcm, cost }; // keep the last take rather than lose the episode
    } catch (err) {
      last = err;
      strayed = null;
      if (err.status && err.status < 500 && err.status !== 429 && err.status !== 408) throw err;
    }
  }
  if (strayed) return { pcm: strayed.pcm, cost };
  throw last;
}

/* Every line and every reaction, a few at a time, kept in order. */
async function voiceAll(turns, usage, onProgress) {
  const jobs = [];
  turns.forEach((t, i) => {
    const prev = i ? turns[i - 1].text.slice(-400) : '';
    jobs.push({ kind: 'line', i, text: t.text, host: t.host, prev });
    if (t.react) jobs.push({ kind: 'react', i, text: t.react, host: t.host === 'A' ? 'B' : 'A', prev: t.text.slice(-300), reaction: true });
  });
  const lines = new Array(turns.length);
  const reacts = new Array(turns.length);
  let next = 0;
  let done = 0;
  async function lane() {
    while (next < jobs.length) {
      const job = jobs[next++];
      let r;
      try {
        r = await speak(job);
      } catch (err) {
        if (job.kind === 'react') continue; // a reaction is a nicety: the episode goes on without it
        throw err;
      }
      (job.kind === 'line' ? lines : reacts)[job.i] = r.pcm;
      usage.cost_usd = (usage.cost_usd || 0) + r.cost;
      done++;
      if (onProgress) onProgress(done, jobs.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(config.podcast.parallel, jobs.length) }, lane));
  return { lines, reacts };
}

/* ---- mix ----------------------------------------------------------------- */

const WIN = SAMPLE_RATE / 100; // 10 ms
const SPEECH = 500; // a 10 ms window louder than this (about -36 dBFS) has speech in it
const TARGET_RMS = 3600; // about -19 dBFS while speaking
const ROOM = 28; // room tone, about -60 dBFS

const asInt16 = (buf) => {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const even = b.length & ~1;
  const out = new Int16Array(even >> 1);
  for (let i = 0; i < out.length; i++) out[i] = b.readInt16LE(i * 2);
  return out;
};

/* The same window with the top end lifted (pre-emphasis): bright voices count louder, as the ear hears them. */
function emphasisRms(s, from) {
  let sum = 0;
  const end = Math.min(s.length, from + WIN);
  for (let i = Math.max(1, from); i < end; i++) {
    const d = s[i] - 0.7 * s[i - 1];
    sum += d * d;
  }
  return Math.sqrt(sum / Math.max(1, end - from)) * 1.4;
}

function windowRms(s, from) {
  let sum = 0;
  const end = Math.min(s.length, from + WIN);
  for (let i = from; i < end; i++) sum += s[i] * s[i];
  return Math.sqrt(sum / Math.max(1, end - from));
}

/* The speech in a clip, without the silence the model puts around it, at the
   same loudness as every other clip, with tiny fades so a cut never clicks. */
function prepareClip(buf, opts = {}) {
  const raw = asInt16(buf);
  const s = opts.lengthenPauses ? lengthenPauses(raw, opts.lengthenPauses) : opts.keepPauses ? raw : shortenPauses(raw);
  let first = -1;
  let last = -1;
  let sum = 0;
  let n = 0;
  for (let w = 0; w + WIN <= s.length; w += WIN) {
    const r = windowRms(s, w);
    if (r > SPEECH) {
      if (first < 0) first = w;
      last = w + WIN;
      const p = emphasisRms(s, w);
      sum += (r * r + p * p) / 2;
      n++;
    }
  }
  if (first < 0) return new Int16Array(0);
  /* A long part keeps the breath before its first word and a little air after
     its last, so a join between parts sounds like a pause, not a cut. */
  const lead = opts.lengthenPauses ? 0.25 : 0.03;
  const tail = opts.lengthenPauses ? 0.2 : 0.08;
  const start = Math.max(0, first - Math.round(SAMPLE_RATE * lead));
  const end = Math.min(s.length, last + Math.round(SAMPLE_RATE * tail));
  const clip = s.subarray(start, end);
  let peak = 1;
  for (let i = 0; i < clip.length; i++) peak = Math.max(peak, Math.abs(clip[i]));
  const gain = Math.min(3, Math.max(0.4, TARGET_RMS / Math.sqrt(sum / n)), 30000 / peak);
  const fade = Math.round(SAMPLE_RATE * (opts.lengthenPauses ? 0.06 : 0.008));
  const out = new Int16Array(clip.length);
  for (let i = 0; i < clip.length; i++) {
    const f = Math.min(1, i / fade, (clip.length - 1 - i) / fade);
    out[i] = Math.round(clip[i] * gain * f);
  }
  return opts.soften ? soften(out, opts.soften) : out;
}

/* The speech model leaves long pauses between sentences; people talking do
   not. A pause over 0.42 s inside a line becomes 0.26 to 0.34 s. */
function shortenPauses(s) {
  const MAX = Math.round(SAMPLE_RATE * 0.42);
  const KEEP = Math.round(SAMPLE_RATE * 0.14);
  const parts = [];
  let from = 0;
  let quietStart = -1;
  for (let w = 0; w + WIN <= s.length; w += WIN) {
    const quiet = windowRms(s, w) < SPEECH * 0.6;
    if (quiet && quietStart < 0) quietStart = w;
    if (!quiet && quietStart >= 0) {
      if (w - quietStart > MAX && quietStart > 0) {
        const keep = KEEP + ((w / WIN) % 5) * Math.round(SAMPLE_RATE * 0.008);
        parts.push(s.subarray(from, quietStart + keep));
        from = w - keep;
      }
      quietStart = -1;
    }
  }
  if (!parts.length) return s;
  parts.push(s.subarray(from));
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/* Google's voices talk at about the sample's pace (193 against 179 words a
   minute) but pause less (0.28 s against 0.39 s on average), which is what
   makes the sample sound relaxed. Each pause between 0.12 and 0.7 s is made
   longer by the given factor, from its own quiet sound; the speech is untouched. */
function lengthenPauses(s, factor) {
  const MIN = Math.round(SAMPLE_RATE * 0.12);
  const MAX = Math.round(SAMPLE_RATE * 0.7);
  const parts = [];
  let from = 0;
  let quietStart = -1;
  for (let w = 0; w + WIN <= s.length; w += WIN) {
    const quiet = windowRms(s, w) < SPEECH * 0.6;
    if (quiet && quietStart < 0) quietStart = w;
    if (!quiet && quietStart >= 0) {
      const len = w - quietStart;
      if (len >= MIN && len <= MAX && quietStart > 0) {
        const extra = Math.round(len * (factor - 1));
        const mid = quietStart + Math.floor(len / 2);
        parts.push(s.subarray(from, mid));
        /* the quiet itself, repeated (mirrored, so the join never clicks) */
        const fill = new Int16Array(extra);
        for (let k = 0; k < extra; k++) {
          const span = Math.max(1, Math.floor(len / 2));
          const t = k % (2 * span);
          fill[k] = s[mid - 1 - (t < span ? t : 2 * span - 1 - t)] || 0;
        }
        parts.push(fill);
        from = mid;
      }
      quietStart = -1;
    }
  }
  if (!parts.length) return s;
  parts.push(s.subarray(from));
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/* Each Google part is a separate request and can come back a little brighter
   or duller, warmer or thinner. Two measures of a part's tone ... */

/* brightness: the share of energy in the changes from sample to sample (the top end) */
function brightness(s) {
  let all = 0;
  let top = 0;
  for (let i = 1; i < s.length; i += 3) {
    all += s[i] * s[i];
    const d = s[i] - s[i - 1];
    top += d * d;
  }
  return all ? top / all : 0;
}

/* warmth: the share of energy below about 300 Hz (chest, closeness to the microphone) */
const LOW = 1 - Math.exp((-2 * Math.PI * 300) / SAMPLE_RATE);
const HIGH = 1 - Math.exp((-2 * Math.PI * 2000) / SAMPLE_RATE);
function warmth(s) {
  let all = 0;
  let low = 0;
  let y = 0;
  for (let i = 0; i < s.length; i++) {
    y += LOW * (s[i] - y);
    if (i % 3) continue;
    all += s[i] * s[i];
    low += y * y;
  }
  return all ? low / all : 0;
}

/* ... and the two shelves that move them: g > 0 adds top end above about
   2 kHz (hi) or low end below about 300 Hz (lo), g < 0 takes it away. */
function shelves(s, hi, lo) {
  const out = new Int16Array(s.length);
  let yh = 0;
  let yl = 0;
  for (let i = 0; i < s.length; i++) {
    yh += HIGH * (s[i] - yh);
    yl += LOW * (s[i] - yl);
    const v = s[i] + hi * (s[i] - yh) + lo * yl;
    out[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : Math.round(v);
  }
  return out;
}

const rms = (s) => {
  let sum = 0;
  for (let i = 0; i < s.length; i += 2) sum += s[i] * s[i];
  return Math.sqrt(sum / Math.max(1, Math.ceil(s.length / 2)));
};

/**
 * A later part brought to the first part's tone: the two shelf amounts are
 * found on 20 seconds from the middle of the part (quick), then applied to
 * the whole part once, at its own loudness.
 */
function matchTone(s, ref) {
  if (!s.length || !ref.bright || !ref.warm) return s;
  const n = Math.min(s.length, SAMPLE_RATE * 20);
  const from = Math.max(0, Math.floor((s.length - n) / 2));
  const probe = s.subarray(from, from + n);
  const HI = [-0.45, -0.3, -0.15, 0, 0.15, 0.3, 0.5, 0.75];
  const LO = [-0.4, -0.2, 0, 0.25, 0.5, 0.8, 1.2];
  let best = { hi: 0, lo: 0, err: Infinity };
  for (const hi of HI) {
    for (const lo of LO) {
      const t = shelves(probe, hi, lo);
      const err = Math.abs(brightness(t) - ref.bright) / ref.bright + Math.abs(warmth(t) - ref.warm) / ref.warm;
      if (err < best.err) best = { hi, lo, err };
    }
  }
  /* then finer, around the best */
  const coarse = { ...best };
  for (let dh = -0.12; dh <= 0.12; dh += 0.04) {
    for (let dl = -0.15; dl <= 0.15; dl += 0.05) {
      const hi = coarse.hi + dh;
      const lo = coarse.lo + dl;
      const t = shelves(probe, hi, lo);
      const err = Math.abs(brightness(t) - ref.bright) / ref.bright + Math.abs(warmth(t) - ref.warm) / ref.warm;
      if (err < best.err) best = { hi, lo, err };
    }
  }
  if (!best.hi && !best.lo) return s;
  const out = shelves(s, best.hi, best.lo);
  const k = rms(s) / Math.max(1, rms(out));
  for (let i = 0; i < out.length; i++) out[i] = Math.max(-32768, Math.min(32767, Math.round(out[i] * k)));
  return out;
}

/* A gentle cut of the top end and a little level: the brighter voice
   otherwise sounds closer and louder than the other. */
function soften(s, amount) {
  const a = 1 - Math.exp((-2 * Math.PI * 5500) / SAMPLE_RATE);
  let y = 0;
  const out = new Int16Array(s.length);
  for (let i = 0; i < s.length; i++) {
    y += a * (s[i] - y);
    out[i] = Math.round((s[i] * (1 - amount) + y * amount) * (1 - amount * 0.25));
  }
  return out;
}

/* The same "random" every time for the same episode. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Lays the clips on one timeline, the way two people talk. Returns 16-bit
 * mono PCM in a fresh ArrayBuffer (handed to the encoder, not copied).
 *   lines[i]   turn i's speech; reacts[i] the other host's reaction under it
 */
function mixEpisode(turns, lines, reacts, opts = {}) {
  const rand = rng(turns.length * 7919 + (turns[0] ? turns[0].text.length : 0));
  const sec = (x) => Math.round(x * SAMPLE_RATE);
  /* Gemini parts are a conversation already: only levelled and joined. */
  const natural = !!opts.natural;
  const tone = (host) => (natural ? { lengthenPauses: config.podcast.gemini.pauseFactor } : { soften: host === 'B' ? config.podcast.softenB : config.podcast.softenA });
  let clips = lines.map((l, i) => prepareClip(l, tone(turns[i].host)));
  /* Each Google part is a separate request and can come back a little brighter
     or duller: every later part is matched to the first one. */
  if (natural && clips.length > 1) {
    const ref = { bright: brightness(clips[0]), warm: warmth(clips[0]) };
    clips = clips.map((c, i) => (i ? matchTone(c, ref) : c));
  }
  const under = (reacts || []).map((r) => (r ? prepareClip(r, { soften: 0.8 }) : null));

  /* Where each turn starts. */
  const starts = [];
  let at = sec(0.35);
  clips.forEach((c, i) => {
    if (i) {
      const prevLen = clips[i - 1].length;
      let gap;
      if (natural) gap = -sec(0.06); // the parts fade into each other: the room sound never drops
      else if (turns[i].cut) gap = -Math.min(sec(0.3 + rand() * 0.25), Math.round(prevLen * 0.35));
      else if (rand() < 0.25) gap = -sec(rand() * 0.12); // latching on: the next one starts as the last word ends
      else if (/\?$/.test(turns[i - 1].text)) gap = sec(0.06 + rand() * 0.14);
      else if (turns[i].text.split(' ').length <= 3) gap = sec(0.05 + rand() * 0.12);
      else gap = sec(0.2 + rand() * 0.25); // the sample leaves a real beat between turns
      at = starts[i - 1] + prevLen + gap;
    }
    starts.push(at);
  });
  const total = (clips.length ? starts[starts.length - 1] + clips[clips.length - 1].length : 0) + sec(0.8);
  const mix = new Int16Array(new ArrayBuffer(total * 2));
  const add = (clip, from, gain) => {
    for (let k = 0; k < clip.length; k++) {
      const j = from + k;
      if (j < 0 || j >= total) continue;
      const v = mix[j] + clip[k] * gain;
      mix[j] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
    }
  };

  clips.forEach((c, i) => {
    /* Someone cutting in: the other trails off under them. */
    if (turns[i].cut && i) {
      const from = starts[i];
      const to = Math.min(total, starts[i - 1] + clips[i - 1].length);
      for (let j = from; j < to; j++) mix[j] = Math.round(mix[j] * (0.75 - (0.4 * (j - from)) / Math.max(1, to - from)));
    }
    add(c, starts[i], 1);
    const r = under[i];
    /* No reaction under a turn the next host cuts into: three voices at once is a mess. */
    if (r && r.length && !(turns[i + 1] && turns[i + 1].cut)) {
      const from = starts[i] + c.length - r.length - sec(0.15 + rand() * 0.5);
      if (from > starts[i] + sec(0.8)) add(r, from, 0.4);
    }
  });

  /* One room for both voices: two faint early reflections (23 and 37 ms),
     read from the dry signal by working backwards. */
  const d1 = sec(0.023);
  const d2 = sec(0.037);
  for (let j = total - 1; j >= d2 && !natural; j--) {
    const v = mix[j] + mix[j - d1] * 0.09 + mix[j - d2] * 0.06;
    mix[j] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
  }

  /* A soft, steady room tone: the gaps are a quiet room, never digital zero. */
  let brown = 0;
  for (let j = 0; j < total; j++) {
    brown = brown * 0.985 + (rand() * 2 - 1) * 0.12;
    const v = mix[j] + Math.round(brown * ROOM * 4);
    mix[j] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
  }
  return mix;
}

/* ---- mp3 ----------------------------------------------------------------- */

function encodeMp3(mix, tempo = 1) {
  const pcm = new Uint8Array(mix.buffer, mix.byteOffset, mix.byteLength);
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'mp3-worker.js'), {
      workerData: { pcm, sampleRate: SAMPLE_RATE, kbps: 96, tempo },
      transferList: [mix.buffer],
    });
    worker.once('message', (m) => {
      if (m && m.error) reject(new Error(m.error));
      else resolve({ mp3: Buffer.from(m.mp3), seconds: Math.round(m.samples / SAMPLE_RATE) });
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
  const count = script.turns.reduce((n, t) => n + t.text.split(/\s+/).length, 0);
  if (log) log('podcast script: ' + script.turns.length + ' turns, ' + count + ' words, ' + script.turns.filter((t) => t.react).length + ' reactions, ' + script.turns.filter((t) => t.cut).length + ' cut-ins');
  let mix;
  let tempo = 1;
  if (gemini.available()) {
    /* Google's voices; if Google cannot voice it (quota, outage), the
       line-by-line voices do, so the member still gets the episode. */
    try {
      const parts = await gemini.voiceAll(script.turns, usage);
      if (log) log('podcast voiced by ' + config.podcast.gemini.model + ' in ' + parts.length + ' parts');
      mix = mixEpisode(parts.map(() => ({ host: 'A', text: '' })), parts, null, { natural: true });
    } catch (err) {
      console.warn('[masterplan] Google speech failed (%s); using the line-by-line voices', err.message.slice(0, 160));
    }
  }
  if (!mix) {
    const { lines, reacts } = await voiceAll(script.turns, usage);
    mix = mixEpisode(script.turns, lines, reacts);
    /* These voices talk a little slower than the sample: brought to its pace. */
    tempo = config.podcast.tempo;
  }
  const { mp3, seconds } = await encodeMp3(mix, tempo);
  return { mp3, seconds, title: script.title, script };
}

function available() {
  /* The script always comes through OpenRouter; the voices from Gemini when its key is set, else OpenRouter. */
  return config.podcast.enabled && config.anthropic.provider === 'openrouter' && !!config.anthropic.openrouterKey;
}

module.exports = { ttsInstructions, makePodcast, writeScript, voiceAll, mixEpisode, prepareClip, lengthenPauses, brightness, warmth, matchTone, readFaithfully, encodeMp3, available, FOCUS, SAMPLE_RATE };
