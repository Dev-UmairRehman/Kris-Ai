'use strict';

/* ---------------------------------------------------------------------------
   Markdown -> PDF, in the layout the Master Guide sets for the two documents:
   portrait letter, 1.1" side margins, 1" top and bottom, Georgia 11 pt at 1.3
   line spacing, headings 28 / 20 / 13.5 pt, Key point and Action item indented
   with a left rule, tables ruled top, bottom and between rows, sidebars shaded
   EEF1F6, one page break before Part Two, and the brand line in the footer.

   Gelasio stands in for Georgia: it is drawn to Georgia's metrics and is
   openly licensed (fonts/OFL.txt), so pages break where Georgia's would.

   pdfmake is pure JavaScript - no headless browser - so a 25-page document
   renders in well under a second inside the 512 MB instance.

   Only the markdown the writer is allowed to use is understood here; see the
   house rules in writer.js.
   --------------------------------------------------------------------------- */

const path = require('path');
const pdfmake = require('pdfmake');

const FONT_DIR = path.join(__dirname, 'fonts');
pdfmake.setFonts({
  Gelasio: {
    normal: path.join(FONT_DIR, 'Gelasio-Regular.ttf'),
    bold: path.join(FONT_DIR, 'Gelasio-Bold.ttf'),
    italics: path.join(FONT_DIR, 'Gelasio-Italic.ttf'),
    bolditalics: path.join(FONT_DIR, 'Gelasio-BoldItalic.ttf'),
  },
});
/* The documents never load anything from outside: no URLs, and no local
   files beyond the fonts. */
pdfmake.setUrlAccessPolicy(() => false);
pdfmake.setLocalAccessPolicy((p) => path.resolve(p).startsWith(FONT_DIR));

const INK = '#1A1A1A';
const RULE = '#B8BCC6';
const SHADE = '#EEF1F6';
const MARK = '¤';

/* ---- inline ---------------------------------------------------------------- */

const isWord = (c) => !!c && /[\p{L}\p{N}]/u.test(c);

/** **bold**, _italic_, [text](url) and the inference mark. */
function inline(src, base = {}) {
  const out = [];
  let bold = false;
  let italics = false;
  let buf = '';
  const flush = () => {
    if (!buf) return;
    out.push({ text: buf.split(MARK).join('*'), bold: bold || base.bold || undefined, italics: italics || base.italics || undefined });
    buf = '';
  };

  for (let i = 0; i < src.length; i++) {
    const c = src[i];

    if (c === '[') {
      const m = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/.exec(src.slice(i));
      if (m) {
        flush();
        out.push({ text: m[1], link: m[2], color: '#3D5A99', bold: bold || undefined, italics: italics || undefined });
        i += m[0].length - 1;
        continue;
      }
    }
    if (c === '*' && src[i + 1] === '*') {
      flush();
      bold = !bold;
      i++;
      continue;
    }
    if (c === '_') {
      const prev = src[i - 1];
      const next = src[i + 1];
      const opens = !italics && !isWord(prev) && next && next !== ' ';
      const closes = italics && prev && prev !== ' ' && !isWord(next);
      if (opens || closes) {
        flush();
        italics = !italics;
        continue;
      }
    }
    buf += c;
  }
  flush();
  return out.length ? out : [{ text: '' }];
}

const plain = (s) => s.replace(/\*\*|(^|\W)_|_(\W|$)/g, '$1$2').split(MARK).join('*');

/* ---- blocks --------------------------------------------------------------- */

