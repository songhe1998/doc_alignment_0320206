'use strict';

const assert = require('node:assert/strict');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { buildPdfFormatOutline, extractPdfTextWithLayout } = require('../src/pdfFormatting');
const { applyTemplatePdfMarkdownFormatting } = require('../src/alignCore');
const { loadTemplatePromptText } = require('../src/documentLoader');

function hasPyMuPdf() {
  const result = childProcess.spawnSync('python3', ['-c', 'import fitz'], {
    stdio: 'ignore',
  });
  return result.status === 0;
}

function writePdfFixture(filePath) {
  childProcess.execFileSync(
    'python3',
    [
      '-c',
      String.raw`
import fitz
import sys

doc = fitz.open()
page = doc.new_page(width=612, height=792)
page.insert_textbox(fitz.Rect(72, 58, 540, 92), "CONFIDENTIALITY AGREEMENT", fontsize=16, align=fitz.TEXT_ALIGN_CENTER)
page.insert_text(fitz.Point(72, 138), "ARTICLE 1", fontsize=12)
page.insert_text(fitz.Point(72, 166), "Definitions", fontsize=12)
page.insert_text(fitz.Point(72, 202), "Recipient may use Confidential Information only for Project Atlas.", fontsize=11)
doc.save(sys.argv[1])
`,
      filePath,
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

function writeSmallTitlePdfFixture(filePath) {
  childProcess.execFileSync(
    'python3',
    [
      '-c',
      String.raw`
import fitz
import sys

doc = fitz.open()
page = doc.new_page(width=612, height=792)
page.insert_text(fitz.Point(72, 72), "CONFIDENTIALITY AGREEMENT", fontsize=10)
page.insert_text(fitz.Point(72, 120), "(Definitions)", fontsize=14)
page.insert_text(fitz.Point(72, 152), "ARTICLE 1 Recipient information remains confidential.", fontsize=10)
doc.save(sys.argv[1])
`,
      filePath,
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

function writeCenteredSubtitlePdfFixture(filePath) {
  childProcess.execFileSync(
    'python3',
    [
      '-c',
      String.raw`
import fitz
import sys

doc = fitz.open()
page = doc.new_page(width=612, height=792)
page.insert_textbox(fitz.Rect(72, 58, 540, 92), "CONFIDENTIALITY AGREEMENT", fontsize=16, align=fitz.TEXT_ALIGN_CENTER)
page.insert_textbox(fitz.Rect(72, 100, 540, 126), "for Project Atlas", fontsize=12, align=fitz.TEXT_ALIGN_CENTER)
page.insert_text(fitz.Point(72, 166), "ARTICLE 1", fontsize=12)
doc.save(sys.argv[1])
`,
      filePath,
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

test('buildPdfFormatOutline exposes title, heading, spacing, font, and alignment cues', { skip: !hasPyMuPdf() }, () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-format-outline-'));
  const templatePath = path.join(tempDir, 'template.pdf');

  try {
    writePdfFixture(templatePath);

    const outline = buildPdfFormatOutline(templatePath);

    assert.match(outline, /\[TITLE align=center font=16pt page=1\] CONFIDENTIALITY AGREEMENT/);
    assert.match(outline, /\[HEADING blank-line-before font=12pt page=1\] ARTICLE 1/);
    assert.match(outline, /\[PARAGRAPH blank-line-before font=11pt page=1\] Recipient may use Confidential Information only for Project Atlas\./);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('PDF template prompt includes a format-aware outline and visual text extraction', { skip: !hasPyMuPdf() }, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-template-prompt-'));
  const templatePath = path.join(tempDir, 'template.pdf');

  try {
    writePdfFixture(templatePath);

    const text = extractPdfTextWithLayout(templatePath);
    const promptText = await loadTemplatePromptText(templatePath);

    assert.match(text, /CONFIDENTIALITY AGREEMENT/);
    assert.match(text, /ARTICLE 1/);
    assert.match(promptText, /FORMAT-AWARE TEMPLATE OUTLINE/);
    assert.match(promptText, /visual markup from the target PDF/);
    assert.match(promptText, /\[TITLE align=center font=16pt page=1\] CONFIDENTIALITY AGREEMENT/);
    assert.match(promptText, /PLAIN TEMPLATE TEXT/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('buildPdfFormatOutline keeps parenthetical headings from replacing a plain legal title', { skip: !hasPyMuPdf() }, () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-small-title-outline-'));
  const templatePath = path.join(tempDir, 'template.pdf');

  try {
    writeSmallTitlePdfFixture(templatePath);

    const outline = buildPdfFormatOutline(templatePath);

    assert.match(outline, /\[TITLE font=10pt page=1\] CONFIDENTIALITY AGREEMENT/);
    assert.match(outline, /\[HEADING blank-line-before font=14pt page=1\] \(Definitions\)/);
    assert.doesNotMatch(outline, /\[TITLE[^\]]+\] \(Definitions\)/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('applyTemplatePdfMarkdownFormatting centers the first title when the PDF template title is centered', { skip: !hasPyMuPdf() }, () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-centered-title-markdown-'));
  const templatePath = path.join(tempDir, 'template.pdf');

  try {
    writePdfFixture(templatePath);

    const markdown = [
      '# CONFIDENTIALITY AGREEMENT',
      '',
      '## ARTICLE 1',
      '',
      'Recipient may use Confidential Information only for Project Atlas.',
    ].join('\n');
    const formatted = applyTemplatePdfMarkdownFormatting(markdown, templatePath);

    assert.match(formatted, /^\\begin\{center\}/);
    assert.match(formatted, /\\bfseries CONFIDENTIALITY AGREEMENT\\par/);
    assert.match(formatted, /## ARTICLE 1/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('applyTemplatePdfMarkdownFormatting centers a short subtitle when the template has a centered subtitle', { skip: !hasPyMuPdf() }, () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-centered-subtitle-markdown-'));
  const templatePath = path.join(tempDir, 'template.pdf');

  try {
    writeCenteredSubtitlePdfFixture(templatePath);

    const markdown = [
      '# MUTUAL NON-DISCLOSURE AND USE OF INFORMATION AGREEMENT',
      '',
      '**to Support Emergency Cyber Mutual Assistance**',
      '',
      '## ARTICLE 1',
    ].join('\n');
    const formatted = applyTemplatePdfMarkdownFormatting(markdown, templatePath);

    assert.match(formatted, /\\bfseries MUTUAL NON-DISCLOSURE/);
    assert.match(formatted, /\\large to Support Emergency Cyber Mutual Assistance\\par/);
    assert.match(formatted, /## ARTICLE 1/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
