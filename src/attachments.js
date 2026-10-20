'use strict';

// Attachment classification + document blocks — Muse Bridge v0.3.4.
//
// Pure and environment-agnostic on purpose: this module runs in the
// browser renderer (loaded as a classic script, exposed as
// window.MuseAttachments) AND under bare node (module.exports) so the
// classification rules are unit-tested (tests/attachments.test.js).
// It never touches the DOM, the filesystem, or the network: callers
// hand it a file's name / MIME type / size plus a small sample of its
// first bytes, and it answers one of:
//   { kind: 'image' }       — a vision-format image (png / jpeg / webp)
//   { kind: 'document' }    — readable as text; content rides in the
//                             outgoing message inside a document block
//   { kind: 'pdf' }         — a PDF (v0.4.4): the caller hands the raw
//                             bytes to the main process, which extracts
//                             the text (src/pdfText.js); the extracted
//                             text then stages as a document, capped
//                             and blocked exactly like a text file
//   { kind: 'unsupported' } — cannot be read; the caller must say so
//                             honestly and never silently drop the file
//
// Document blocks are the labeled wrapper a text file's contents travel
// in inside a chat message:
//   [Attached document: notes.txt]
//   ...contents...
//   [End of attached document: notes.txt]
// A block truncated at the cap says so inside the wrapper — the model
// (and anyone reading the history) can see the contents are partial.

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.MuseAttachments = api;
  }
})(typeof window !== 'undefined' ? window : null, function () {
  // Vision formats the Meta Model API accepts (same set Teach mode has
  // always validated in main + the lessons store).
  const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

  const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // matches the Teach-mode cap
  const MAX_PDF_BYTES = 25 * 1024 * 1024; // raw PDF cap (extracted text is capped separately)
  const DOC_CAP_BYTES = 100 * 1024; // per-file text cap in a message
  const DOC_CAP_LABEL = '100 KB';
  const SNIFF_BYTES = 1024; // how much of a file classification samples

  // Extensions that are plain text by convention. Anything else can
  // still qualify as a document via its MIME type or by content sniff.
  const TEXT_EXTENSIONS = new Set([
    'txt', 'md', 'markdown', 'rst', 'text',
    'json', 'jsonl', 'csv', 'tsv',
    'log', 'xml', 'html', 'htm', 'xhtml', 'css',
    'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'mts', 'cts',
    'py', 'rb', 'java', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'cs', 'go',
    'rs', 'php', 'sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd',
    'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env',
    'sql', 'r', 'swift', 'kt', 'scala', 'pl', 'lua', 'diff', 'patch'
  ]);

  // Non-text/* MIME types that are still plain text in practice.
  const TEXT_MIME_TYPES = new Set([
    'application/json',
    'application/xml',
    'application/javascript',
    'application/x-javascript',
    'application/typescript',
    'application/x-yaml',
    'application/yaml',
    'application/toml',
    'application/sql'
  ]);

  function extensionOf(name) {
    const base = String(name || '').split(/[\\/]/).pop() || '';
    const dot = base.lastIndexOf('.');
    if (dot <= 0 || dot === base.length - 1) return '';
    return base.slice(dot + 1).toLowerCase();
  }

  // Heuristic text check on a byte sample: a NUL byte settles it
  // (binary); otherwise allow only a small share of control characters.
  // Bytes >= 0x80 are fine — they are how UTF-8 encodes non-ASCII text.
  function isTextSample(bytes) {
    if (!bytes || bytes.length === 0) return true;
    let control = 0;
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      if (b === 0) return false;
      if ((b < 0x09 || (b > 0x0d && b < 0x20) || b === 0x7f) && b !== 0x1b) control++;
    }
    return control / bytes.length <= 0.02;
  }

  function unsupported(reason, message) {
    return { kind: 'unsupported', reason, message };
  }

  // PDF magic: every PDF begins with the five bytes "%PDF-".
  function isPdfSample(bytes) {
    if (!bytes || bytes.length < 5) return false;
    return (
      bytes[0] === 0x25 && // %
      bytes[1] === 0x50 && // P
      bytes[2] === 0x44 && // D
      bytes[3] === 0x46 && // F
      bytes[4] === 0x2d // -
    );
  }

  // The honest refusal for a PDF that parses but holds no extractable
  // text (a scanned / image-only PDF). The file is NOT attached: the
  // model would receive an empty document and the user would never
  // know the content never arrived.
  function pdfNoTextMessage(name) {
    const label = name || 'that file';
    return `"${label}" appears to be a scanned or image-only PDF — it has no readable text to extract, so it was not attached.`;
  }

  // classifyFile({ name, type, size, sample })
  //   name:   file name (used for its extension)
  //   type:   MIME type as reported by the browser/OS (may be '')
  //   size:   byte size (0 when unknown)
  //   sample: Uint8Array of the first bytes (may be null/empty when the
  //           caller could not read any — then only name/MIME decide)
  function classifyFile(input) {
    const name = input && typeof input.name === 'string' ? input.name : '';
    const mime = ((input && input.type) || '').toLowerCase().split(';')[0].trim();
    const size = input && typeof input.size === 'number' && input.size > 0 ? input.size : 0;
    const sample = input ? input.sample : null;
    const label = name || 'that file';

    if (IMAGE_MIME_TYPES.includes(mime)) {
      if (size > MAX_IMAGE_BYTES) {
        return unsupported(
          'image-too-large',
          `"${label}" is ${formatSize(size)} — images are capped at about 8 MB. Take a smaller screenshot and try again.`
        );
      }
      return { kind: 'image', via: 'mime' };
    }
    if (mime.startsWith('image/')) {
      return unsupported(
        'image-format',
        `"${label}" is a ${mime} image — only png, jpeg and webp images can be sent to Muse Spark.`
      );
    }

    // PDFs (v0.4.4): decided before the text rules — a PDF's header
    // bytes can look text-ish to the sniff below, and its body is
    // binary, so neither text path may claim it. The renderer cannot
    // parse a PDF; classification only says "this is a PDF", and the
    // main process extracts its text (see src/pdfText.js).
    if (extensionOf(name) === 'pdf' || mime === 'application/pdf' || isPdfSample(sample)) {
      if (size > MAX_PDF_BYTES) {
        return unsupported(
          'pdf-too-large',
          `"${label}" is ${formatSize(size)} — PDFs are capped at about ${formatSize(MAX_PDF_BYTES)}. Split it or shrink it and try again.`
        );
      }
      const via = extensionOf(name) === 'pdf' ? 'extension' : mime === 'application/pdf' ? 'mime' : 'magic';
      return { kind: 'pdf', via };
    }

    if (TEXT_EXTENSIONS.has(extensionOf(name))) {
      return { kind: 'document', via: 'extension' };
    }
    if (mime.startsWith('text/') || TEXT_MIME_TYPES.has(mime)) {
      return { kind: 'document', via: 'mime' };
    }
    if (sample && isTextSample(sample)) {
      // Unknown name/MIME, but the bytes themselves read as text
      // (this also covers a genuinely empty file, whose sample is empty).
      return { kind: 'document', via: 'sniff' };
    }
    return unsupported(
      'binary',
      `"${label}" can't be read as an image or a text document, so it was not attached. Attach png/jpeg/webp images, pdf files, or text files (txt, md, json, csv, log, code) instead.`
    );
  }

  function formatSize(bytes) {
    const n = typeof bytes === 'number' && bytes > 0 ? bytes : 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  // File names ride inside the block markers, so strip anything that
  // could break out of a marker (brackets, newlines).
  function sanitizeName(name) {
    return String(name || '').replace(/[\[\]\r\n]/g, '').trim();
  }

  function buildDocumentBlock({ name, text, truncated } = {}) {
    const safe = sanitizeName(name) || 'document';
    const lines = [`[Attached document: ${safe}]`];
    if (truncated) {
      lines.push(
        `[Note: this file is larger than ${DOC_CAP_LABEL} — only the first ${DOC_CAP_LABEL} is included below.]`
      );
    }
    lines.push(text == null ? '' : String(text));
    lines.push(`[End of attached document: ${safe}]`);
    return lines.join('\n');
  }

  const BLOCK_RE = /\[Attached document: ([^\]\n]+)\]\n[\s\S]*?\n\[End of attached document: \1\]/g;

  function extractDocumentNames(content) {
    const names = [];
    const re = /\[Attached document: ([^\]\n]+)\]/g;
    let m;
    const text = String(content || '');
    while ((m = re.exec(text)) !== null) names.push(m[1]);
    return names;
  }

  // For on-screen bubbles: a document block becomes one compact line
  // (the full contents still live in the stored/sent message).
  function collapseDocumentBlocks(content) {
    return String(content || '').replace(BLOCK_RE, (_m, name) => `📄 ${name} — attached document`);
  }

  // For the mock brain: keep the header as a one-line marker and drop
  // the body, so a 100 KB document is acknowledged, not echoed back.
  function stripDocumentBlocks(content) {
    return String(content || '').replace(BLOCK_RE, (_m, name) => `[Attached document: ${name}]`);
  }

  return {
    IMAGE_MIME_TYPES,
    TEXT_EXTENSIONS,
    MAX_IMAGE_BYTES,
    MAX_PDF_BYTES,
    DOC_CAP_BYTES,
    DOC_CAP_LABEL,
    SNIFF_BYTES,
    extensionOf,
    isTextSample,
    isPdfSample,
    pdfNoTextMessage,
    classifyFile,
    formatSize,
    sanitizeName,
    buildDocumentBlock,
    extractDocumentNames,
    collapseDocumentBlocks,
    stripDocumentBlocks
  };
});