function parseBlocks(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      blocks.push({ type: 'h', level: h[1].length, text: h[2].trim() });
      i++;
      continue;
    }
    if (/^\s*\|/.test(line)) {
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        const raw = lines[i].trim().replace(/^\|/, '').replace(/\|$/, '');
        if (!/^\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*$/.test(raw)) rows.push(raw.split('|').map((c) => c.trim()));
        i++;
      }
      blocks.push({ type: 'table', rows });
      continue;
    }
    if (/^\s*[-•]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-•]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-•]\s+/, ''));
        i++;
      }
      blocks.push({ type: 'ul', items });
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i++;
      }
      blocks.push({ type: 'ol', items });
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,3}\s|\s*\||\s*[-•]\s+|\s*\d+\.\s+)/.test(lines[i])) {
      para.push(lines[i].trim());
      i++;
    }
    blocks.push({ type: 'p', text: para.join(' ') });
  }
  return blocks;
}

const isCallout = (b) => b.type === 'p' && /^_?(Key point|Action item):/i.test(b.text);

/* ---- layout --------------------------------------------------------------- */

const ruledTable = {
  hLineWidth: (i, node) => (i === 0 || i === node.table.body.length || i === 1 ? 0.8 : 0.5),
  vLineWidth: () => 0,
  hLineColor: () => RULE,
  paddingLeft: () => 4,
  paddingRight: () => 6,
  paddingTop: () => 4,
  paddingBottom: () => 4,
};

const calloutLayout = {
  hLineWidth: () => 0,
  vLineWidth: (i) => (i === 0 ? 2 : 0),
  vLineColor: () => '#A9B2C3',
  paddingLeft: () => 12,
  paddingRight: () => 0,
  paddingTop: () => 3,
  paddingBottom: () => 3,
};

const sidebarLayout = {
  hLineWidth: (i, node) => (i === 0 || i === node.table.body.length ? 0.8 : 0.5),
  vLineWidth: () => 0,
  hLineColor: () => RULE,
  fillColor: () => SHADE,
  paddingLeft: () => 8,
  paddingRight: () => 8,
  paddingTop: () => 5,
  paddingBottom: () => 5,
};

/* Column widths for the tables the guide defines. The writer may produce a
   table with a different number of columns than expected, so a preset is used
   only when its length matches; otherwise every column shares the width. */
function widthsFor(header) {
  const h = header.map((x) => plain(x).toLowerCase());
  const n = h.length;
  const presets = { '#': [18, '*', 150], line: [86, 62, '*'], asset: [120, 100, '*'], element: [80, '*'] };
  const preset = presets[h[0]];
  if (preset && preset.length === n) return preset;
  if (h[0] === '#' && n > 1) return [18].concat(Array(n - 1).fill('*'));
  return Array(n).fill('*');
}

function tableNode(rows) {
  if (!rows.length) return null;
  const header = rows[0];

  /* A one-column table is a sidebar ("Idea in brief", "Questions to ask yourself"). */
  if (header.length === 1) {
    return {
      table: {
        widths: ['*'],
        headerRows: 1,
        dontBreakRows: true,
        body: rows.map((r, idx) => [{ text: inline(r[0] || '', idx === 0 ? { bold: true } : {}), fontSize: 10, lineHeight: 1.2 }]),
      },
      layout: sidebarLayout,
      margin: [0, 6, 0, 12],
    };
  }

  const width = header.length;
  const body = rows.map((r, idx) => {
    const cells = [];
    for (let c = 0; c < width; c++) {
      cells.push({ text: inline(r[c] || '', idx === 0 ? { bold: true } : {}), fontSize: 9.5, lineHeight: 1.15 });
    }
    return cells;
  });
  return {
    table: { widths: widthsFor(header), headerRows: 1, dontBreakRows: true, body },
    layout: ruledTable,
    margin: [0, 4, 0, 12],
  };
}

const H = {
  1: { fontSize: 28, bold: true, alignment: 'center', margin: [0, 0, 0, 4], lineHeight: 1.1 },
  2: { fontSize: 20, bold: true, margin: [0, 18, 0, 8], lineHeight: 1.1 },
  3: { fontSize: 13.5, bold: true, margin: [0, 12, 0, 4], lineHeight: 1.1 },
};

/**
 * @param {string} md
 * @param {object} o  { kind: 'narrative'|'article', footerText, brandLine, title }
 */
