'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const mammoth = require('mammoth');
const { PDFParse } = require('pdf-parse');

const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.text']);

function normalizeText(text) {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isUsefulPdfExtraction(text) {
  if (!text) {
    return false;
  }

  const stripped = text.replace(/--\s*\d+\s+of\s+\d+\s*--/gi, '').trim();
  return stripped.length >= 40;
}

async function readDocx(filePath) {
  const result = await mammoth.extractRawText({ path: filePath });
  return normalizeText(result.value || '');
}

async function readPdf(filePath) {
  const buffer = fs.readFileSync(filePath);
  const parser = new PDFParse({ data: buffer });

  try {
    const result = await parser.getText();
    const normalized = normalizeText(result.text || '');
    if (isUsefulPdfExtraction(normalized)) {
      return normalized;
    }
  } finally {
    await parser.destroy();
  }

  try {
    const pymupdfText = childProcess.execFileSync(
      'python3',
      [
        '-c',
        [
          'import fitz, sys',
          'doc = fitz.open(sys.argv[1])',
          "text = '\\n'.join(page.get_text('text') for page in doc)",
          'print(text)',
        ].join('; '),
        filePath,
      ],
      {
        encoding: 'utf8',
        maxBuffer: 20 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );

    return normalizeText(pymupdfText || '');
  } catch (error) {
    return '';
  }
}

async function readText(filePath) {
  return normalizeText(fs.readFileSync(filePath, 'utf8'));
}

async function loadDocumentText(filePath) {
  const extension = path.extname(filePath).toLowerCase();

  if (TEXT_EXTENSIONS.has(extension)) {
    return readText(filePath);
  }

  if (extension === '.docx') {
    return readDocx(filePath);
  }

  if (extension === '.pdf') {
    return readPdf(filePath);
  }

  throw new Error(
    `Unsupported file type for ${filePath}. Supported extensions: ${Array.from(TEXT_EXTENSIONS).join(', ')}, .docx, .pdf`,
  );
}

module.exports = {
  loadDocumentText,
};
