'use strict';

/* ---------------------------------------------------------------------------
   Writes public/assets/greeting.mp3 - the audio the call opens with.

   Two ways to use it:

     npm run make:greeting
         Asks BuddyPro for a call greeting and saves the audio it returns. That
         audio is in the owner's configured voice (the same one Telegram uses),
         but the wording is Kris's own - BuddyPro will not speak supplied text.

     npm run make:greeting -- --from "C:\path\to\voice.ogg"
         Installs a file you already have, e.g. a voice message saved out of
         Telegram Desktop (right-click the voice message -> Save As). Use this
         when you want the exact introduction paragraph in her real voice.
         .ogg, .mp3, .m4a and .wav all work - browsers play them all.

   Why a script rather than a download button: BuddyPro's TTS only fires when a
   request carries audio, so generating the greeting needs a short audio sample.
   This records one with headless Chrome's test device.
   --------------------------------------------------------------------------- */

const fs = require('fs');
const path = require('path');

require('../lib/config');

const KEY = process.env.BUDDYPRO_API_KEY;
const ASSETS = path.join(__dirname, '..', 'public', 'assets');

const GREETING_PROMPT =
  'You are Kris Safarova, founder of StrategyTraining and FIRMSconsulting, ' +
  'answering a voice call. Ignore the audio entirely - it is only a connection ' +
  'sample, not a question. Greet the member warmly in two sentences, say who you ' +
  'are, and ask what they would like to work on. Never mention audio, files, ' +
  'recordings or tests.';

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : null;
}

/* ---- install a file the user already has -------------------------------- */

function installFrom(source) {
  if (!fs.existsSync(source)) {
    console.error('No such file: ' + source);
    process.exit(1);
  }

  const ext = (path.extname(source) || '.mp3').toLowerCase();
  const allowed = ['.mp3', '.ogg', '.oga', '.m4a', '.wav', '.aac', '.opus'];
  if (allowed.indexOf(ext) === -1) {
    console.error('Unexpected audio type ' + ext + '. Expected one of ' + allowed.join(', '));
    process.exit(1);
  }

  fs.mkdirSync(ASSETS, { recursive: true });

  /* Keep the real extension: the page tries each of them in turn. */
  const target = path.join(ASSETS, 'greeting' + ext);
  fs.copyFileSync(source, target);

  const size = (fs.statSync(target).size / 1024).toFixed(1);
  console.log('Installed ' + path.basename(target) + ' (' + size + ' KB)');
  console.log('The call will now open with this recording.');
}

/* ---- record a sample, then ask BuddyPro for a greeting ------------------ */

async function recordSample() {
  const puppeteer = require('puppeteer-core');
  const CHROME = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].find((p) => fs.existsSync(p));

  if (!CHROME) throw new Error('No Chrome found - pass --from with a file instead.');

  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || CHROME,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-gpu',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
    ],
  });

  try {
    const page = await browser.newPage();
    /* Any secure context will do; about:blank cannot use getUserMedia. */
    await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });

    return await page.evaluate(async () => {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
      const chunks = [];
      rec.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };
      rec.start();
      await new Promise((r) => setTimeout(r, 2500));
      await new Promise((r) => {
        rec.onstop = r;
        rec.stop();
      });
      stream.getTracks().forEach((t) => t.stop());

      /* Decode and re-encode to 16 kHz mono WAV - BuddyPro rejects WebM. */
      const raw = await new Blob(chunks, { type: 'audio/webm' }).arrayBuffer();
      const ctx = new AudioContext();
      const decoded = await ctx.decodeAudioData(raw);
      const frames = Math.ceil(decoded.duration * 16000);
      const off = new OfflineAudioContext(1, frames, 16000);
      const src = off.createBufferSource();
      src.buffer = decoded;
      src.connect(off.destination);
      src.start(0);
      const pcm = (await off.startRendering()).getChannelData(0);

      const buf = new ArrayBuffer(44 + pcm.length * 2);
      const dv = new DataView(buf);
      const str = (o, s) => {
        for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i));
      };
      str(0, 'RIFF');
      dv.setUint32(4, 36 + pcm.length * 2, true);
      str(8, 'WAVE');
      str(12, 'fmt ');
      dv.setUint32(16, 16, true);
      dv.setUint16(20, 1, true);
      dv.setUint16(22, 1, true);
      dv.setUint32(24, 16000, true);
      dv.setUint32(28, 32000, true);
      dv.setUint16(32, 2, true);
      dv.setUint16(34, 16, true);
      str(36, 'data');
      dv.setUint32(40, pcm.length * 2, true);
      let o = 44;
      for (let i = 0; i < pcm.length; i++) {
        const v = Math.max(-1, Math.min(1, pcm[i]));
        dv.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true);
        o += 2;
      }
      const u = new Uint8Array(buf);
      let s = '';
      for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
      return btoa(s);
    });
  } finally {
    await browser.close();
  }
}