function docDefinition(md, o) {
  const blocks = parseBlocks(md);
  const content = [];
  let seenH2 = false;
  let firstH1 = true;
  let partTwoBroken = false;

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];

    if (b.type === 'h') {
      const node = { text: inline(b.text), ...H[b.level], headlineLevel: b.level, color: INK };
      if (b.level === 1 && firstH1) {
        node.margin = [0, 54, 0, 4];
        firstH1 = false;
      }
      if (b.level === 2) {
        seenH2 = true;
        if (o.kind === 'narrative' && !partTwoBroken && /^Part Two/i.test(plain(b.text))) {
          node.pageBreak = 'before';
          node.margin = [0, 0, 0, 8];
          partTwoBroken = true;
        }
      }
      content.push(node);
      continue;
    }

    if (isCallout(b)) {
      const group = [];
      while (i < blocks.length && isCallout(blocks[i])) {
        group.push({ text: inline(blocks[i].text), italics: true, margin: [0, 0, 0, 4] });
        i++;
      }
      i--;
      content.push({ table: { widths: ['*'], body: [[{ stack: group }]] }, layout: calloutLayout, margin: [18, 2, 18, 12], unbreakable: true });
      continue;
    }

    if (b.type === 'table') {
      const t = tableNode(b.rows);
      if (t) content.push(t);
      continue;
    }

    if (b.type === 'ul' || b.type === 'ol') {
      content.push({
        [b.type]: b.items.map((it) => ({ text: inline(it), margin: [0, 0, 0, 5] })),
        margin: [10, 0, 0, 8],
      });
      continue;
    }

    /* Paragraphs. Before the first part heading they form the title page. */
    if (!seenH2) {
      const text = plain(b.text);
      const isConversation = /^This document exists to force a conversation/.test(text);
      const isNote = /^(A note on this document|Editor.s note)/i.test(text);
      if (isConversation) {
        content.push({ text: inline(b.text), margin: [0, 4, 0, 14] });
      } else if (isNote && o.kind === 'narrative') {
        content.push({ text: inline(b.text), fontSize: 10, margin: [24, 10, 24, 6] });
      } else {
        content.push({ text: inline(b.text), alignment: 'center', fontSize: text.length > 200 ? 10.5 : 11, margin: [10, 2, 10, 8] });
      }
      continue;
    }
    content.push({ text: inline(b.text), margin: [0, 0, 0, 8] });
  }

  return {
    pageSize: 'LETTER',
    pageMargins: [79, 72, 79, 76],
    info: { title: o.title, author: 'FIRMSconsulting', creator: 'StrategyTraining.com', producer: 'MasterPlan Digital' },
    defaultStyle: { font: 'Gelasio', fontSize: 11, lineHeight: 1.3, color: INK },
    content,
    styles: { mpFooter: {} },
    footer: (page) => ({
      style: 'mpFooter',
      stack: [
        { text: o.footerText + '   |   Page ' + page, style: 'mpFooter', alignment: 'center', fontSize: 8.5, color: '#333' },
        { text: o.brandLine, style: 'mpFooter', alignment: 'center', fontSize: 7.5, color: '#777', margin: [0, 2, 0, 0] },
      ],
      margin: [79, 24, 79, 0],
    }),
    /* Keep a heading with the text under it. The footer's own nodes are on
       every page, so they do not count as text under the heading. */
    pageBreakBefore: (node, q) =>
      !!node.headlineLevel &&
      q.getFollowingNodesOnPage().filter((n) => !n.headlineLevel && n.style !== 'mpFooter').length === 0,
  };
}

async function toPdf(md, o) {
  const buffer = await pdfmake.createPdf(docDefinition(md, o)).getBuffer();
  const pages = (buffer.toString('latin1').match(/\/Type\s*\/Page\b(?!s)/g) || []).length;
  return { buffer, pages };
}

module.exports = { toPdf, parseBlocks, inline, docDefinition };
