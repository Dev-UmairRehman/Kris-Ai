'use strict';

/* The podcast's mix: how the voiced lines are laid on one timeline. No API
   calls - the "voices" here are tones with silence around them. */

const test = require('node:test');
const assert = require('node:assert');
const podcast = require('../podcast');

const RATE = podcast.SAMPLE_RATE;

/* A clip like the speech model returns: silence, a tone, silence. */
function clip(seconds, amp, lead = 0.4, tail = 0.5) {
  const n = Math.round((lead + seconds + tail) * RATE);
  const b = Buffer.alloc(n * 2);
  for (let i = Math.round(lead * RATE); i < Math.round((lead + seconds) * RATE); i++) {
    b.writeInt16LE(Math.round(Math.sin(i / 7) * amp), i * 2);
  }
  return b;
}

/* Where sound louder than the room tone is, in 10 ms steps. */
function loudSpans(mix) {
  const spans = [];
  let on = null;
  for (let w = 0; w + 240 <= mix.length; w += 240) {
    let sum = 0;
    for (let i = w; i < w + 240; i++) sum += mix[i] * mix[i];
    const loud = Math.sqrt(sum / 240) > 400;
    if (loud && on === null) on = w;
    if (!loud && on !== null) {
      spans.push([on / RATE, w / RATE]);
      on = null;
    }
  }
  if (on !== null) spans.push([on / RATE, mix.length / RATE]);
  return spans;
}

test('silence around each line is trimmed and every line ends up equally loud', () => {
  const quiet = podcast.prepareClip(clip(1, 3000));
  const loud = podcast.prepareClip(clip(1, 12000));
  assert.ok(quiet.length < 1.2 * RATE, 'lead and tail silence are cut');
  const rms = (s) => Math.sqrt(s.reduce((n, x) => n + x * x, 0) / s.length);
  assert.ok(Math.abs(rms(quiet) - rms(loud)) / rms(loud) < 0.15, 'levelled: ' + rms(quiet) + ' vs ' + rms(loud));

  /* A one-second pause between two sentences becomes a short one. */
  const twoSentences = Buffer.concat([clip(1, 8000, 0.2, 0.5), clip(1, 8000, 0.5, 0.2)]);
  const shortened = podcast.prepareClip(twoSentences);
  assert.ok(shortened.length < 2.45 * RATE, 'pause shortened: ' + (shortened.length / RATE).toFixed(2) + ' s');
});

test('turns follow with short varied gaps, a cut-in overlaps, reactions sit under speech, no digital silence', () => {
  const turns = [
    { host: 'A', text: 'Welcome to the debate. Today we look at a promising prospect with a long record.' },
    { host: 'B', text: 'And a record that might be a comfortable trap, if you look at the tape closely enough.', react: 'Mm-hmm.' },
    { host: 'A', text: 'Wait, wait. That is not fair to the record at all.', cut: true },
    { host: 'B', text: 'Okay.' },
  ];
  const lines = [clip(3, 8000), clip(4, 3000), clip(2, 8000), clip(0.5, 8000)];
  const reacts = [null, clip(0.4, 6000), null, null];
  const mix = podcast.mixEpisode(turns, lines, reacts);
  assert.ok(mix.buffer.byteLength === mix.byteLength, 'its own buffer, so it can be handed to the encoder');

  /* Lines 1 and 2: a gap well under the old fixed pause plus the clips' own silence. */
  const spans = loudSpans(mix);
  const gap = spans[1][0] - spans[0][1];
  assert.ok(gap > 0.05 && gap < 0.5, 'gap ' + gap.toFixed(2));
  /* Line 3 cuts into line 2: no silence between them. */
  const total = mix.length / RATE;
  const sum = 3 + 4 + 2 + 0.5;
  /* Start and end padding (1.15 s) plus short gaps; joining the raw clips with a fixed pause gave about 14 s. */
  assert.ok(total < sum + 2.1, 'tight timeline: ' + total.toFixed(2) + ' s for ' + sum + ' s of speech');

  /* The room tone: nowhere is the track digital zero. */
  let zeros = 0;
  let run = 0;
  for (let i = 0; i < mix.length; i++) {
    run = mix[i] === 0 ? run + 1 : 0;
    zeros = Math.max(zeros, run);
  }
  assert.ok(zeros < RATE * 0.01, 'longest run of exact silence: ' + zeros + ' samples');
});

test('a reading that adds or drops words is caught', () => {
  const line = 'The documents suggest she has the raw material for the next drive.';
  assert.strictEqual(podcast.readFaithfully(line, 'The documents suggest she has the raw material for the next drive.'), true);
  assert.strictEqual(podcast.readFaithfully(line, ''), true, 'no transcript: trusted');
  assert.strictEqual(podcast.readFaithfully(line, 'The other host just said the tape is good. ' + line + ' And honestly I agree with every word of it.'), false);
  assert.strictEqual(podcast.readFaithfully(line, 'The documents suggest.'), false);
});

/* ---- Google's two-speaker voices (podcast-gemini.js), the API stubbed ---- */

