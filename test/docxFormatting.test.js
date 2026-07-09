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

function writeDocx(filePath, documentXml, stylesXml = '', numberingXml = '') {
  const zip = new AdmZip();
  zip.addFile('word/document.xml', Buffer.from(documentXml, 'utf8'));
  if (stylesXml) {
    zip.addFile('word/styles.xml', Buffer.from(stylesXml, 'utf8'));
  }
  if (numberingXml) {
    zip.addFile('word/numbering.xml', Buffer.from(numberingXml, 'utf8'));
  }
  zip.writeZip(filePath);
}

function readDocumentXml(filePath) {
  const zip = new AdmZip(filePath);
  return zip.getEntry('word/document.xml').getData().toString('utf8');
}

function readNumberingXml(filePath) {
  const zip = new AdmZip(filePath);
  const entry = zip.getEntry('word/numbering.xml');
  return entry ? entry.getData().toString('utf8') : '';
}

function makeNumberingXml(entries) {
  return [
    `<?xml version="1.0" encoding="UTF-8"?><w:numbering xmlns:w="${WORD_NS}">`,
    ...entries,
    '</w:numbering>',
  ].join('');
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

// pandoc's --reference-doc copies the reference document's styles.xml verbatim but
// regenerates word/numbering.xml from scratch (mirrored here by giving the output docx
// its own unrelated numId=1000/abstractNumId=990, matching what a real pandoc run
// produces), so a template numId only renders if the required abstractNum/num
// definitions are also merged into the output's own numbering.xml.
const PANDOC_OWN_NUMBERING_XML = makeNumberingXml([
  '<w:abstractNum w:abstractNumId="990"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum>',
  '<w:num w:numId="1000"><w:abstractNumId w:val="990"/></w:num>',
]);

test('applyTemplateDocxFormatting copies a style-linked numbered heading style so Word renders "第N条" numbering', () => {
  // Regression test for the template's Heading1-equivalent carrying its numbering via
  // the style definition itself (numId -> lvlText="第%1条"), as in a real Japanese legal
  // contract template. Stripping w:pStyle here removes the paragraph's only source of
  // its rendered article number, so it must be copied onto every matched heading, and the
  // numbering.xml definition it depends on must be merged into the output docx.
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
      makeNumberingXml([
        '<w:abstractNum w:abstractNumId="3"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="第%1条"/></w:lvl></w:abstractNum>',
        '<w:num w:numId="1"><w:abstractNumId w:val="3"/></w:num>',
      ]),
    );
    writeDocx(
      outputPath,
      makeDocumentXml([
        // pandoc's fresh conversion assigns its own generic heading style/numPr, which
        // does not match the template's numbered style and must be replaced, not just stripped.
        '<w:p><w:r><w:t>秘密保持契約書</w:t></w:r></w:p>',
        '<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>（目的）</w:t></w:r></w:p>',
        '<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>（定義）</w:t></w:r></w:p>',
        '<w:p><w:r><w:t>第１条 本文です。</w:t></w:r></w:p>',
      ]),
      '',
      PANDOC_OWN_NUMBERING_XML,
    );

    assert.equal(applyTemplateDocxFormatting(outputPath, templatePath), true);

    const outputXml = readDocumentXml(outputPath);
    // Every matched heading gets the template's numbered style so Word's own numbering
    // engine renders 第1条, 第2条, ... sequentially.
    assert.equal((outputXml.match(/<w:pStyle w:val="NumberedHeading"\/>/g) || []).length, 2);
    // Numbering must come from the style, not a duplicated/mismatched paragraph-level override.
    assert.doesNotMatch(outputXml, /<w:numPr>/);
    assert.match(outputXml, /<w:spacing w:before="240" w:after="120"\/>/);
    assert.match(outputXml, /<w:sz w:val="24"\/>/);
    assert.match(outputXml, /<w:jc w:val="center"\/>/);

    const numberingXml = readNumberingXml(outputPath);
    // The template's numId=1 -> "第%1条" definition must now exist in the output so
    // Heading1's numPr actually resolves instead of pointing at nothing.
    assert.match(numberingXml, /<w:num w:numId="1"><w:abstractNumId w:val="3"\/><\/w:num>/);
    assert.match(numberingXml, /<w:lvlText w:val="第%1条"\/>/);
    // pandoc's own generated numbering definition must survive the merge untouched.
    assert.match(numberingXml, /<w:num w:numId="1000"><w:abstractNumId w:val="990"\/><\/w:num>/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('applyTemplateDocxFormatting copies paragraph-level numbering when the heading style itself has none', () => {
  // Some templates apply numbering directly to each heading paragraph instead of linking
  // it through the style. In that case the literal numId/ilvl must be copied verbatim, and
  // the corresponding numbering.xml definition merged in the same way.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-format-paragraph-numbering-'));
  const templatePath = path.join(tempDir, 'template.docx');
  const outputPath = path.join(tempDir, 'output.docx');

  try {
    writeDocx(
      templatePath,
      makeDocumentXml([
        '<w:p><w:pPr><w:jc w:val="center"/><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="32"/></w:rPr><w:t>秘密保持契約書</w:t></w:r></w:p>',
        '<w:p/>',
        '<w:p><w:pPr><w:pStyle w:val="Heading1"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="5"/></w:numPr></w:pPr><w:r><w:t>（目的）</w:t></w:r></w:p>',
      ]),
      `<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="${WORD_NS}"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="Heading 1"/><w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style></w:styles>`,
      makeNumberingXml([
        '<w:abstractNum w:abstractNumId="7"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="第%1条"/></w:lvl></w:abstractNum>',
        '<w:num w:numId="5"><w:abstractNumId w:val="7"/></w:num>',
      ]),
    );
    writeDocx(
      outputPath,
      makeDocumentXml([
        '<w:p><w:r><w:t>秘密保持契約書</w:t></w:r></w:p>',
        '<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>（目的）</w:t></w:r></w:p>',
      ]),
      '',
      PANDOC_OWN_NUMBERING_XML,
    );

    assert.equal(applyTemplateDocxFormatting(outputPath, templatePath), true);

    const outputXml = readDocumentXml(outputPath);
    assert.match(outputXml, /<w:pStyle w:val="Heading1"\/>/);
    assert.match(outputXml, /<w:numPr><w:ilvl w:val="0"\/><w:numId w:val="5"\/><\/w:numPr>/);

    const numberingXml = readNumberingXml(outputPath);
    assert.match(numberingXml, /<w:num w:numId="5"><w:abstractNumId w:val="7"\/><\/w:num>/);
    assert.match(numberingXml, /<w:num w:numId="1000"><w:abstractNumId w:val="990"\/><\/w:num>/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('applyTemplateDocxFormatting remaps a template numId that collides with an id pandoc already used', () => {
  // If the output docx's own (pandoc-generated) numbering.xml happens to reuse the same
  // numId/abstractNumId as the template, blindly reusing it would corrupt pandoc's own
  // list. The merge must move the template's definition to a fresh id and repoint the
  // copied style at it.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-format-numbering-collision-'));
  const templatePath = path.join(tempDir, 'template.docx');
  const outputPath = path.join(tempDir, 'output.docx');

  const stylesXmlFixture = [
    `<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="${WORD_NS}">`,
    '<w:style w:type="paragraph" w:styleId="NumberedHeading">',
    '<w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>',
    '</w:style>',
    '</w:styles>',
  ].join('');

  try {
    writeDocx(
      templatePath,
      makeDocumentXml([
        '<w:p><w:pPr><w:jc w:val="center"/><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="32"/></w:rPr><w:t>秘密保持契約書</w:t></w:r></w:p>',
        '<w:p/>',
        '<w:p><w:pPr><w:pStyle w:val="NumberedHeading"/></w:pPr><w:r><w:t>（目的）</w:t></w:r></w:p>',
      ]),
      stylesXmlFixture,
      makeNumberingXml([
        '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:lvlText w:val="第%1条"/></w:lvl></w:abstractNum>',
        '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>',
      ]),
    );
    writeDocx(
      outputPath,
      makeDocumentXml([
        '<w:p><w:r><w:t>秘密保持契約書</w:t></w:r></w:p>',
        '<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>（目的）</w:t></w:r></w:p>',
      ]),
      // pandoc's --reference-doc copies the reference document's styles.xml verbatim,
      // so the output already carries the same (unmodified) NumberedHeading definition.
      stylesXmlFixture,
      // pandoc's own generated numbering happens to already use numId=1/abstractNumId=0.
      makeNumberingXml([
        '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum>',
        '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>',
      ]),
    );

    assert.equal(applyTemplateDocxFormatting(outputPath, templatePath), true);

    const zip = new AdmZip(outputPath);
    const stylesXml = zip.getEntry('word/styles.xml').getData().toString('utf8');
    const numberingXml = zip.getEntry('word/numbering.xml').getData().toString('utf8');

    // pandoc's own numId=1/abstractNumId=0 must be untouched.
    assert.match(numberingXml, /<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"\/><w:lvlText w:val="%1\."\/><\/w:lvl><\/w:abstractNum>/);
    assert.match(numberingXml, /<w:num w:numId="1"><w:abstractNumId w:val="0"\/><\/w:num>/);
    // The template's colliding definitions must have been remapped to fresh ids...
    assert.match(numberingXml, /<w:lvlText w:val="第%1条"\/>/);
    const remappedNum = numberingXml.match(/<w:num w:numId="(\d+)"><w:abstractNumId w:val="(\d+)"\/><\/w:num>/g);
    assert.equal(remappedNum.length, 2);
    // ...and the copied NumberedHeading style in styles.xml must reference that new numId,
    // not the original "1" (which now means something else in this document).
    assert.doesNotMatch(stylesXml, /<w:numId w:val="1"\/>/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
