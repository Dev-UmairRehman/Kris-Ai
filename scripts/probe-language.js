'use strict';

/* ---------------------------------------------------------------------------
   Finds out what actually forces BuddyPro to answer in one language.

   BuddyPro auto-detects the user's language and adapts per message. With no
   Telegram app to read a preference from, API callers get a guess - which is
   why replies come back in mixed languages. The docs say an explicit request
   ("Please speak English with me") works, and the Owner API may also accept
   x_buddy_systemPrompt. This measures which of those is true.

   Usage: node scripts/probe-language.js
   --------------------------------------------------------------------------- */

require('../lib/config');

const KEY = process.env.BUDDYPRO_API_KEY;
const URL = 'https://api.buddypro.ai/v1/chat/completions';

/* Rough script detector: which writing systems / language markers appear. */
function classify(text) {
  const s = String(text || '');
  const marks = [];
  if (/[ऀ-ॿ]/.test(s)) marks.push('devanagari');
  if (/[؀-ۿ]/.test(s)) marks.push('arabic/urdu');
  if (/[Ѐ-ӿ]/.test(s)) marks.push('cyrillic');
  if (/[一-鿿]/.test(s)) marks.push('cjk');

  /* Romanised Hindi/Urdu is the failure mode actually seen, so look for it. */
  const hinglish = (s.match(
    /\b(aap|aapka|aapke|aapko|mujhse|mujhe|kya|hai|hain|karo|karke|abhi|nahi|nahin|chahiye|yeh|woh|bas|sirf|baare|waqt|dimaag|zindagi|kaam|log|acha|theek)\b/gi
  ) || []).length;
  if (hinglish >= 2) marks.push('romanised hindi/urdu (' + hinglish + ' markers)');

  return marks.length ? marks.join(', ') : 'looks like plain english';
}

async function ask(label, body) {
  const started = Date.now();
  let res;
  let text;
  try {
    res = await fetch(URL, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    text = await res.text();
  } catch (err) {
    console.log(label.padEnd(30) + ' NETWORK ' + err.message);
    return null;
  }

  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* leave null */
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const err = parsed && parsed.error;

  if (err) {
    console.log(
      label.padEnd(30) + ' HTTP ' + res.status + ' ' + seconds + 's  ERROR ' +
        err.code + ': ' + String(err.message).slice(0, 70)
    );
    return null;
  }

  const message = parsed && parsed.choices && parsed.choices[0] && parsed.choices[0].message;
  const content = (message && message.content) || '';

  console.log(label.padEnd(30) + ' HTTP ' + res.status + ' ' + seconds + 's  ' + classify(content));
  console.log('    ' + content.replace(/\s+/g, ' ').slice(0, 150));
  if (message && message.audio) {
    console.log('    AUDIO: ' + message.audio.format + ', ' + (message.audio.data || '').length + ' b64 chars');
  }
  return content;
}

const QUESTION = 'Where should I start with strategy?';
const DIRECTIVE =
  'Always reply in English only, regardless of the language of the question. Never mix languages.';

(async () => {
  if (!KEY) {
    console.error('BUDDYPRO_API_KEY missing');
    process.exit(1);
  }

  const stamp = Date.now().toString(36);

  console.log('1) baseline - fresh profile, no language steering');
  await ask('plain question', {
    x_buddy_saveToHistory: false,
    user: 'lang_a_' + stamp,
    messages: [{ role: 'user', content: QUESTION }],
  });

  console.log('\n2) x_buddy_systemPrompt (Owner API only, per the docs)');
  await ask('systemPrompt mode=add', {
    x_buddy_saveToHistory: false,
    user: 'lang_b_' + stamp,
    x_buddy_systemPrompt: DIRECTIVE,
    x_buddy_systemPromptMode: 'add',
    messages: [{ role: 'user', content: QUESTION }],
  });

  await ask('systemPrompt (no mode)', {
    x_buddy_saveToHistory: false,
    user: 'lang_c_' + stamp,
    x_buddy_systemPrompt: DIRECTIVE,
    messages: [{ role: 'user', content: QUESTION }],
  });

  console.log('\n3) directive inside the message itself');
  await ask('prefixed directive', {
    x_buddy_saveToHistory: false,
    user: 'lang_d_' + stamp,
    messages: [{ role: 'user', content: '[' + DIRECTIVE + ']\n\n' + QUESTION }],
  });

  await ask('suffixed directive', {
    x_buddy_saveToHistory: false,
    user: 'lang_e_' + stamp,
    messages: [{ role: 'user', content: QUESTION + '\n\n(' + DIRECTIVE + ')' }],
  });

  console.log('\n4) audio output - does BuddyPro return its own voice?');
  await ask('audio, isolated profile', {
    x_buddy_saveToHistory: false,
    user: 'lang_f_' + stamp,
    modalities: ['text', 'audio'],
    audio: { format: 'mp3' },
    messages: [{ role: 'user', content: 'Say hello in one short sentence.' }],
  });

  await ask('audio, default profile', {
    x_buddy_saveToHistory: false,
    modalities: ['text', 'audio'],
    audio: { format: 'mp3' },
    messages: [{ role: 'user', content: 'Say hello in one short sentence.' }],
  });
})();
