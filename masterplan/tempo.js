'use strict';

/* ---------------------------------------------------------------------------
   Faster or slower speech at the same pitch (WSOLA: waveform-similarity
   overlap-add). The episode is cut into short overlapping frames; each next
   frame is taken from a little further along (rate > 1: faster), at the spot
   whose waveform best continues the frame before, and the frames are laid
   back together with a smooth window. The voices keep their pitch and tone;
   only the pace changes.

   Used for the line-by-line voices, which talk a little slower than the
   client's NotebookLM sample (about 161 against 179 words a minute). Runs in
   the MP3 worker thread, so the server never stalls on it.
   --------------------------------------------------------------------------- */

const FRAME = 480; // 20 ms at 24 kHz
const HOP = FRAME / 2; // frames overlap by half
const SEEK = 120; // look up to 5 ms either way for the best continuation

const WINDOW = (() => {
  const w = new Float32Array(FRAME);
  for (let i = 0; i < FRAME; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME);
  return w;
})();

/** 16-bit mono samples played `rate` times as fast, same pitch. */
function stretch(input, rate) {
  if (!rate || Math.abs(rate - 1) < 0.005 || input.length < FRAME * 4) return input;
  const outLen = Math.floor(input.length / rate);
  const out = new Float32Array(outLen + FRAME);
  let prev = 0; // where the previous frame was read from
  for (let k = 0; ; k++) {
    const at = k * HOP; // where this frame goes in the output
    if (at + FRAME > outLen) break;
    const nominal = Math.round(k * HOP * rate);
    let pos = nominal;
    if (k > 0) {
      /* The best continuation of the previous frame: compare its natural next
         stretch (prev + HOP) with candidates around the nominal position. */
      const natural = prev + HOP;
      let best = -Infinity;
      const lo = Math.max(0, nominal - SEEK);
      const hi = Math.min(input.length - FRAME, nominal + SEEK);
      for (let p = lo; p <= hi; p += 2) {
        let c = 0;
        for (let i = 0; i < HOP; i += 4) c += input[natural + i] * input[p + i];
        if (c > best) {
          best = c;
          pos = p;
        }
      }
    }
    if (pos + FRAME > input.length) break;
    for (let i = 0; i < FRAME; i++) out[at + i] += input[pos + i] * WINDOW[i];
    prev = pos;
  }
  const res = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const v = Math.round(out[i]);
    res[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
  }
  return res;
}

module.exports = { stretch };
