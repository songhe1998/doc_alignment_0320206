'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const AdmZip = require('adm-zip');

const {
  applyDocxFormatOverrides,
  applyTemplateDocxFormatting,
  buildDocxFormatOutline,
} = require('../src/docxFormatting');

const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

function writeDocx(filePath, documentXml, stylesXml = '') {
  const zip = new AdmZip();
  zip.addFile('word/document.xml', Buffer.from(documentXml, 'utf8'));
  if (stylesXml) {
    zip.addFile('word/styles.xml', Buffer.from(stylesXml, 'utf8'));
  }
  zip.writeZip(filePath);
}

function readDocumentXml(filePath) {
  const zip = new AdmZip(filePath);
  return zip.getEntry('word/document.xml').getData().toString('utf8');
}

function readStylesXml(filePath) {
  const zip = new AdmZip(filePath);
  return zip.getEntry('word/styles.xml')?.getData().toString('utf8') || '';
}

function makeDocumentXml(paragraphs) {
  return [
    `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${WORD_NS}"><w:body>`,
    ...paragraphs,
    '</w:body></w:document>',
  ].join('');
}

test('buildDocxFormatOutline exposes title, heading, line-feed, font, and alignment cues', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-format-outline-'));
  const templatePath = path.join(tempDir, 'template.docx');

  try {
    writeDocx(
      templatePath,
      makeDocumentXml([
        '<w:p><w:pPr><w:jc w:val="center"/><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="32"/></w:rPr><w:t>秘密保持契約書</w:t></w:r></w:p>',
        '<w:p/>',
        '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>（秘密情報の定義・開示等の方法）</w:t></w:r></w:p>',
        '<w:p><w:r><w:t>本文です。</w:t></w:r></w:p>',
      ]),
      `<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="${WORD_NS}"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="Heading 1"/><w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style></w:styles>`,
    );

    const outline = buildDocxFormatOutline(templatePath);

    assert.match(outline, /\[TITLE align=center font=16pt bold\] 秘密保持契約書/);
    assert.match(outline, /\[BLANK LINE\]/);
    assert.match(outline, /\[HEADING blank-line-before font=12pt bold style="Heading 1" level=1 space-before=240 space-after=120\] （秘密情報の定義・開示等の方法）/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('applyDocxFormatOverrides applies exact user title formatting after template styling', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-user-format-override-'));
  const outputPath = path.join(tempDir, 'output.docx');

  try {
    writeDocx(
      outputPath,
      makeDocumentXml([
        '<w:p><w:r><w:t>秘密保持契約書</w:t></w:r></w:p>',
        '<w:p><w:r><w:t>本文です。</w:t></w:r></w:p>',
      ]),
    );

    const count = applyDocxFormatOverrides(outputPath, [
      {
        targetText: '秘密保持契約書',
        alignment: 'center',
        fontSizePt: 18,
        bold: true,
        spaceBeforePt: 12,
        spaceAfterPt: 6,
        pageBreakBefore: null,
      },
    ]);

    const outputXml = readDocumentXml(outputPath);
    assert.equal(count, 1);
    assert.match(outputXml, /<w:jc w:val="center"\/>/);
    assert.match(outputXml, /<w:spacing w:before="240" w:after="120"\/>/);
    assert.match(outputXml, /<w:b\/>/);
    assert.match(outputXml, /<w:sz w:val="36"\/>/);
    assert.doesNotMatch(outputXml, /本文です。<\/w:t><\/w:r><w:pPr>/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('applyTemplateDocxFormatting copies title and heading visual cues into generated docx', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-format-apply-'));
  const templatePath = path.join(tempDir, 'template.docx');
  const outputPath = path.join(tempDir, 'output.docx');

  try {
    writeDocx(
      templatePath,
      makeDocumentXml([
        '<w:p><w:pPr><w:jc w:val="center"/><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="32"/></w:rPr><w:t>秘密保持契約書</w:t></w:r></w:p>',
        '<w:p/>',
        '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>（秘密情報の定義・開示等の方法）</w:t></w:r></w:p>',
      ]),
      `<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="${WORD_NS}"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="Heading 1"/><w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style></w:styles>`,
    );
    writeDocx(
      outputPath,
      makeDocumentXml([
        '<w:p><w:r><w:t>秘密保持契約書</w:t></w:r></w:p>',
        '<w:p><w:r><w:t>（秘密情報の定義・開示等の方法）</w:t></w:r></w:p>',
        '<w:p><w:r><w:t>第１条 本文です。</w:t></w:r></w:p>',
        '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>（住所）</w:t></w:r></w:p>',
      ]),
    );

    assert.equal(applyTemplateDocxFormatting(outputPath, templatePath), true);

    const outputXml = readDocumentXml(outputPath);
    assert.match(outputXml, /<w:jc w:val="center"\/>/);
    assert.match(outputXml, /<w:sz w:val="32"\/>/);
    assert.match(outputXml, /<w:p\/><w:p><w:pPr><w:keepNext\/><w:keepLines\/>/);
    assert.match(outputXml, /<w:spacing w:before="240" w:after="120"\/>/);
    assert.match(outputXml, /<w:pStyle w:val="Heading1"\/>/);
    assert.match(outputXml, /<w:sz w:val="24"\/>/);
    assert.equal((outputXml.match(/<w:pStyle w:val="Heading1"\/>/g) || []).length, 1);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('applyTemplateDocxFormatting derives an idempotent semantic heading style without numbering', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-format-numbered-heading-'));
  const templatePath = path.join(tempDir, 'template.docx');
  const outputPath = path.join(tempDir, 'output.docx');

  try {
    writeDocx(
      templatePath,
      makeDocumentXml([
        '<w:p><w:pPr><w:jc w:val="center"/><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="32"/></w:rPr><w:t>秘密保持契約書</w:t></w:r></w:p>',
        '<w:p/>',
        '<w:p><w:pPr><w:pStyle w:val="NumberedHeading"/></w:pPr><w:r><w:t>（秘密情報の定義・開示等の方法）</w:t></w:r></w:p>',
      ]),
      [
        `<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="${WORD_NS}">`,
        '<w:style w:type="paragraph" w:styleId="NumberedHeading">',
        '<w:name w:val="Numbered Heading"/>',
        '<w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr><w:spacing w:before="240" w:after="120"/></w:pPr>',
        '<w:rPr><w:b/><w:sz w:val="24"/></w:rPr>',
        '</w:style>',
        '</w:styles>',
      ].join(''),
    );
    writeDocx(
      outputPath,
      makeDocumentXml([
        '<w:p><w:pPr><w:pStyle w:val="NumberedHeading"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>秘密保持契約書</w:t></w:r></w:p>',
        '<w:p><w:pPr><w:pStyle w:val="NumberedHeading"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>（目的）</w:t></w:r></w:p>',
        '<w:p><w:r><w:t>第１条 本文です。</w:t></w:r></w:p>',
      ]),
    );

    assert.equal(applyTemplateDocxFormatting(outputPath, templatePath), true);
    assert.equal(applyTemplateDocxFormatting(outputPath, templatePath), true);

    const outputXml = readDocumentXml(outputPath);
    const stylesXml = readStylesXml(outputPath);
    assert.doesNotMatch(outputXml, /<w:pStyle w:val="NumberedHeading"\/>/);
    assert.doesNotMatch(outputXml, /<w:numPr>/);
    assert.match(outputXml, /<w:pStyle w:val="DocAlignHeading1NumberedHeading"\/>/);
    assert.match(outputXml, /<w:keepNext\/><w:keepLines\/>/);
    assert.match(outputXml, /<w:spacing w:before="240" w:after="120"\/>/);
    assert.match(outputXml, /<w:sz w:val="24"\/>/);
    assert.match(outputXml, /<w:jc w:val="center"\/>/);
    assert.equal((stylesXml.match(/w:styleId="DocAlignHeading1NumberedHeading"/g) || []).length, 1);
    assert.match(stylesXml, /w:styleId="DocAlignHeading1NumberedHeading"[\s\S]*?<w:outlineLvl w:val="0"\/>/);
    assert.doesNotMatch(stylesXml, /<w:numPr>/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('applyTemplateDocxFormatting preserves relative heading hierarchy across shifted levels', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-format-heading-hierarchy-'));
  const templatePath = path.join(tempDir, 'template.docx');
  const outputPath = path.join(tempDir, 'output.docx');
  const stylesXml = [
    `<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="${WORD_NS}">`,
    '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="Heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>',
    '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="Heading 2"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>',
    '<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="Heading 3"/><w:pPr><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="22"/></w:rPr></w:style>',
    '</w:styles>',
  ].join('');

  try {
    writeDocx(
      templatePath,
      makeDocumentXml([
        '<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>契約書</w:t></w:r></w:p>',
        '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>第１条 目的</w:t></w:r></w:p>',
        '<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>詳細</w:t></w:r></w:p>',
      ]),
      stylesXml,
    );
    writeDocx(
      outputPath,
      makeDocumentXml([
        '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>秘密保持契約書</w:t></w:r></w:p>',
        '<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>第１条 秘密保持</w:t></w:r></w:p>',
        '<w:p><w:pPr><w:pStyle w:val="Heading3"/></w:pPr><w:r><w:t>例外</w:t></w:r></w:p>',
      ]),
      stylesXml,
    );

    assert.equal(applyTemplateDocxFormatting(outputPath, templatePath), true);
    const outputXml = readDocumentXml(outputPath);
    assert.equal((outputXml.match(/<w:pStyle w:val="Heading1"\/>/g) || []).length, 1);
    assert.equal((outputXml.match(/<w:pStyle w:val="Heading2"\/>/g) || []).length, 1);
    assert.doesNotMatch(outputXml, /<w:pStyle w:val="Heading3"\/>/);
    assert.equal((outputXml.match(/<w:keepNext\/>/g) || []).length, 2);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('a one-level template keeps deeper output headings semantically distinct', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-format-single-heading-level-'));
  const templatePath = path.join(tempDir, 'template.docx');
  const outputPath = path.join(tempDir, 'output.docx');
  const stylesXml = [
    `<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="${WORD_NS}">`,
    '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="Heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>',
    '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="Heading 2"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style>',
    '<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="Heading 3"/><w:pPr><w:outlineLvl w:val="2"/></w:pPr></w:style>',
    '</w:styles>',
  ].join('');

  try {
    writeDocx(
      templatePath,
      makeDocumentXml([
        '<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>契約書</w:t></w:r></w:p>',
        '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>（目的）</w:t></w:r></w:p>',
      ]),
      stylesXml,
    );
    writeDocx(
      outputPath,
      makeDocumentXml([
        '<w:p><w:r><w:t>秘密保持契約書</w:t></w:r></w:p>',
        '<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>（定義）</w:t></w:r></w:p>',
        '<w:p><w:pPr><w:pStyle w:val="Heading3"/></w:pPr><w:r><w:t>適用除外</w:t></w:r></w:p>',
      ]),
      stylesXml,
    );

    assert.equal(applyTemplateDocxFormatting(outputPath, templatePath), true);
    const outputXml = readDocumentXml(outputPath);
    const outputStylesXml = readStylesXml(outputPath);
    assert.match(outputXml, /<w:pStyle w:val="Heading1"\/>/);
    assert.match(outputXml, /<w:pStyle w:val="DocAlignHeading2Heading1"\/>/);
    assert.match(outputStylesXml, /w:styleId="DocAlignHeading2Heading1"[\s\S]*?<w:outlineLvl w:val="1"\/>/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('template heading formatting removes generated direct bold when the target is regular', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-format-regular-heading-'));
  const templatePath = path.join(tempDir, 'template.docx');
  const outputPath = path.join(tempDir, 'output.docx');
  const stylesXml = [
    `<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="${WORD_NS}">`,
    '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="Heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style>',
    '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="Heading 2"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style>',
    '</w:styles>',
  ].join('');

  try {
    writeDocx(
      templatePath,
      makeDocumentXml([
        '<w:p><w:r><w:t>AGREEMENT</w:t></w:r></w:p>',
        '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Definitions</w:t></w:r></w:p>',
      ]),
      stylesXml,
    );
    writeDocx(
      outputPath,
      makeDocumentXml([
        '<w:p><w:r><w:t>CONFIDENTIALITY AGREEMENT</w:t></w:r></w:p>',
        '<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:rPr><w:b/><w:bCs/></w:rPr><w:t>Confidential Information</w:t></w:r></w:p>',
      ]),
      stylesXml,
    );

    assert.equal(applyTemplateDocxFormatting(outputPath, templatePath), true);
    const outputXml = readDocumentXml(outputPath);
    assert.doesNotMatch(outputXml, /<w:b\/>|<w:bCs\/>/);
    assert.match(outputXml, /<w:pStyle w:val="Heading1"\/>/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