test('with a Gemini key the episode is voiced by Google in parts, both hosts per request', async () => {
  const config = require('../config');
  const gemini = require('../podcast-gemini');
  const llm = require('../llm');
  const g = config.podcast.gemini;
  const saved = { key: g.apiKey, fetch: global.fetch, generate: llm.generate };
  g.apiKey = 'test-key';
  const sent = [];
  global.fetch = async (url, opts) => {
    assert.match(String(url), /generativelanguage\.googleapis\.com\/v1beta\/models\/.+:generateContent$/);
    assert.strictEqual(opts.headers['x-goog-api-key'], 'test-key');
    const body = JSON.parse(opts.body);
    sent.push(body);
    const pcm = Buffer.alloc(RATE * 2 * 3);
    for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 9) * 5000), i * 2);
    /* The 3.x models answer with a WAV, as the real API did; 2.5 with raw PCM. */
    const old = /gemini-2\./.test(String(url));
    const wav = Buffer.alloc(44);
    wav.write('RIFF', 0, 'latin1');
    wav.writeUInt32LE(36 + pcm.length, 4);
    wav.write('WAVEfmt ', 8, 'latin1');
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(RATE, 24);
    wav.writeUInt32LE(RATE * 2, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write('data', 36, 'latin1');
    wav.writeUInt32LE(pcm.length, 40);
    const audio = old ? pcm : Buffer.concat([wav, pcm]);
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ inlineData: { mimeType: old ? 'audio/L16;rate=24000' : 'audio/wav', data: audio.toString('base64') } }] } }],
      usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 3000 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const long = (n) => Array.from({ length: n }, (_, i) => 'word' + i).join(' ');
  const turns = [];
  for (let i = 0; i < 24; i++) turns.push({ host: i % 2 ? 'B' : 'A', text: long(40), react: i === 2 ? 'Mm-hmm.' : undefined });
  llm.generate = async () => ({ text: '```json\n' + JSON.stringify({ title: 'Camp or Cage', turns }) + '\n```', usage: {} });
  try {
    const usage = {};
    const ep = await podcast.makePodcast({ name: 'Ana', narrative: 'n', article: 'a', usage });
    assert.ok(sent.length >= 3, 'about 960 words go out in parts of about two minutes: ' + sent.length);
    const first = sent[0];
    assert.deepStrictEqual(first.generationConfig.responseModalities, ['AUDIO']);
    const voices = first.generationConfig.speechConfig.multiSpeakerVoiceConfig.speakerVoiceConfigs;
    assert.deepStrictEqual(voices.map((v) => v.speaker), [gemini.SPEAKERS.A, gemini.SPEAKERS.B]);
    /* 3.x: every turn its own part, tagged with its speaker. */
    const ps = first.contents[0].parts;
    assert.deepStrictEqual(ps.slice(0, 2).map((p) => p.speechMetadata.speaker), ['Alex', 'Sam']);
    assert.match(ps[0].text, /^word0 /);
    assert.ok(ps.some((p) => p.speechMetadata.speaker === 'Sam' && /^Mm-hmm\. word0/.test(p.text)), 'a reaction opens the other host\'s next turn');
    assert.ok(!first.systemInstruction, 'no separate style instruction: the 3.x models refuse one');
    assert.ok(Math.abs(usage.cost_usd - sent.length * (1000 * g.inputPerMillion + 3000 * g.outputPerMillion) / 1e6) < 1e-9, 'cost from the token counts');
    /* Three seconds a part: the WAV header is not taken for sound. */
    const expected = sent.length * 3 + (sent.length - 1) * 0.22 + 1.15;
    assert.ok(Math.abs(ep.seconds - expected) <= 1, 'every part, unwrapped: ' + ep.seconds + ' s vs ' + expected.toFixed(1));
    assert.strictEqual(ep.mp3.slice(0, 3).toString('latin1') === 'ID3' || ep.mp3[0] === 0xff, true, 'an MP3');

    /* 2.5 models: one transcript with the style above it. */
    sent.length = 0;
    const model = g.model;
    g.model = 'gemini-2.5-pro-preview-tts';
    try {
      await podcast.makePodcast({ name: 'Ana', narrative: 'n', article: 'a', usage: {} });
    } finally {
      g.model = model;
    }
    const text = sent[0].contents[0].parts[0].text;
    assert.match(text, /\nAlex: word0/);
    assert.match(text, /Sam: Mm-hmm\. word0/);
    assert.match(sent[1].contents[0].parts[0].text, /continues a conversation already under way/);
  } finally {
    g.apiKey = saved.key;
    global.fetch = saved.fetch;
    llm.generate = saved.generate;
  }
});

test('when Google cannot voice it, the episode is made with the line-by-line voices', async () => {
  const config = require('../config');
  const llm = require('../llm');
  const g = config.podcast.gemini;
  const saved = { key: g.apiKey, fetch: global.fetch, generate: llm.generate, warn: console.warn };
  g.apiKey = 'test-key';
  let google = 0;
  let lines = 0;
  console.warn = () => {};
  global.fetch = async (url) => {
    if (/generativelanguage/.test(String(url))) {
      google++;
      return new Response(JSON.stringify({ error: { code: 400, message: 'bad request' } }), { status: 400, headers: { 'content-type': 'application/json' } });
    }
    lines++;
    const pcm = Buffer.alloc(RATE * 2);
    for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 9) * 5000), i * 2);
    const sse = 'data: ' + JSON.stringify({ choices: [{ delta: { audio: { data: pcm.toString('base64') } } }], usage: { cost: 0.001 } }) + '\n\ndata: [DONE]\n\n';
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const turns = [];
  for (let i = 0; i < 12; i++) turns.push({ host: i % 2 ? 'B' : 'A', text: 'A line of the debate number ' + i + ', said with some feeling.' });
  llm.generate = async () => ({ text: '```json\n' + JSON.stringify({ title: 'Fallback', turns }) + '\n```', usage: {} });
  try {
    const ep = await podcast.makePodcast({ name: 'Ana', narrative: 'n', article: 'a', usage: {} });
    assert.strictEqual(google, 1, 'Google tried once (a 400 is not retried)');
    assert.strictEqual(lines, 12, 'then every line voiced the other way');
    assert.ok(ep.seconds >= 12, 'a whole episode: ' + ep.seconds + ' s');
  } finally {
    g.apiKey = saved.key;
    global.fetch = saved.fetch;
    llm.generate = saved.generate;
    console.warn = saved.warn;
  }
});
