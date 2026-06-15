'use strict';

const assert = require('node:assert/strict');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { runAlignment } = require('../src/alignCore');
const {
  buildVisualCheckUserContent,
  normalizeVisualCheckReport,
  parseVisualCheckJson,
  renderDocumentPreviewImages,
  resolveInstalledFont,
  runVisualCheck,
} = require('../src/visualChecker');

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
);

function hasCommand(command) {
  const result = childProcess.spawnSync('sh', ['-lc', `command -v ${command}`], { stdio: 'ignore' });
  return result.status === 0;
}

function hasPyMuPdf() {
  const result = childProcess.spawnSync('python3', ['-c', 'import fitz'], { stdio: 'ignore' });
  return result.status === 0;
}

function writeFixture(dir, name, contents) {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, contents, 'utf8');
  return filePath;
}

test('runVisualCheck sends template and output images through structured VLM JSON schema', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-check-unit-'));
  const templateImage = path.join(tempDir, 'template.png');
  const outputImage = path.join(tempDir, 'output.png');
  fs.writeFileSync(templateImage, ONE_PIXEL_PNG);
  fs.writeFileSync(outputImage, ONE_PIXEL_PNG);

  try {
    const calls = [];
    const fakeClient = {
      responses: {
        create: async (payload) => {
          calls.push(payload);
          return {
            id: 'visual-response',
            output_text: JSON.stringify({
              pass: false,
              summary: 'Output title is not centered.',
              issues: [
                {
                  type: 'title_alignment',
                  severity: 'high',
                  page: 1,
                  message: 'Main title is left aligned while the target title is centered.',
                },
              ],
              repair_instructions: ['Center the first title line.'],
            }),
            usage: { input_tokens: 17, output_tokens: 5, total_tokens: 22 },
          };
        },
      },
    };

    const report = await runVisualCheck({
      client: fakeClient,
      model: 'vision-test-model',
      templateImages: [templateImage],
      outputImages: [outputImage],
      outputFormat: 'pdf',
    });

    assert.equal(report.pass, false);
    assert.equal(report.issues[0].type, 'title_alignment');
    assert.equal(report.responseId, 'visual-response');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].model, 'vision-test-model');
    assert.equal(calls[0].text.format.type, 'json_schema');
    assert.equal(calls[0].text.format.name, 'visual_check_report');
    const imageParts = calls[0].input[1].content.filter((part) => part.type === 'input_image');
    assert.equal(imageParts.length, 2);
    assert.match(imageParts[0].image_url, /^data:image\/png;base64,/);
    assert.equal(imageParts[0].detail, 'high');
    assert.match(JSON.stringify(calls[0].input), /Judge only visual format fidelity/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('parseVisualCheckJson accepts fenced JSON and normalizer treats medium issues as blocking', () => {
  const parsed = parseVisualCheckJson([
    '```json',
    '{"pass":true,"summary":"ok","issues":[{"type":"spacing","severity":"medium","page":1,"message":"Heading spacing is missing."}],"repair_instructions":[]}',
    '```',
  ].join('\n'));
  const normalized = normalizeVisualCheckReport(parsed);

  assert.equal(normalized.pass, false);
  assert.equal(normalized.issues[0].severity, 'medium');
});

test('buildVisualCheckUserContent can use a template visual outline instead of template screenshots', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-outline-unit-'));
  const outputImage = path.join(tempDir, 'output.png');
  fs.writeFileSync(outputImage, ONE_PIXEL_PNG);

  try {
    const content = buildVisualCheckUserContent({
      templateOutline: '[TITLE align=center font=14pt bold] 秘密保持契約書\n[HEADING blank-line-before font=12pt bold] （目的）',
      outputImages: [outputImage],
      outputFormat: 'pdf',
    });

    assert.match(content[0].text, /target template visual outline/);
    assert.match(JSON.stringify(content), /TITLE align=center/);
    assert.equal(content.filter((part) => part.type === 'input_image').length, 1);
    assert.doesNotMatch(JSON.stringify(content), /TARGET TEMPLATE PAGE/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('resolveInstalledFont does not invent a font when fontconfig has no match', () => {
  const renderLikeCatalog = [
    'Noto Serif CJK JP',
    'Noto Sans CJK JP',
    'DejaVu Sans Mono',
  ].join('\n');

  assert.equal(resolveInstalledFont(['Menlo', 'DejaVu Sans Mono'], renderLikeCatalog), 'DejaVu Sans Mono');
  assert.equal(resolveInstalledFont(['Menlo', 'Courier New', 'Osaka-Mono'], renderLikeCatalog), null);
  assert.equal(resolveInstalledFont(['Menlo'], null), 'Menlo');
});

test('renderDocumentPreviewImages uses LibreOffice instead of Pandoc for DOCX preview', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-render-docx-unit-'));
  const sourcePath = path.join(tempDir, 'aligned.docx');
  fs.writeFileSync(sourcePath, 'dummy docx bytes');
  const originalExecFileSync = childProcess.execFileSync;
  const calls = [];

  childProcess.execFileSync = (command, args = [], options = {}) => {
    calls.push({ command, args });

    if (command === 'sh' && args[1] === 'command -v soffice') {
      return Buffer.from('/usr/bin/soffice\n');
    }
    if (command === 'soffice') {
      const outputDir = args[args.indexOf('--outdir') + 1];
      fs.mkdirSync(outputDir, { recursive: true });
      fs.writeFileSync(path.join(outputDir, 'aligned.pdf'), '%PDF-1.4\n');
      return 'convert aligned.docx -> aligned.pdf';
    }
    if (command === 'python3') {
      return '[]';
    }

    return originalExecFileSync(command, args, options);
  };

  try {
    renderDocumentPreviewImages(sourcePath, { tempDir, label: 'output', maxPages: 1 });
  } finally {
    childProcess.execFileSync = originalExecFileSync;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  const officeCall = calls.find((call) => call.command === 'soffice');
  assert.ok(officeCall);
  assert.ok(officeCall.args.includes('--headless'));
  assert.ok(officeCall.args.includes('--convert-to'));
  assert.ok(officeCall.args.includes('pdf'));
  assert.equal(calls.some((call) => call.command === 'pandoc'), false);
});

test('renderDocumentPreviewImages omits missing monofont from Markdown Pandoc preview args', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-render-font-unit-'));
  const sourcePath = writeFixture(tempDir, 'aligned.md', '# 秘密保持契約書\n\n本文です。');
  const originalExecFileSync = childProcess.execFileSync;
  const calls = [];

  childProcess.execFileSync = (command, args = [], options = {}) => {
    calls.push({ command, args });

    if (command === 'sh' && args[1] === 'command -v xelatex') {
      return Buffer.from('/usr/bin/xelatex\n');
    }
    if (command === 'fc-list') {
      return 'Noto Serif CJK JP\nNoto Sans CJK JP\n';
    }
    if (command === 'pandoc') {
      return Buffer.from('');
    }
    if (command === 'python3') {
      return '[]';
    }

    return originalExecFileSync(command, args, options);
  };

  try {
    renderDocumentPreviewImages(sourcePath, { tempDir, label: 'output', maxPages: 1 });
  } finally {
    childProcess.execFileSync = originalExecFileSync;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  const pandocCall = calls.find((call) => call.command === 'pandoc');
  assert.ok(pandocCall);
  assert.ok(pandocCall.args.includes('-Vmainfont=Noto Serif CJK JP'));
  assert.ok(pandocCall.args.includes('-Vsansfont=Noto Sans CJK JP'));
  assert.ok(!pandocCall.args.some((arg) => arg === '-Vmonofont=Menlo'));
  assert.ok(!pandocCall.args.some((arg) => arg.startsWith('-Vmonofont=')));
});

test('renderDocumentPreviewImages includes Pandoc stderr when preview conversion fails', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-render-error-unit-'));
  const sourcePath = writeFixture(tempDir, 'aligned.md', '# 秘密保持契約書\n\n本文です。');
  const originalExecFileSync = childProcess.execFileSync;

  childProcess.execFileSync = (command, args = [], options = {}) => {
    if (command === 'sh' && args[1] === 'command -v xelatex') {
      return Buffer.from('/usr/bin/xelatex\n');
    }
    if (command === 'pandoc') {
      const error = new Error('Command failed: pandoc');
      error.stderr = Buffer.from('Package fontspec Error: The font "Menlo" cannot be found.');
      throw error;
    }

    return originalExecFileSync(command, args, options);
  };

  try {
    assert.throws(
      () => renderDocumentPreviewImages(sourcePath, { tempDir, label: 'output', maxPages: 1 }),
      /font "Menlo" cannot be found/,
    );
  } finally {
    childProcess.execFileSync = originalExecFileSync;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test(
  'runAlignment repairs and rechecks a rendered PDF after visual checker failure',
  { skip: !(hasCommand('pandoc') && hasPyMuPdf()) },
  async (t) => {
    const previousApiKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-check-align-'));
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
        'SourceCo and RecipientCo may exchange confidential information only for Project Atlas.',
      ].join('\n'),
    );
    const templatePath = writeFixture(
      tempDir,
      'template.md',
      [
        '# CONFIDENTIALITY AGREEMENT',
        '',
        '## ARTICLE 1',
        '',
        'Template body that must not leak.',
      ].join('\n'),
    );
    const outputPath = path.join(tempDir, 'aligned.pdf');
    const calls = [];
    let visualCallCount = 0;
    const fakeClient = {
      models: {
        list: async () => ({ data: [{ id: 'gpt-5.4' }] }),
      },
      responses: {
        create: async (payload) => {
          calls.push(payload);
          const developerContent = payload.input[0].content;

          if (/document visual QA checker/.test(developerContent)) {
            visualCallCount += 1;
            return {
              id: `visual-${visualCallCount}`,
              output_text: JSON.stringify(
                visualCallCount === 1
                  ? {
                      pass: false,
                      summary: 'Heading hierarchy is missing.',
                      issues: [
                        {
                          type: 'heading_style',
                          severity: 'medium',
                          page: 1,
                          message: 'Article label is not rendered as a heading.',
                        },
                      ],
                      repair_instructions: ['Render ARTICLE 1 as a heading below the title.'],
                    }
                  : {
                      pass: true,
                      summary: 'Visual hierarchy matches the template.',
                      issues: [],
                      repair_instructions: [],
                    },
              ),
              usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
            };
          }

          if (/visual-format repair agent/.test(developerContent)) {
            return {
              id: 'visual-repair',
              output_text: [
                '# CONFIDENTIALITY AGREEMENT',
                '',
                '## ARTICLE 1',
                '',
                'SourceCo and RecipientCo may exchange confidential information only for Project Atlas.',
              ].join('\n'),
              usage: { input_tokens: 20, output_tokens: 8, total_tokens: 28 },
            };
          }

          if (/verified legal alignment agent/.test(developerContent)) {
            return {
              id: 'verified-response',
              output_text: [
                '# CONFIDENTIALITY AGREEMENT',
                '',
                'SourceCo and RecipientCo may exchange confidential information only for Project Atlas.',
              ].join('\n'),
              usage: { input_tokens: 13, output_tokens: 6, total_tokens: 19 },
            };
          }

          return {
            id: 'generation-response',
            output_text: [
              '# CONFIDENTIALITY AGREEMENT',
              '',
              'Template body that must not leak.',
            ].join('\n'),
            usage: { input_tokens: 11, output_tokens: 5, total_tokens: 16 },
          };
        },
      },
    };

    const logs = [];
    const result = await runAlignment({
      source: sourcePath,
      template: templatePath,
      output: outputPath,
      format: 'pdf',
      client: fakeClient,
      visualCheck: 'true',
      visualCheckRepairAttempts: 1,
      visualCheckMaxPages: 1,
      logger: {
        info: (message) => logs.push({ level: 'info', message }),
        warn: (message) => logs.push({ level: 'warn', message }),
      },
    });

    assert.equal(visualCallCount, 2);
    assert.equal(result.visualChecks.length, 2);
    assert.equal(result.visualChecks[0].pass, false);
    assert.equal(result.visualChecks[1].pass, true);
    assert.deepEqual(result.usage.visual_checker, { input_tokens: 20, output_tokens: 8, total_tokens: 28 });
    assert.deepEqual(result.usage.visual_repair, { input_tokens: 20, output_tokens: 8, total_tokens: 28 });
    assert.ok(fs.existsSync(outputPath));
    assert.ok(logs.some((entry) => /visual-format repair agent/.test(entry.message)));
    assert.ok(calls.some((payload) => /BEGIN VISUAL CHECK REPORT/.test(JSON.stringify(payload.input))));
  },
);
