'use strict';

// PDF attachment tests (v0.4.4) — plain asserts, no network, no DOM.
// The sample PDFs are GENERATED here (minimal hand-built documents),
// never committed as binary fixtures:
//   1. a multi-page PDF attaches: its extracted text lands inside the
//      document block the outgoing message carries;
//   2. a PDF with no text layer (the scanned / image-only case)
//      yields hasText=false and the honest refusal message;
//   3. bytes that are not a PDF at all make the extractor throw, and
//      a genuinely unsupported type still classifies as unsupported.
// Run: node tests/pdf.test.js

const assert = require('assert');
const ATT = require('../src/attachments');
const { extractPdfText } = require('../src/pdfText');

// ---- minimal PDF generator ----
// pageTexts: one string per page ('' = a page that draws nothing,
// which is what a scanned page looks like to a text extractor).
function buildPdf(pageTexts) {
  const objects = [];
  const pageObjNums = pageTexts.map((_, i) => 4 + i * 2);
  const contentObjNums = pageTexts.map((_, i) => 5 + i * 2);
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageObjNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${pageTexts.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  pageTexts.forEach((text, i) => {
    objects[pageObjNums[i]] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObjNums[i]} 0 R >>`;
    const esc = String(text).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
    const stream = text ? `BT /F1 12 Tf 72 720 Td (${esc}) Tj ET` : '';
    objects[contentObjNums[i]] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  let out = '%PDF-1.4\n';
  const offsets = [0];
  const maxObj = Math.max(...Object.keys(objects).map(Number));
  for (let n = 1; n <= maxObj; n++) {
    offsets[n] = Buffer.byteLength(out, 'latin1');
    out += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xrefStart = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxObj; n++) {
    out += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${maxObj + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

(async () => {
  // ---- 1. a multi-page PDF attaches, text in the outgoing block ----
  const twoPages = buildPdf(['Hello from page one', 'Second page text']);
  const cls = ATT.classifyFile({
    name: 'sample.pdf',
    type: 'application/pdf',
    size: twoPages.length,
    sample: new Uint8Array(twoPages.subarray(0, ATT.SNIFF_BYTES))
  });
  assert.strictEqual(cls.kind, 'pdf', 'the sample classifies as a PDF');

  const extracted = await extractPdfText(twoPages);
  assert.strictEqual(extracted.numpages, 2, 'both pages parsed');
  assert.strictEqual(extracted.hasText, true);
  assert.ok(extracted.text.includes('Hello from page one'), 'page one text extracted');
  assert.ok(extracted.text.includes('Second page text'), 'page two text extracted');

  // This is the exact shape the renderer stages and the send path
  // wraps: the extracted text must survive into the message content.
  const content = `please read this\n\n${ATT.buildDocumentBlock({ name: 'sample.pdf', text: extracted.text, truncated: false })}`;
  assert.ok(content.includes('Hello from page one'), 'page one text lands in the outgoing message');
  assert.ok(content.includes('Second page text'), 'page two text lands in the outgoing message');
  assert.deepStrictEqual(ATT.extractDocumentNames(content), ['sample.pdf']);

  // ---- 2. a text-less PDF is the scanned case: honest refusal ----
  const scanned = buildPdf(['']);
  const scanResult = await extractPdfText(scanned);
  assert.strictEqual(scanResult.numpages, 1);
  assert.strictEqual(scanResult.hasText, false, 'a page that draws nothing has no text layer');
  assert.strictEqual(scanResult.text, '');
  const refusal = ATT.pdfNoTextMessage('scan.pdf');
  assert.ok(/scanned or image-only/.test(refusal) && /was not attached/.test(refusal));

  // ---- 3. garbage is not a PDF; other types stay unsupported ----
  await assert.rejects(
    () => extractPdfText(Buffer.from('%PDF-1.4 this header lies; the body is not a document')),
    'garbage behind a PDF header throws instead of attaching junk'
  );
  await assert.rejects(() => extractPdfText(Buffer.alloc(0)), 'an empty file throws');
  const zip = ATT.classifyFile({
    name: 'bundle.zip',
    type: 'application/zip',
    size: 100,
    sample: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00])
  });
  assert.strictEqual(zip.kind, 'unsupported', 'a zip is still refused');
  assert.ok(/pdf files/.test(zip.message), 'the refusal names pdf among what IS supported');

  console.log('pdf.test.js: ALL PASS');
})().catch((err) => {
  console.error('pdf.test.js: FAIL —', err && err.message ? err.message : err);
  process.exit(1);
});