async function generate() {
  if (!KEY) {
    console.error('BUDDYPRO_API_KEY is not set.');
    process.exit(1);
  }

  console.log('Recording a short sample (BuddyPro only speaks when sent audio)...');
  const sample = await recordSample();

  /* BuddyPro's audio is intermittent - the same request can 500 then succeed a
     moment later - so give it several goes rather than failing on the first. */
  /* Each attempt is a paid BuddyPro request, so keep it low. Override with
     --attempts N if its audio is having a bad day. */
  const ATTEMPTS = Math.max(1, Math.min(6, Number(argValue('--attempts')) || 2));
  let message = null;
  let lastError = '';

  for (let attempt = 1; attempt <= ATTEMPTS && !message; attempt++) {
    console.log('Asking Kris to greet (attempt ' + attempt + ' of ' + ATTEMPTS + ')...');
    message = await askOnce(sample).catch((e) => {
      lastError = e.message || String(e);
      return null;
    });
    if (!message && attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, 3000));
  }

  if (!message) {
    console.error('');
    console.error('BuddyPro would not return audio after ' + ATTEMPTS + ' attempts.');
    if (lastError) console.error('Last error: ' + lastError);
    console.error('');
    console.error('Its audio is measurably intermittent. Either run this again later, or');
    console.error('install a Telegram voice note directly:');
    console.error("  npm run make:greeting -- --from \"path/to/voice.ogg\"");
    process.exit(1);
  }

  fs.mkdirSync(ASSETS, { recursive: true });
  const target = path.join(ASSETS, 'greeting.mp3');
  fs.writeFileSync(target, Buffer.from(message.audio.data, 'base64'));

  const size = (fs.statSync(target).size / 1024).toFixed(1);
  console.log('');
  console.log("Saved greeting.mp3 (" + size + " KB), in Kris's own voice.");
  console.log('She says: ' + String(message.content).replace(/s+/g, ' ').slice(0, 200));
  console.log('');
  console.log('For the exact introduction paragraph instead, send it to the Kris bot in');
  console.log('Telegram, save the voice message it returns, then run:');
  console.log("  npm run make:greeting -- --from \"path/to/voice.ogg\"");
}

/** One attempt. Resolves the message when it carries audio, else rejects. */
async function askOnce(sample) {
  const res = await fetch('https://api.buddypro.ai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user: 'greeting_builder',
      x_buddy_saveToHistory: false,
      modalities: ['text', 'audio'],
      audio: { format: 'mp3' },
      x_buddy_systemPrompt: GREETING_PROMPT,
      x_buddy_systemPromptMode: 'replace',
      messages: [
        { role: 'user', content: [{ type: 'input_audio', input_audio: { data: sample, format: 'wav' } }] },
      ],
    }),
  });

  const body = await res.json().catch(() => null);
  if (body && body.error) throw new Error(body.error.code + ': ' + body.error.message);

  const message = body && body.choices && body.choices[0] && body.choices[0].message;
  if (!message || !message.audio || !message.audio.data) {
    throw new Error(
      'replied without audio' + (message ? ' - "' + String(message.content).slice(0, 60) + '"' : '')
    );
  }
  return message;
}

const from = argValue('--from');
if (from) installFrom(from);
else
  generate().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
