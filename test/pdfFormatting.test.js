'use strict';

const assert = require('node:assert/strict');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { buildPdfFormatOutline, extractPdfTextWithLayout } = require('../src/pdfFormatting');
const {
  applyPdfFormatOverrides,
  applyTemplatePdfMarkdownFormatting,
  resolvePdfTemplateLayout,
} = require('../src/alignCore');
const { loadTemplatePromptText } = require('../src/documentLoader');

function hasPyMuPdf() {
  const result = childProcess.spawnSync('python3', ['-c', 'import fitz'], {
    stdio: 'ignore',
  });
  return result.status === 0;
}

function hasCommand(command) {
  return childProcess.spawnSync(command, ['--version'], { stdio: 'ignore' }).status === 0;
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

function writeNarrowModestPdfFixture(filePath) {
  childProcess.execFileSync(
    'python3',
    [
      '-c',
      String.raw`
import fitz
import sys

doc = fitz.open()
page = doc.new_page(width=612, height=792)
page.insert_text(fitz.Point(144, 126), "MASTER SERVICES AGREEMENT", fontsize=10)
page.insert_textbox(fitz.Rect(144, 146, 468, 190), "This MASTER SERVICES AGREEMENT is made by and between the parties.", fontsize=10)
page.insert_text(fitz.Point(144, 220), "ARTICLE I DEFINITIONS", fontsize=10)
page.insert_textbox(fitz.Rect(144, 240, 468, 284), "1.1 Services means professional services described by the parties.", fontsize=10)
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
    assert.match(formatted, /ARTICLE 1/);
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
    assert.match(formatted, /ARTICLE 1/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('PDF template layout narrows margins and tones down modest headings', { skip: !hasPyMuPdf() }, () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-modest-heading-layout-'));
  const templatePath = path.join(tempDir, 'template.pdf');

  try {
    writeNarrowModestPdfFixture(templatePath);

    const layout = resolvePdfTemplateLayout(templatePath);
    assert.ok(layout.geometry.leftIn > 1.8);
    assert.ok(layout.geometry.rightIn > 1.8);
    assert.ok(layout.geometry.topIn > 1.6);

    const markdown = [
      '# MASTER SERVICES AGREEMENT',
      '',
      'Introductory paragraph.',
      '',
      '## ARTICLE I',
      '',
      '## DEFINITIONS',
      '',
      '1.1 Services means professional services.',
    ].join('\n');
    const formatted = applyTemplatePdfMarkdownFormatting(markdown, templatePath);

    assert.doesNotMatch(formatted, /^# MASTER/m);
    assert.doesNotMatch(formatted, /^## ARTICLE/m);
    assert.match(formatted, /\\fontsize\{10pt\}\{12pt\}\\selectfont MASTER SERVICES AGREEMENT/);
    assert.match(formatted, /\\fontsize\{10pt\}\{12pt\}\\selectfont ARTICLE I DEFINITIONS/);
    assert.doesNotMatch(formatted, /## DEFINITIONS/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('plain Markdown templates treat soft-wrapped article lines as one rendered heading', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-plain-markdown-template-'));
  const templatePath = path.join(tempDir, 'template.md');

  try {
    fs.writeFileSync(
      templatePath,
      [
        'MASTER SERVICES AGREEMENT',
        '',
        'This MASTER SERVICES AGREEMENT is made by the parties.',
        '',
        'ARTICLE I',
        'DEFINITIONS',
        '',
        '1.1 "Services" means professional services.',
      ].join('\n'),
      'utf8',
    );

    const markdown = [
      '# CONFIDENTIALITY AGREEMENT',
      '',
      'Introductory paragraph.',
      '',
      '## ARTICLE I DEFINITIONS',
      '',
      '1.1 "Confidential Information" means non-public information.',
      '',
      '## ARTICLE II',
      '',
      '## TERM AND TERMINATION',
      '',
      'ARTICLE III MISCELLANEOUS',
    ].join('\n');
    const formatted = applyTemplatePdfMarkdownFormatting(markdown, templatePath);

    assert.doesNotMatch(formatted, /^# /m);
    assert.doesNotMatch(formatted, /^## /m);
    assert.match(formatted, /^CONFIDENTIALITY AGREEMENT$/m);
    assert.match(formatted, /ARTICLE I DEFINITIONS\n\\par\\nopagebreak\[4\]/);
    assert.match(formatted, /ARTICLE II TERM AND TERMINATION\n\\par\\nopagebreak\[4\]/);
    assert.match(formatted, /ARTICLE III MISCELLANEOUS\n\\par\\nopagebreak\[4\]/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Markdown hard breaks preserve split article heading lines', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-hard-break-template-'));
  const templatePath = path.join(tempDir, 'template.md');

  try {
    fs.writeFileSync(
      templatePath,
      ['MASTER SERVICES AGREEMENT', '', 'ARTICLE I  ', 'DEFINITIONS'].join('\n'),
      'utf8',
    );
    const formatted = applyTemplatePdfMarkdownFormatting(
      ['# CONFIDENTIALITY AGREEMENT', '', '## ARTICLE I DEFINITIONS'].join('\n'),
      templatePath,
    );

    assert.match(formatted, /ARTICLE I  \n\\nopagebreak\[4\]\nDEFINITIONS\n\\par\\nopagebreak\[4\]/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('plain text templates preserve physical article heading line breaks', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-plain-text-template-'));
  const templatePath = path.join(tempDir, 'template.txt');

  try {
    fs.writeFileSync(
      templatePath,
      ['MASTER SERVICES AGREEMENT', '', 'ARTICLE I', 'DEFINITIONS'].join('\n'),
      'utf8',
    );
    const formatted = applyTemplatePdfMarkdownFormatting(
      ['# CONFIDENTIALITY AGREEMENT', '', '## ARTICLE I DEFINITIONS'].join('\n'),
      templatePath,
    );

    assert.match(formatted, /ARTICLE I  \n\\nopagebreak\[4\]\nDEFINITIONS\n\\par\\nopagebreak\[4\]/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Markdown PDF templates with heading markup keep generated heading markup', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-markdown-heading-template-'));
  const templatePath = path.join(tempDir, 'template.md');

  try {
    fs.writeFileSync(
      templatePath,
      ['# MASTER SERVICES AGREEMENT', '', '## ARTICLE I', '', '## DEFINITIONS'].join('\n'),
      'utf8',
    );

    const markdown = ['# CONFIDENTIALITY AGREEMENT', '', '## ARTICLE I DEFINITIONS'].join('\n');
    const formatted = applyTemplatePdfMarkdownFormatting(markdown, templatePath);

    assert.match(formatted, /^# CONFIDENTIALITY AGREEMENT$/m);
    assert.match(formatted, /^## ARTICLE I$/m);
    assert.match(formatted, /^## DEFINITIONS$/m);
    assert.match(formatted, /## DEFINITIONS\n\\nopagebreak\[4\]/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('combined plain templates combine generated split headings without copying template captions', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-combined-markdown-template-'));
  const templatePath = path.join(tempDir, 'template.md');

  try {
    fs.writeFileSync(
      templatePath,
      ['MASTER SERVICES AGREEMENT', '', 'ARTICLE I PAYMENT TERMS'].join('\n'),
      'utf8',
    );
    const markdown = [
      '# CONFIDENTIALITY AGREEMENT',
      '',
      '## ARTICLE I',
      '',
      '### CONFIDENTIAL INFORMATION',
    ].join('\n');
    const formatted = applyTemplatePdfMarkdownFormatting(markdown, templatePath);

    assert.match(formatted, /^ARTICLE I CONFIDENTIAL INFORMATION$/m);
    assert.doesNotMatch(formatted, /PAYMENT TERMS/);
    assert.doesNotMatch(formatted, /^CONFIDENTIAL INFORMATION$/m);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('mixed templates normalize exact article labels but leave unsupported labels unchanged', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-mixed-markdown-template-'));
  const templatePath = path.join(tempDir, 'template.md');

  try {
    fs.writeFileSync(
      templatePath,
      [
        '# MASTER SERVICES AGREEMENT',
        '',
        '## ARTICLE I',
        '### DEFINITIONS',
        '',
        '## ARTICLE II TERM',
      ].join('\n'),
      'utf8',
    );
    const markdown = [
      '# CONFIDENTIALITY AGREEMENT',
      '',
      '## ARTICLE I CONFIDENTIAL INFORMATION',
      '',
      '## ARTICLE II',
      '### DURATION',
      '',
      '## ARTICLE III MISCELLANEOUS',
    ].join('\n');
    const formatted = applyTemplatePdfMarkdownFormatting(markdown, templatePath);

    assert.match(formatted, /^## ARTICLE I$/m);
    assert.match(formatted, /^### CONFIDENTIAL INFORMATION$/m);
    assert.match(formatted, /^## ARTICLE II DURATION$/m);
    assert.match(formatted, /^## ARTICLE III MISCELLANEOUS$/m);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('PDF formatting keeps Markdown, bold-only, and split headings with following content', () => {
  const markdown = [
    '# AGREEMENT',
    '',
    '## ARTICLE I',
    '',
    '### DEFINITIONS',
    '',
    'Definition text.',
    '',
    '**9. No Warranties or Representations.**',
    '',
    'The warranty paragraph follows.',
  ].join('\n');

  const formatted = applyTemplatePdfMarkdownFormatting(markdown, '');

  assert.match(formatted, /# AGREEMENT\n\\nopagebreak\[4\]/);
  assert.match(formatted, /## ARTICLE I\n\\nopagebreak\[4\]/);
  assert.match(formatted, /### DEFINITIONS\n\\nopagebreak\[4\]/);
  assert.match(formatted, /\*\*9\. No Warranties or Representations\.\*\*\n\\nopagebreak\[4\]/);
  assert.equal((formatted.match(/\\nopagebreak\[4\]/g) || []).length, 4);
});

test(
  'rendered PDF keeps a bold legal heading with its following paragraph',
  { skip: !hasPyMuPdf() || !hasCommand('pandoc') || !hasCommand('xelatex') },
  () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-heading-pagination-'));
    const outputPath = path.join(tempDir, 'output.pdf');

    try {
      const filler = Array.from(
        { length: 42 },
        (_, index) =>
          `Filler paragraph ${index + 1}. This sentence occupies enough horizontal space to exercise normal legal-document line wrapping near the page boundary.`,
      ).join('\n\n');
      const markdown = [
        '# PAGINATION REGRESSION',
        '',
        filler,
        '',
        '**9. No Warranties or Representations.**',
        '',
        'The warranty paragraph follows the heading and must remain on the same page.',
      ].join('\n');
      const formatted = applyTemplatePdfMarkdownFormatting(markdown, '');
      const conversion = childProcess.spawnSync(
        'pandoc',
        [
          '-f',
          'markdown+raw_tex',
          '--pdf-engine=xelatex',
          '-Vgeometry=margin=1in',
          '-o',
          outputPath,
        ],
        { input: formatted, encoding: 'utf8' },
      );
      assert.equal(conversion.status, 0, conversion.stderr);

      const pageLookup = childProcess.execFileSync(
        'python3',
        [
          '-c',
          [
            'import fitz, json, sys',
            'doc = fitz.open(sys.argv[1])',
            'pages = [page.get_text() for page in doc]',
            'heading = next(i for i, text in enumerate(pages) if "9. No Warranties or Representations." in text)',
            'body = next(i for i, text in enumerate(pages) if "The warranty paragraph follows" in text)',
            'print(json.dumps({"heading": heading, "body": body, "pages": len(pages)}))',
          ].join('; '),
          outputPath,
        ],
        { encoding: 'utf8' },
      );
      const pageResult = JSON.parse(pageLookup);
      assert.equal(pageResult.heading, pageResult.body);
      assert.ok(pageResult.pages >= 2);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  },
);

test('PDF format overrides render exact user alignment, font size, and spacing requests', () => {
  const markdown = [
    '# CONFIDENTIALITY AGREEMENT',
    '',
    'Body text remains unchanged.',
  ].join('\n');

  const formatted = applyPdfFormatOverrides(markdown, [
    {
      targetText: 'CONFIDENTIALITY AGREEMENT',
      alignment: 'center',
      fontSizePt: 18,
      bold: true,
      spaceBeforePt: 12,
      spaceAfterPt: 6,
      pageBreakBefore: null,
    },
  ]);

  assert.match(formatted, /\\vspace\*\{12pt\}/);
  assert.match(formatted, /\\begin\{center\}/);
  assert.match(formatted, /\\fontsize\{18pt\}\{21\.6pt\}\\selectfont \\bfseries CONFIDENTIALITY AGREEMENT/);
  assert.match(formatted, /\\vspace\*\{6pt\}/);
  assert.match(formatted, /Body text remains unchanged\./);
});
