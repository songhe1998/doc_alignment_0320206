'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const AdmZip = require('adm-zip');

const {
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
    assert.match(outline, /\[HEADING blank-line-before font=12pt bold style="Heading 1" space-before=240 space-after=120\] （秘密情報の定義・開示等の方法）/);
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
    assert.match(outputXml, /<w:p\/><w:p><w:pPr><w:spacing w:before="240" w:after="120"\/><w:pStyle w:val="Heading1"\/>/);
    assert.match(outputXml, /<w:sz w:val="24"\/>/);
    assert.equal((outputXml.match(/<w:pStyle w:val="Heading1"\/>/g) || []).length, 1);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
