'use strict';

/* Isolates whether BuddyPro's audio rejection is our payload shape or the
   audio content, by posting a synthesised WAV directly, in several shapes.
   Throwaway diagnostic. */

require('../lib/config'); // loads .env

const KEY = process.env.BUDDYPRO_API_KEY;
const URL = 'https://api.buddypro.ai/v1/chat/completions';

/** 16-bit mono PCM WAV of a 440 Hz tone. */
function toneWav(seconds, rate) {
  const frames = Math.floor(seconds * rate);
  const buffer = Buffer.alloc(44 + frames * 2);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + frames * 2, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(frames * 2, 40);

  for (let i = 0; i < frames; i++) {
    const value = Math.sin((2 * Math.PI * 440 * i) / rate) * 0.3 * 0x7fff;
    buffer.writeInt16LE(Math.round(value), 44 + i * 2);
  }
  return buffer;
}

async function post(label, body) {
  const started = Date.now();
  let res;
  let text;
  try {
    res = await fetch(URL, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    text = await res.text();
  } catch (err) {
    console.log(label.padEnd(34) + ' NETWORK ' + err.message);
    return;
  }

  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* leave null */
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const err = parsed && parsed.error;
  const content =
    parsed && parsed.choices && parsed.choices[0] && parsed.choices[0].message
      ? String(parsed.choices[0].message.content).slice(0, 90)
      : '';

  console.log(
    label.padEnd(34) +
      ' HTTP ' + res.status +
      ' ' + seconds + 's  ' +
      (err
        ? 'ERROR ' + err.code + ': ' + String(err.message).slice(0, 80)
        : 'OK -> ' + content)
  );
}

(async () => {
  if (!KEY) {
    console.error('BUDDYPRO_API_KEY missing');
    process.exit(1);
  }

  const wav16 = toneWav(2, 16000).toString('base64');
  const wav44 = toneWav(2, 44100).toString('base64');

  console.log('control: text only');
  await post('text', {
    x_buddy_saveToHistory: false,
    user: 'kris_audio_probe',
    messages: [{ role: 'user', content: 'Say OK' }],
  });

  console.log('\naudio payload shapes (2s 440Hz tone, not speech):');

  await post('wav 16k, {data,format}', {
    x_buddy_saveToHistory: false,
    user: 'kris_audio_probe',
    messages: [
      {
        role: 'user',
        content: [{ type: 'input_audio', input_audio: { data: wav16, format: 'wav' } }],
      },
    ],
  });

  await post('wav 16k, +type:base64', {
    x_buddy_saveToHistory: false,
    user: 'kris_audio_probe',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'input_audio', input_audio: { data: wav16, format: 'wav', type: 'base64' } },
        ],
      },
    ],
  });

  await post('wav 44.1k, {data,format}', {
    x_buddy_saveToHistory: false,
    user: 'kris_audio_probe',
    messages: [
      {
        role: 'user',
        content: [{ type: 'input_audio', input_audio: { data: wav44, format: 'wav' } }],
      },
    ],
  });

  await post('wav 16k + text part', {
    x_buddy_saveToHistory: false,
    user: 'kris_audio_probe',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Please transcribe and answer this audio.' },
          { type: 'input_audio', input_audio: { data: wav16, format: 'wav' } },
        ],
      },
    ],
  });

  await post('mp3 label on wav bytes', {
    x_buddy_saveToHistory: false,
    user: 'kris_audio_probe',
    messages: [
      {
        role: 'user',
        content: [{ type: 'input_audio', input_audio: { data: wav16, format: 'mp3' } }],
      },
    ],
  });
})();
