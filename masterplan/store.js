'use strict';

/* ---------------------------------------------------------------------------
   Storage. get / put / del for files, getJson / putJson / update for records,
   over two drivers:

     supabase  production. The small JSON records live in one Postgres table
               (public.mp_records, one row per key) and the files in a private
               Storage bucket, both reached over Supabase's HTTPS APIs with the
               secret key - no database driver, no open connection to hold.
               Schema: masterplan/sql/001_storage.sql.
     disk      a folder, for local development and the tests.

   Keys:
     members/<memberId>.json          email, sharing choice, devices, report ids  record
     reports/<id>/meta.json           status, stages, document info               record
     reports/<id>/work.json           profile, costs, the drafts                  record
     reports/<id>/inputs.json         what the member submitted, with the resume  file (large; deleted once ready)
     reports/<id>/narrative.pdf                                                   file
     reports/<id>/article.pdf                                                     file
     reports/<id>/podcast.mp3                                                     file
     shared.json, active.json, usage.json                                         record

   Kept lean on purpose. One process serves the app (instance_count 1), so:
     - records are cached in memory and written through, and the page's
       polling every few seconds costs no database call;
     - files are cached on local disk (bounded, least recently used first),
       so opening a PDF or replaying a podcast does not download it again.
   --------------------------------------------------------------------------- */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('./config');

const cfg = config.storage;

/* Records go to the table; everything else, and the resume-carrying
   inputs.json, goes to the bucket. */
function isRecord(key) {
  return key.endsWith('.json') && !key.endsWith('/inputs.json');
}

function checkKey(key) {
  const clean = String(key).replace(/\\/g, '/');
  if (!clean || clean.includes('..') || clean.startsWith('/')) throw new Error('bad key');
  return clean;
}

/* ---- disk --------------------------------------------------------------- */

function diskPath(key) {
  return path.join(cfg.diskRoot, cfg.prefix, checkKey(key));
}

async function writeAtomic(file, body) {
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
    /* Write then rename, so a reader never sees a half-written file. */
    await writeAtomic(diskPath(key), body);
  },
  async del(key) {
    try {
      await fs.promises.unlink(diskPath(key));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  },
  async getRecord(key) {
    const buf = await disk.get(key);
    return buf ? JSON.parse(buf.toString('utf8')) : null;
  },
  async putRecord(key, value) {
    await disk.put(key, JSON.stringify(value));
  },
};

/* ---- supabase ----------------------------------------------------------- */

/* One request, retried on network errors and 5xx/429 (twice, briefly). */
async function sb(method, urlPath, { body, headers, timeout = 30000 } = {}) {
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 400 * attempt * attempt));
    try {
      const res = await fetch(cfg.supabaseUrl + urlPath, {
        method,
        headers: { apikey: cfg.supabaseKey, authorization: 'Bearer ' + cfg.supabaseKey, ...headers },
        body,
        signal: AbortSignal.timeout(timeout),
      });
      if (res.status >= 500 || res.status === 429) {
        last = new Error('supabase ' + method + ' ' + urlPath.split('?')[0] + ' -> ' + res.status);
        continue;
      }
      return res;
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

async function fail(res, what) {
  return new Error('supabase ' + what + ' -> ' + res.status + ' ' + (await res.text()).slice(0, 200));
}

const objectPath = (key) =>
  '/storage/v1/object/' + encodeURIComponent(cfg.bucket) + '/' + checkKey(key).split('/').map(encodeURIComponent).join('/');
const recordPath = (key) => '/rest/v1/' + cfg.table + '?key=eq.' + encodeURIComponent(checkKey(key));

const supabase = {
  async get(key) {
    const res = await sb('GET', objectPath(key), { timeout: 120000 });
    /* Storage answers a missing object with 400 and a 404 inside. */
    if (res.status === 404 || res.status === 400) {
      const text = await res.text();
      if (res.status === 404 || /not_found|NoSuchKey|"404"/.test(text)) return null;
      throw new Error('supabase GET ' + key + ' -> 400 ' + text.slice(0, 200));
    }
    if (!res.ok) throw await fail(res, 'GET ' + key);
    return Buffer.from(await res.arrayBuffer());
  },
  async put(key, body, contentType) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const res = await sb('POST', objectPath(key), {
      body: buf,
      headers: { 'content-type': contentType || 'application/octet-stream', 'x-upsert': 'true', 'cache-control': 'no-store' },
      timeout: 120000,
    });
    if (!res.ok) throw await fail(res, 'PUT ' + key);
  },
  async del(key) {
    const res = await sb('DELETE', objectPath(key));
    if (!res.ok && res.status !== 404 && res.status !== 400) throw await fail(res, 'DELETE ' + key);
  },
  async getRecord(key) {
    const res = await sb('GET', recordPath(key) + '&select=value');
    if (!res.ok) throw await fail(res, 'read ' + key);
    const rows = await res.json();
    return rows.length ? rows[0].value : null;
  },
  async putRecord(key, value) {
    const res = await sb('POST', '/rest/v1/' + cfg.table, {
      body: JSON.stringify({ key: checkKey(key), value, updated_at: new Date().toISOString() }),
      headers: { 'content-type': 'application/json', prefer: 'resolution=merge-duplicates,return=minimal' },
    });
    if (!res.ok) throw await fail(res, 'write ' + key);
  },
  async delRecord(key) {
    const res = await sb('DELETE', recordPath(key), { headers: { prefer: 'return=minimal' } });
    if (!res.ok) throw await fail(res, 'delete ' + key);
  },
};

