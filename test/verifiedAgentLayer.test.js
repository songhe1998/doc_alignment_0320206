'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { runAlignment, sanitizeGeneratedDocumentStructure } = require('../src/alignCore');
const {
  buildVerifiedAlignmentBrief,
  buildVerifiedAlignmentInstructions,
} = require('../src/alignmentPrompt');

function writeFixture(dir, name, contents) {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, contents, 'utf8');
  return filePath;
}

test('runAlignment sends generated output through the verified agent layer', async (t) => {
  const previousApiKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-align-test-'));
  t.after(() => {
    if (previousApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousApiKey;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const sourcePath = writeFixture(
    tempDir,
    'source.md',
    [
      '# Source NDA',
      '',
      'SourceCo and RecipientCo may exchange confidential information only to evaluate Project Atlas.',
      'New York law governs.',
    ].join('\n'),
  );
  const templatePath = writeFixture(
    tempDir,
    'template.md',
    [
      '# MASTER SERVICES AGREEMENT',
      '',
      'ARTICLE I',
      'SERVICES',
      '',
      '1.1 Provider shall deliver implementation services for TemplateCo.',
      '',
      'ARTICLE II',
      'GOVERNING LAW',
    ].join('\n'),
  );
  const outputPath = path.join(tempDir, 'aligned.md');
  const calls = [];
  const fakeClient = {
    models: {
      list: async () => ({ data: [{ id: 'gpt-5.4' }] }),
    },
    responses: {
      create: async (payload) => {
        calls.push(payload);

        if (calls.length === 1) {
          return {
            id: 'generation-response',
            output_text: [
              '# MASTER SERVICES AGREEMENT',
              '',
              'ARTICLE I',
              'SERVICES',
              '',
              '1.1 Provider shall deliver implementation services for TemplateCo.',
            ].join('\n'),
            usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
          };
        }

        return {
          id: 'verified-response',
          output_text: [
            '# MASTER SERVICES AGREEMENT',
            '',
            'ARTICLE I',
            'CONFIDENTIAL INFORMATION',
            '',
            '1.1 SourceCo and RecipientCo may exchange confidential information only to evaluate Project Atlas.',
            '',
            'ARTICLE II',
            'GOVERNING LAW',
            '',
            '2.1 New York law governs.',
          ].join('\n'),
          usage: { input_tokens: 13, output_tokens: 9, total_tokens: 22 },
        };
      },
    },
  };

  const logs = [];
  const result = await runAlignment({
    source: sourcePath,
    template: templatePath,
    output: outputPath,
    format: 'markdown',
    client: fakeClient,
    logger: {
      info: (message) => logs.push({ level: 'info', message }),
      warn: (message) => logs.push({ level: 'warn', message }),
    },
  });

  assert.equal(calls.length, 2);
  assert.match(calls[0].input[0].content, /legal document alignment engine/);
  assert.match(calls[1].input[0].content, /verified legal alignment agent/);
  assert.match(calls[1].input[0].content, /Format Fidelity Verification/);
  assert.match(calls[1].input[0].content, /Source Grounding Verification/);
  assert.match(JSON.stringify(calls[1].input), /BEGIN CANDIDATE DRAFT/);
  assert.match(JSON.stringify(calls[1].input), /BEGIN SOURCE DOCUMENT/);
  assert.match(JSON.stringify(calls[1].input), /BEGIN TARGET TEMPLATE/);

  const savedOutput = fs.readFileSync(outputPath, 'utf8');
  assert.match(savedOutput, /Project Atlas/);
  assert.doesNotMatch(savedOutput, /TemplateCo/);
  assert.equal(result.responseId, 'generation-response');
  assert.equal(result.verificationResponseId, 'verified-response');
  assert.equal(result.usage.input_tokens, 24);
  assert.equal(result.usage.output_tokens, 16);
  assert.equal(result.usage.total_tokens, 40);
  assert.deepEqual(result.usage.generation, { input_tokens: 11, output_tokens: 7, total_tokens: 18 });
  assert.deepEqual(result.usage.verified_agent, { input_tokens: 13, output_tokens: 9, total_tokens: 22 });
  assert.ok(logs.some((entry) => /verified post-generation agent/.test(entry.message)));
});

test('verified alignment prompt separates target format from source substance', () => {
  const instructions = buildVerifiedAlignmentInstructions('markdown', {
    templateLanguage: 'japanese',
  });
  const brief = buildVerifiedAlignmentBrief({
    sourcePath: 'source.docx',
    templatePath: 'template.docx',
    outputFormat: 'docx',
    modelOutputFormat: 'markdown',
    languageProfile: { templateLanguage: 'japanese' },
  });

  assert.match(instructions, /verified legal alignment agent/);
  assert.match(instructions, /Format Fidelity Verification/);
  assert.match(instructions, /Source Grounding Verification/);
  assert.match(instructions, /FORMAT-AWARE TEMPLATE OUTLINE/);
  assert.match(instructions, /final document must look and organize itself like the Target Template/);
  assert.match(instructions, /must not contain substantive content from the Target Template/);
  assert.match(instructions, /Do not flatten template titles or headings into ordinary paragraphs/);
  assert.match(instructions, /delete template-only signature ceremony text/);
  assert.match(instructions, /Return only Markdown/);
  assert.match(instructions, /Japanese legal drafting conventions/);
  assert.match(brief, /format-consistent with the target template/);
  assert.match(brief, /only authoritative source of legal substance/);
  assert.match(brief, /title, heading, line-feed, alignment, font-size, bold, and spacing cues/);
  assert.match(brief, /structure, ordering, heading style, numbering, signature layout, and presentation only/);
});

test('sanitizeGeneratedDocumentStructure separates accidental title/article collisions only on title line', () => {
  const document = [
    '# **第1条　秘密保持契約書**',
    '',
    '前文です。',
    '',
    '## 第1条（目的）',
    '',
    '本文です。',
  ].join('\n');

  const sanitized = sanitizeGeneratedDocumentStructure(document);

  assert.equal(
    sanitized,
    [
      '# **秘密保持契約書**',
      '',
      '前文です。',
      '',
      '## 第1条（目的）',
      '',
      '本文です。',
    ].join('\n'),
  );
});

test('sanitizeGeneratedDocumentStructure leaves real first article headings alone', () => {
  const document = [
    '第1条（目的）',
    '',
    '本文です。',
  ].join('\n');

  assert.equal(sanitizeGeneratedDocumentStructure(document), document);
});
