'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { preservesFormatOnlySubstance, runRevision } = require('../src/alignCore');

function writeFixture(dir, name, contents) {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, contents, 'utf8');
  return filePath;
}

test('runRevision applies a user change and verifies the revised draft against the source', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'revision-agent-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const sourcePath = writeFixture(
    tempDir,
    'source.md',
    '# Source NDA\n\nSourceCo may disclose information only for Project Atlas.\n',
  );
  const templatePath = writeFixture(
    tempDir,
    'template.md',
    '# CONFIDENTIALITY AGREEMENT\n\n## ARTICLE I\n\nTemplateCo provides services.\n',
  );
  const outputPath = path.join(tempDir, 'revised.md');
  const currentDocument = [
    '# CONFIDENTIALITY AGREEMENT',
    '',
    '## ARTICLE I',
    '',
    'SourceCo may disclose information only for Project Atlas.',
  ].join('\n');
  const calls = [];
  const fakeClient = {
    models: {
      list: async () => ({ data: [{ id: 'gpt-5.4' }] }),
    },
    responses: {
      create: async (payload) => {
        calls.push(payload);
        if (/source-grounded document revision agent/.test(payload.input[0].content)) {
          return {
            id: 'revision-response',
            output_text: JSON.stringify({
              document: [
                '# CONFIDENTIALITY AGREEMENT',
                '',
                '## **ARTICLE I**',
                '',
                'SourceCo may disclose information only for Project Atlas.',
              ].join('\n'),
              summary: 'Made ARTICLE I a stronger heading.',
              change_type: 'format',
              applied: true,
              warnings: [],
              format_operations: [
                {
                  target_text: 'ARTICLE I',
                  alignment: 'unchanged',
                  font_size_pt: 14,
                  bold: true,
                  space_before_pt: 12,
                  space_after_pt: null,
                  page_break_before: null,
                },
              ],
            }),
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          };
        }

        return {
          id: 'verification-response',
          output_text: [
            '# CONFIDENTIALITY AGREEMENT',
            '',
            '## **ARTICLE I**',
            '',
            'SourceCo may disclose information only for Project Atlas.',
          ].join('\n'),
          usage: { input_tokens: 12, output_tokens: 6, total_tokens: 18 },
        };
      },
    },
  };

  const result = await runRevision({
    source: sourcePath,
    template: templatePath,
    currentDocument,
    instruction: 'Make ARTICLE I a stronger heading. Do not change the body.',
    output: outputPath,
    format: 'markdown',
    client: fakeClient,
    visualCheck: 'false',
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].text.format.name, 'document_revision');
  assert.match(JSON.stringify(calls[0].input), /BEGIN CURRENT DRAFT/);
  assert.match(JSON.stringify(calls[0].input), /smallest document region/);
  assert.match(JSON.stringify(calls[1].input), /Authorized user revision request/);
  assert.match(JSON.stringify(calls[1].input), /does not authorize legal substance/);
  assert.equal(result.applied, true);
  assert.equal(result.changeType, 'format');
  assert.equal(result.summary, 'Made ARTICLE I a stronger heading.');
  assert.equal(result.formatOperations[0].fontSizePt, 14);
  assert.equal(result.usage.total_tokens, 33);
  assert.match(fs.readFileSync(outputPath, 'utf8'), /Project Atlas/);
  assert.doesNotMatch(fs.readFileSync(outputPath, 'utf8'), /TemplateCo provides services/);
});

test('runRevision preserves the current draft and skips verification when a request is unsupported', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'revision-agent-reject-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const sourcePath = writeFixture(tempDir, 'source.md', '# NDA\n\nProject Atlas only.\n');
  const templatePath = writeFixture(tempDir, 'template.md', '# AGREEMENT\n\nTemplate text.\n');
  const currentDocument = '# NDA\n\nProject Atlas only.';
  let callCount = 0;
  const fakeClient = {
    models: {
      list: async () => ({ data: [{ id: 'gpt-5.4' }] }),
    },
    responses: {
      create: async () => {
        callCount += 1;
        return {
          id: 'revision-rejected',
          output_text: JSON.stringify({
            document: currentDocument,
            summary: 'The requested California governing-law clause is not supported by the source.',
            change_type: 'none',
            applied: false,
            warnings: ['No governing law appears in the source document.'],
            format_operations: [],
          }),
          usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
        };
      },
    },
  };

  const result = await runRevision({
    source: sourcePath,
    template: templatePath,
    currentDocument,
    instruction: 'Add California governing law.',
    output: path.join(tempDir, 'should-not-exist.md'),
    format: 'markdown',
    client: fakeClient,
    visualCheck: 'false',
  });

  assert.equal(callCount, 1);
  assert.equal(result.applied, false);
  assert.equal(result.finalDocument, currentDocument);
  assert.equal(result.outputPath, null);
  assert.equal(fs.existsSync(path.join(tempDir, 'should-not-exist.md')), false);
});

test('format-only substance lock ignores Markdown markers but catches wording changes', () => {
  const current = '# CONFIDENTIALITY AGREEMENT\n\nBody wording stays exactly the same.';
  const restyled = '| **CONFIDENTIALITY AGREEMENT** |\n|:---:|\n\nBody wording stays exactly the same.';
  const rewritten = '| **CONFIDENTIALITY AGREEMENT** |\n|:---:|\n\nBody wording was changed.';

  assert.equal(preservesFormatOnlySubstance(restyled, current), true);
  assert.equal(preservesFormatOnlySubstance(rewritten, current), false);
});