const driver = cfg.driver === 'supabase' ? supabase : disk;

/* ---- file cache (local disk, bounded) --------------------------------------
   PDFs and podcasts never change once written, so a copy on the server's own
   disk is always right. Least recently used files go first once the cache is
   over MP_FILE_CACHE_MB. The folder is emptied on start: the index lives in
   memory. */

const fileCache = (() => {
  if (driver === disk || !(cfg.cacheMb > 0)) return null;
  const dir = path.join(os.tmpdir(), 'mp-file-cache');
  const max = cfg.cacheMb * 1024 * 1024;
  const index = new Map(); // key -> bytes, oldest first
  let total = 0;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return null;
  }
  const fileFor = (key) => path.join(dir, crypto.createHash('sha1').update(key).digest('hex'));
  function drop(key) {
    if (!index.has(key)) return;
    total -= index.get(key);
    index.delete(key);
    fs.promises.unlink(fileFor(key)).catch(() => {});
  }
  return {
    async get(key) {
      if (!index.has(key)) return null;
      try {
        const buf = await fs.promises.readFile(fileFor(key));
        const n = index.get(key);
        index.delete(key);
        index.set(key, n); // most recently used
        return buf;
      } catch {
        drop(key);
        return null;
      }
    },
    async set(key, buf) {
      if (buf.length > max / 4) return; // one huge file must not empty the cache
      drop(key);
      try {
        await writeAtomic(fileFor(key), buf);
      } catch {
        return;
      }
      index.set(key, buf.length);
      total += buf.length;
      for (const k of index.keys()) {
        if (total <= max) break;
        drop(k);
      }
    },
    drop,
  };
})();

const cacheableFile = (key) => /\.(pdf|mp3)$/.test(key);

async function get(key) {
  if (fileCache && cacheableFile(key)) {
    const hit = await fileCache.get(key);
    if (hit) return hit;
    const buf = await driver.get(key);
    if (buf) await fileCache.set(key, buf);
    return buf;
  }
  return driver.get(key);
}

async function put(key, body, type) {
  await driver.put(key, body, type);
  /* A new document is usually opened within minutes; keep it at hand. */
  if (fileCache && cacheableFile(key)) await fileCache.set(key, Buffer.isBuffer(body) ? body : Buffer.from(body));
}

/* ---- records ----------------------------------------------------------------
   Cached in memory and written through: the page polls the member's reports
   every few seconds, and that must not be a database call each time. The
   drafts (work.json) are large and rarely read, so they are not cached. The
   cache is bounded; the oldest entries go first. */

const cache = new Map();
const CACHE_MAX = 5000;
const cacheable = (key) => !key.endsWith('/work.json');

function remember(key, value) {
  if (!cacheable(key)) return;
  cache.delete(key);
  cache.set(key, structuredClone(value));
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

async function getJson(key, fallback = null) {
  if (cache.has(key)) return structuredClone(cache.get(key));
  let value;
  if (isRecord(key)) value = await driver.getRecord(key);
  else {
    const buf = await driver.get(key);
    value = buf ? JSON.parse(buf.toString('utf8')) : null;
  }
  if (value === null) return fallback;
  if (isRecord(key)) remember(key, value);
  return value;
}

async function putJson(key, value) {
  if (isRecord(key)) {
    await driver.putRecord(key, value);
    remember(key, value);
  } else {
    await driver.put(key, JSON.stringify(value), 'application/json');
  }
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
  if (fileCache) fileCache.drop(key);
  if (isRecord(key) && driver.delRecord) await driver.delRecord(key);
  else await driver.del(key);
}

module.exports = {
  get,
  put,
  del,
  getJson,
  putJson,
  update,
  driverName: cfg.driver,
};
