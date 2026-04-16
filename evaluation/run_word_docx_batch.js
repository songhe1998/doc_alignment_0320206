'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const { runAlignment } = require('../src/alignCore');
const { loadPairs } = require('./load_word_docx_benchmark_data');

const ROOT_DIR = __dirname;
const PAIRS_DIR = path.join(ROOT_DIR, 'word_docx_pairs');
const OUTPUTS_DIR = path.join(ROOT_DIR, 'word_docx_outputs');
const ROUNDTRIP_DIR = path.join(ROOT_DIR, 'word_docx_roundtrip');
const METADATA_PATH = path.join(ROOT_DIR, 'word_docx-run-metadata.json');

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function execPandoc(args) {
  childProcess.execFileSync('pandoc', args, { stdio: 'pipe' });
}

function roundTripDocxToMarkdown(docxPath, markdownPath) {
  execPandoc([docxPath, '-t', 'gfm', '-o', markdownPath]);
}

function createLogger(logs) {
  return {
    info(message) {
      logs.push({ level: 'info', message });
      console.log(`[info] ${message}`);
    },
    warn(message) {
      logs.push({ level: 'warn', message });
      console.log(`[warn] ${message}`);
    },
  };
}

async function runBatch() {
  const PAIRS = loadPairs();

  ensureDir(OUTPUTS_DIR);
  ensureDir(ROUNDTRIP_DIR);

  const reasoning = process.env.EVAL_REASONING || 'medium';
  const model = process.env.EVAL_MODEL || undefined;
  const maxOutputTokens = process.env.EVAL_MAX_OUTPUT_TOKENS || '12000';
  const startedAt = new Date().toISOString();
  const results = [];

  for (const pair of PAIRS) {
    const pairDir = path.join(PAIRS_DIR, pair.id);
    const sourcePath = path.join(pairDir, 'source.docx');
    const templatePath = path.join(pairDir, 'template.docx');
    const outputPath = path.join(OUTPUTS_DIR, `${pair.id}-aligned.docx`);
    const roundTripMarkdownPath = path.join(ROUNDTRIP_DIR, `${pair.id}-aligned.md`);
    const logs = [];
    const logger = createLogger(logs);
    const runStarted = Date.now();

    console.log(`\n=== ${pair.id}: ${pair.scenario} ===`);

    try {
      const result = await runAlignment({
        source: sourcePath,
        template: templatePath,
        output: outputPath,
        format: 'docx',
        reasoning,
        model,
        maxOutputTokens,
        logger,
      });

      roundTripDocxToMarkdown(result.outputPath, roundTripMarkdownPath);
      const stat = fs.statSync(result.outputPath);

      results.push({
        id: pair.id,
        scenario: pair.scenario,
        status: 'ok',
        sourcePath,
        templatePath,
        outputPath: result.outputPath,
        roundTripMarkdownPath,
        fileSizeBytes: stat.size,
        model: result.model,
        requestedModel: result.requestedModel,
        usage: result.usage,
        responseId: result.responseId,
        durationMs: Date.now() - runStarted,
        logs,
      });
    } catch (error) {
      results.push({
        id: pair.id,
        scenario: pair.scenario,
        status: 'error',
        sourcePath,
        templatePath,
        outputPath,
        roundTripMarkdownPath,
        error: error.message || String(error),
        durationMs: Date.now() - runStarted,
        logs,
      });
      console.error(`[error] ${pair.id} failed: ${error.message || error}`);
    }
  }

  const payload = {
    startedAt,
    completedAt: new Date().toISOString(),
    reasoning,
    modelOverride: model || null,
    pairCount: PAIRS.length,
    results,
  };

  fs.writeFileSync(METADATA_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  const okCount = results.filter((item) => item.status === 'ok').length;
  const errorCount = results.length - okCount;
  console.log(`\nCompleted ${results.length} Word-DOCX runs: ${okCount} succeeded, ${errorCount} failed.`);
  console.log(`Metadata saved to ${METADATA_PATH}`);
}

runBatch().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
