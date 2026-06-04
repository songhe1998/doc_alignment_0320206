'use strict';

const fs = require('fs');
const path = require('path');

const mammoth = require('mammoth');
const { PDFParse } = require('pdf-parse');
const { buildDocxFormatOutline } = require('./docxFormatting');
const {
  buildPdfFormatOutline,
  extractPdfTextWithLayout,
  isUsefulTextExtraction,
} = require('./pdfFormatting');

const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.text']);

function normalizeText(text) {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function readDocx(filePath) {
  const result = await mammoth.extractRawText({ path: filePath });
  return normalizeText(result.value || '');
}

async function readPdf(filePath) {
  const layoutText = extractPdfTextWithLayout(filePath);
  if (isUsefulTextExtraction(layoutText)) {
    return layoutText;
  }

  const buffer = fs.readFileSync(filePath);
  const parser = new PDFParse({ data: buffer });

  try {
    const result = await parser.getText();
    const normalized = normalizeText(result.text || '');
    if (isUsefulTextExtraction(normalized)) {
      return normalized;
    }
  } finally {
    await parser.destroy();
  }

  return layoutText;
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

async function loadTemplatePromptText(filePath) {
  const text = await loadDocumentText(filePath);
  const extension = path.extname(filePath).toLowerCase();

  if (extension !== '.docx' && extension !== '.pdf') {
    return text;
  }

  let outline = '';
  try {
    outline = extension === '.docx' ? buildDocxFormatOutline(filePath) : buildPdfFormatOutline(filePath);
  } catch (error) {
    outline = '';
  }
  if (!outline) {
    return text;
  }

  return [
    'FORMAT-AWARE TEMPLATE OUTLINE',
    `The bracketed labels below describe visual markup from the target ${extension === '.docx' ? 'DOCX' : 'PDF'}.`,
    'Use [TITLE] as the main title, [HEADING] as heading markup, [BLANK LINE] or blank-line-before as vertical spacing, align=center as centered text, font=Npt as relative font size, and bold as emphasis.',
    outline,
    '',
    'PLAIN TEMPLATE TEXT',
    text,
  ].join('\n');
}

module.exports = {
  loadDocumentText,
  loadTemplatePromptText,
};
