'use strict';

/* ---------------------------------------------------------------------------
   Intake: turn what the member submitted into material the model can read.

   Resume
     .pdf   passed to Claude as a document; the profile step transcribes it.
     .docx  text pulled out here (a .docx is a zip; word/document.xml holds the
            text). Done by hand because it is ~60 lines and a library is not.
     .txt   used as is.

   Social profiles
     Only the public page, as the Master Guide requires. The server reads the
     page title and description tags. Instagram and LinkedIn often answer a
     server with a login wall, so the member can also paste their bio and
     recent post titles, and the document says how thin the evidence was.
   --------------------------------------------------------------------------- */

const zlib = require('zlib');
const dns = require('dns').promises;
const net = require('net');

/* ---- resume ------------------------------------------------------------- */

function kindOf(filename, buf) {
  const name = String(filename || '').toLowerCase();
  if (buf.slice(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (buf.readUInt32LE(0) === 0x04034b50 && name.endsWith('.docx')) return 'docx';
  if (name.endsWith('.txt') || name.endsWith('.md')) return 'txt';
  if (buf.readUInt32LE(0) === 0x04034b50) return 'docx';
  return null;
}

function unzipEntry(buf, wanted) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);

  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');

    if (name === wanted) {
      const lNameLen = buf.readUInt16LE(local + 26);
      const lExtraLen = buf.readUInt16LE(local + 28);
      const start = local + 30 + lNameLen + lExtraLen;
      const data = buf.slice(start, start + csize);
      if (method === 0) return data;
      if (method === 8) return zlib.inflateRawSync(data);
      throw new Error('unsupported zip compression ' + method);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

function docxText(buf) {
  const xml = unzipEntry(buf, 'word/document.xml');
  if (!xml) throw new Error('no word/document.xml in the file');
  const text = xml
    .toString('utf8')
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(text)
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * @returns {{ kind: 'pdf'|'docx'|'txt', text: string|null, pdfBase64: string|null }}
 */
function readResume(filename, base64) {
  const buf = Buffer.from(String(base64 || ''), 'base64');
  if (buf.length < 50) throw Object.assign(new Error('The resume file is empty.'), { userFacing: true });
  const kind = kindOf(filename, buf);
  if (!kind) {
    throw Object.assign(new Error('Please upload the resume as a PDF, Word (.docx) or text file.'), { userFacing: true });
  }
  if (kind === 'pdf') return { kind, text: null, pdfBase64: buf.toString('base64') };
  let text;
  try {
    text = kind === 'docx' ? docxText(buf) : buf.toString('utf8').trim();
  } catch {
    /* A damaged or unusual .docx: trying again will not help, so say so. */
    throw Object.assign(new Error('We could not read that Word file. Save it again, or upload it as a PDF.'), { userFacing: true });
  }
  if (text.length < 200) {
    throw Object.assign(new Error('We could not read enough text from that resume. Try a PDF.'), { userFacing: true });
  }
  return { kind, text: text.slice(0, 60000), pdfBase64: null };
}

/* ---- social pages ------------------------------------------------------- */

function isPrivateIp(ip) {
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80')) return true;
    if (l.startsWith('::ffff:')) return isPrivateIp(l.slice(7));
    return false;
  }
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 10 || a === 127 || a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

async function assertPublic(url) {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('unsupported scheme');
  const addrs = await dns.lookup(url.hostname, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error('not a public address');
}

function metaContent(html, attr, name) {
  const re = new RegExp('<meta[^>]+' + attr + '=["\']' + name + '["\'][^>]*>', 'i');
  const tag = html.match(re);
  if (!tag) return '';
  const c = tag[0].match(/content=["']([^"']*)["']/i);
  return c ? decodeEntities(c[1]).trim() : '';
}

/** Public title + description of a profile page. Never throws. */
async function readProfilePage(rawUrl) {
  const out = { url: rawUrl, ok: false, title: '', description: '', note: '' };
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    out.note = 'not a valid link';
    return out;
  }
  try {
    for (let hop = 0; hop < 4; hop++) {
      await assertPublic(url);
      const res = await fetch(url, {
        redirect: 'manual',
        headers: {
          'user-agent': 'Mozilla/5.0 (compatible; StrategyTrainingMasterPlan/1.0)',
          accept: 'text/html',
        },
        signal: AbortSignal.timeout(8000),
      });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        url = new URL(res.headers.get('location'), url);
        continue;
      }
      if (!res.ok) {
        out.note = 'the page answered ' + res.status;
        return out;
      }
      const html = (await res.text()).slice(0, 600000);
      const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || '';
      out.title = metaContent(html, 'property', 'og:title') || decodeEntities(title).trim();
      out.description =
        metaContent(html, 'property', 'og:description') ||
        metaContent(html, 'name', 'description') ||
        metaContent(html, 'name', 'twitter:description');
      out.ok = !!(out.title || out.description);
      if (!out.ok) out.note = 'the public page showed no profile text (often a login wall)';
      return out;
    }
    out.note = 'too many redirects';
  } catch (err) {
    out.note = 'could not be read (' + err.message + ')';
  }
  return out;
}

module.exports = { readResume, readProfilePage, docxText, isPrivateIp };
