'use strict';

/* ---------------------------------------------------------------------------
   Storage. Three calls - get, put, del - over two drivers:

     spaces   DigitalOcean Spaces through its S3 API. Private objects only.
              Requests are signed here (AWS Signature V4) rather than pulling in
              the AWS SDK, which would add tens of megabytes for three calls.
     disk     a folder, for local development. App Platform wipes its disk on
              every deploy, so this is never used in production.

   Layout under the prefix:
     members/<memberId>.json          email, sharing choice, report ids
     reports/<id>/meta.json           status, stages, document info
     reports/<id>/inputs.json         what the member submitted (text only)
     reports/<id>/work.json           profile, costs, section drafts
     reports/<id>/narrative.pdf
     reports/<id>/article.pdf
     shared.json                      the library of shared reports
     active.json                      reports queued or running (survives deploys)
   --------------------------------------------------------------------------- */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./config');

const cfg = config.storage;

/* ---- disk --------------------------------------------------------------- */

function diskPath(key) {
  const clean = String(key).replace(/\\/g, '/');
  if (clean.includes('..')) throw new Error('bad key');
  return path.join(cfg.diskRoot, cfg.prefix, clean);
}

const disk = {
  async get(key) {
    try {
      return await fs.promises.readFile(diskPath(key));
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  },
  async put(key, body) {
    /* Write then rename, so a reader never sees a half-written file (a Spaces
       PUT is atomic in the same way). */
    const file = diskPath(key);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const tmp = file + '.' + process.pid + '.' + Date.now() + '.' + Math.random().toString(36).slice(2) + '.tmp';
    await fs.promises.writeFile(tmp, body);
    /* Windows refuses the rename while another request has the file open for
       reading; that lasts milliseconds, so wait and try again. */
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.promises.rename(tmp, file);
        return;
      } catch (err) {
        if (!(err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES') || attempt >= 8) {
          await fs.promises.unlink(tmp).catch(() => {});
          throw err;
        }
        await new Promise((r) => setTimeout(r, 15 * (attempt + 1)));
      }
    }
  },
  async del(key) {
    try {
      await fs.promises.unlink(diskPath(key));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  },
};

/* ---- spaces (S3, signature v4) ------------------------------------------ */

const REGION = process.env.MP_SPACES_REGION || 'us-east-1';

function sha256hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}
function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}
function encodeKey(key) {
  return key
    .split('/')
    .map((seg) => encodeURIComponent(seg).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()))
    .join('/');
}

async function spacesRequest(method, key, body, contentType) {
  const host = cfg.bucket + '.' + new URL(cfg.endpoint).host;
  const uri = '/' + encodeKey(cfg.prefix + '/' + key);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const payloadHash = sha256hex(body || '');

  const headers = { host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  if (contentType) headers['content-type'] = contentType;

  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonical = [
    method,
    uri,
    '',
    Object.keys(headers).sort().map((h) => h + ':' + headers[h] + '\n').join(''),
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = day + '/' + REGION + '/s3/aws4_request';
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonical)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac('AWS4' + cfg.secret, day), REGION), 's3'), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(toSign).digest('hex');

  const res = await fetch('https://' + host + uri, {
    method,
    headers: {
      ...headers,
      authorization:
        'AWS4-HMAC-SHA256 Credential=' + cfg.key + '/' + scope +
        ', SignedHeaders=' + signedHeaders + ', Signature=' + signature,
    },
    body: method === 'PUT' ? body : undefined,
    signal: AbortSignal.timeout(30000),
  });
  return res;
}

const spaces = {
  async get(key) {
    const res = await spacesRequest('GET', key);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error('spaces GET ' + key + ' -> ' + res.status + ' ' + (await res.text()).slice(0, 200));
    return Buffer.from(await res.arrayBuffer());
  },
  async put(key, body, contentType) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const res = await spacesRequest('PUT', key, buf, contentType || 'application/octet-stream');
    if (!res.ok) throw new Error('spaces PUT ' + key + ' -> ' + res.status + ' ' + (await res.text()).slice(0, 200));
  },
  async del(key) {
    const res = await spacesRequest('DELETE', key);
    if (!res.ok && res.status !== 404) throw new Error('spaces DELETE ' + key + ' -> ' + res.status);
  },
};

const driver = cfg.driver === 'spaces' ? spaces : disk;

/* ---- JSON helpers with a small read cache --------------------------------
   The library and member files are read on every page load. One process
   serves the app (instance_count 1), so an in-memory cache that is updated on
   every write stays correct and saves a round trip to Spaces per request. */

const cache = new Map();
const CACHEABLE = /^(members\/|shared\.json$|active\.json$)/;

async function getJson(key, fallback = null) {
  if (cache.has(key)) return structuredClone(cache.get(key));
  const buf = await driver.get(key);
  const value = buf ? JSON.parse(buf.toString('utf8')) : fallback;
  if (CACHEABLE.test(key) && buf) cache.set(key, structuredClone(value));
  return value;
}

async function putJson(key, value) {
  await driver.put(key, JSON.stringify(value), 'application/json');
  if (CACHEABLE.test(key)) cache.set(key, structuredClone(value));
}

/* Serialise read-modify-write on one key, so two requests updating the
   library at once cannot drop each other's change. */
const locks = new Map();
async function update(key, fallback, fn) {
  const prev = locks.get(key) || Promise.resolve();
  let release;
  const mine = new Promise((r) => (release = r));
  const chained = prev.then(() => mine);
  locks.set(key, chained);
  await prev;
  try {
    const current = await getJson(key, fallback);
    const next = (await fn(current)) ?? current;
    await putJson(key, next);
    return next;
  } finally {
    release();
    if (locks.get(key) === chained) locks.delete(key);
  }
}

async function del(key) {
  cache.delete(key);
  await driver.del(key);
}

module.exports = {
  get: (key) => driver.get(key),
  put: (key, body, type) => driver.put(key, body, type),
  del,
  getJson,
  putJson,
  update,
  driverName: cfg.driver,
};
