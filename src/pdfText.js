'use strict';

// PDF text extraction for chat attachments — Muse Bridge v0.4.4.
//
// Main process only: the renderer classifies a PDF (src/attachments.js)
// and hands the raw bytes over IPC; this module does the parsing here.
// The engine is pdfjs-dist's legacy build — pure JS, no native parts —
// required the way Node/Electron main processes have loaded it for
// years. (pdf-parse 1.x was tried first and rejected: its bundled
// 2017-era pdf.js throws "bad XRef entry" on valid PDFs under the
// current Node/Electron runtime.)
//
// extractPdfText resolves { text, numpages, hasText }:
//   text     — the document's text in reading order, lightly
//              normalized (CRLF -> LF, 3+ blank lines collapsed, ends
//              trimmed; a blank line separates pages).
//   hasText  — false when the PDF holds no extractable text at all
//              (scanned / image-only PDFs): the caller must refuse
//              the attachment honestly instead of sending an empty
//              document the user believes arrived.
// It throws when the bytes are not a parseable PDF at all; the IPC
// handler in main.js turns that into an honest "could not be read"
// for the user.

const path = require('path');
const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');

// pdf.js wants its cmap + standard-font data folders for PDFs whose
// fonts are not embedded (common in the wild: CJK encodings live in
// the cmaps, the base-14 font metrics in standard_fonts). Point it at
// the installed package's own folders.
const PDFJS_PKG_DIR = path.dirname(require.resolve('pdfjs-dist/package.json'));
const CMAP_URL = path.join(PDFJS_PKG_DIR, 'cmaps') + path.sep;
const STANDARD_FONT_DATA_URL = path.join(PDFJS_PKG_DIR, 'standard_fonts') + path.sep;

async function extractPdfText(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  if (buffer.length === 0) {
    throw new Error('the file is empty');
  }
  // pdf.js takes ownership of the array it is given — hand it a copy.
  const data = new Uint8Array(buffer);
  const doc = await pdfjs.getDocument({
    data,
    cMapUrl: CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: STANDARD_FONT_DATA_URL
  }).promise;
  const numpages = doc.numPages;
  try {
    const lines = [];
    for (let p = 1; p <= numpages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      let line = '';
      for (const item of content.items) {
        if (!item || typeof item.str !== 'string') continue;
        line += item.str;
        if (item.hasEOL) {
          lines.push(line.replace(/\s+$/, ''));
          line = '';
        } else if (line && !line.endsWith(' ')) {
          line += ' ';
        }
      }
      if (line) lines.push(line.replace(/\s+$/, ''));
      lines.push(''); // page break
    }
    const text = lines
      .join('\n')
      .replace(/\r\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return { text, numpages, hasText: text.length > 0 };
  } finally {
    await doc.destroy();
  }
}

module.exports = { extractPdfText };
