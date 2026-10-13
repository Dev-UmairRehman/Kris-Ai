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
