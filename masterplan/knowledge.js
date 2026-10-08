'use strict';

/* ---------------------------------------------------------------------------
   The MasterPlan's source material: the client's Master Guide, the method,
   the item list and the two worked examples about the test client.

   That material is the client's intellectual property and contains a real
   person's details, and this repository is public. So it is never committed
   in readable form:

     masterplan/knowledge/       the readable files - local only (.gitignore)
     masterplan/knowledge.enc    the same files sealed with AES-256-GCM,
                                 committed; opened at runtime with the key in
                                 MP_KNOWLEDGE_KEY (a secret on DigitalOcean)

   Local files win when present, so editing them locally needs no key. After
   editing, re-seal with:   npm run seal:masterplan-knowledge
   --------------------------------------------------------------------------- */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const DIR = path.join(__dirname, 'knowledge');
const SEALED = path.join(__dirname, 'knowledge.enc');
const FILES = ['guide.md', 'process.md', 'masterplan_items.json', 'example-narrative.md', 'example-article.md', 'private-names.json'];

function keyBuffer() {
  const hex = String(process.env.MP_KNOWLEDGE_KEY || '').trim();
  if (!/^[0-9a-f]{64}$/i.test(hex)) return null;
  return Buffer.from(hex, 'hex');
}

let opened = null;
function openSealed() {
  if (opened) return opened;
  const key = keyBuffer();
  if (!key) throw new Error('MP_KNOWLEDGE_KEY is not set (64 hex characters), so masterplan/knowledge.enc cannot be opened.');
  const box = JSON.parse(fs.readFileSync(SEALED, 'utf8'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
  const plain = Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()]);
  opened = JSON.parse(zlib.gunzipSync(plain).toString('utf8'));
  return opened;
}

function hasLocal() {
  return FILES.every((f) => fs.existsSync(path.join(DIR, f)));
}

/** One knowledge file as text. */
function read(name) {
  const local = path.join(DIR, name);
  if (fs.existsSync(local)) return fs.readFileSync(local, 'utf8');
  const all = openSealed();
  if (!(name in all)) throw new Error('knowledge file missing from the sealed bundle: ' + name);
  return all[name];
}

/** Why the knowledge cannot be loaded, or null when it can. */
function problem() {
  if (hasLocal()) return null;
  if (!fs.existsSync(SEALED)) return 'masterplan/knowledge.enc is missing.';
  if (!keyBuffer()) return 'MP_KNOWLEDGE_KEY is not set (64 hex characters).';
  try {
    openSealed();
    return null;
  } catch (err) {
    return 'masterplan/knowledge.enc could not be opened with MP_KNOWLEDGE_KEY (' + err.message + ').';
  }
}

/** Seal the local files into knowledge.enc. Used by the seal script. */
function seal() {
  const key = keyBuffer();
  if (!key) throw new Error('Set MP_KNOWLEDGE_KEY (64 hex characters) first.');
  const all = {};
  for (const f of FILES) all[f] = fs.readFileSync(path.join(DIR, f), 'utf8');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(zlib.gzipSync(JSON.stringify(all))), cipher.final()]);
  const box = { v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
  fs.writeFileSync(SEALED, JSON.stringify(box));
  return { files: FILES.length, bytes: fs.statSync(SEALED).size };
}

module.exports = { read, problem, seal, FILES };
