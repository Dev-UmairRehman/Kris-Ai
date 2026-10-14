'use strict';

/* Encodes 16-bit mono PCM to MP3 off the main thread: a podcast is minutes
   of CPU work, and the server must keep answering Kris AI and the page
   meanwhile. Pure JavaScript (lamejs), so the image needs no ffmpeg. */

const { parentPort, workerData } = require('worker_threads');

(async () => {
  try {
    const { Mp3Encoder } = await import('@breezystack/lamejs');
    const { pcm, sampleRate, kbps, tempo } = workerData;
    /* The buffer arrives whole and even-sized, so the samples are read in
       place; a misaligned view (never expected) is copied first. */
    let samples =
      pcm.byteOffset % 2 === 0
        ? new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength >> 1)
        : new Int16Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + (pcm.byteLength & ~1)));
    /* The pace, at the same pitch (tempo.js), here off the main thread. */
    if (tempo && tempo !== 1) samples = require('./tempo').stretch(samples, tempo);
    const enc = new Mp3Encoder(1, sampleRate, kbps);
    const out = [];
    const block = 1152 * 64;
    for (let i = 0; i < samples.length; i += block) {
      const b = enc.encodeBuffer(samples.subarray(i, i + block));
      if (b.length) out.push(Buffer.from(b));
    }
    const tail = enc.flush();
    if (tail.length) out.push(Buffer.from(tail));
    const mp3 = Buffer.concat(out);
    parentPort.postMessage({ mp3, samples: samples.length }, [mp3.buffer]);
  } catch (err) {
    parentPort.postMessage({ error: err.message });
  }
})();
