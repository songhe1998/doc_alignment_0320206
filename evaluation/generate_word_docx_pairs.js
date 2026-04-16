'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const { loadPairs } = require('./load_word_docx_benchmark_data');

const ROOT_DIR = __dirname;
const OUTPUT_DIR = path.join(ROOT_DIR, 'word_docx_pairs');
const STAGING_DIR = path.join(process.cwd(), 'tmp_word_probe');

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function normalizeText(text) {
  return `${text.trim()}\n`;
}

function appleScriptString(value) {
  return JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function runAppleScript(script) {
  childProcess.execFileSync('osascript', ['-e', script], {
    stdio: 'pipe',
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 10,
  });
}

function quitWordIfRunning() {
  try {
    runAppleScript('tell application "Microsoft Word" to quit saving no');
  } catch (error) {
    // Ignore if Word is not running or has nothing to quit.
  }
}

function saveDocxViaWord(filePath, content) {
  const script = `
    tell application "Microsoft Word"
      activate
      create new document
      set content of text object of active document to ${appleScriptString(content)}
      save as active document file name ${appleScriptString(filePath)} file format format document
    end tell
  `;
  runAppleScript(script);
}

function clearStagingArea() {
  ensureDir(STAGING_DIR);
  for (const entry of fs.readdirSync(STAGING_DIR)) {
    fs.rmSync(path.join(STAGING_DIR, entry), { recursive: true, force: true });
  }
}

function moveFromStaging(stagedName, targetPath) {
  const stagedPath = path.join(STAGING_DIR, stagedName);
  fs.renameSync(stagedPath, targetPath);
}

function removeWordLockFiles() {
  if (!fs.existsSync(STAGING_DIR)) {
    return;
  }

  for (const entry of fs.readdirSync(STAGING_DIR)) {
    if (entry.startsWith('~$')) {
      fs.rmSync(path.join(STAGING_DIR, entry), { force: true });
    }
  }
}

function main() {
  const PAIRS = loadPairs();

  ensureDir(OUTPUT_DIR);
  ensureDir(STAGING_DIR);

  clearStagingArea();
  quitWordIfRunning();

  for (const pair of PAIRS) {
    const pairDir = path.join(OUTPUT_DIR, pair.id);
    const stagedSourceName = `${pair.id}-source.docx`;
    const stagedTemplateName = `${pair.id}-template.docx`;
    const stagedSourcePath = path.join(STAGING_DIR, stagedSourceName);
    const stagedTemplatePath = path.join(STAGING_DIR, stagedTemplateName);

    ensureDir(pairDir);

    console.log(`Generating ${pair.id} in Microsoft Word`);
    saveDocxViaWord(stagedSourcePath, normalizeText(pair.source));
    saveDocxViaWord(stagedTemplatePath, normalizeText(pair.template));

    fs.writeFileSync(path.join(pairDir, 'scenario.txt'), `${pair.scenario}\n`, 'utf8');
    fs.writeFileSync(path.join(pairDir, 'source.txt'), `${normalizeText(pair.source)}`, 'utf8');
    fs.writeFileSync(path.join(pairDir, 'template.txt'), `${normalizeText(pair.template)}`, 'utf8');

    moveFromStaging(stagedSourceName, path.join(pairDir, 'source.docx'));
    moveFromStaging(stagedTemplateName, path.join(pairDir, 'template.docx'));
  }

  quitWordIfRunning();
  removeWordLockFiles();

  console.log(`Generated ${PAIRS.length} DOCX benchmark pairs in ${OUTPUT_DIR}`);
}

main();
