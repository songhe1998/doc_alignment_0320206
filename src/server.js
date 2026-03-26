'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const express = require('express');
const multer = require('multer');

const { runAlignment } = require('./alignCore');

const app = express();

const ROOT_DIR = process.cwd();
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const OUTPUT_DIR = path.join(ROOT_DIR, 'output');
const UI_OUTPUT_DIR = path.join(OUTPUT_DIR, 'ui');
const TEMP_UPLOAD_DIR = path.join(ROOT_DIR, '.tmp_ui_uploads');
const SUPPORTED_INPUT_EXTENSIONS = new Set(['.pdf', '.docx', '.md', '.markdown', '.txt', '.text']);
const SAMPLE_DIRS = ['data', 'examples', 'manual_test_assets'];
const DEFAULT_OUTPUT_RETENTION_HOURS = 24;

fs.mkdirSync(TEMP_UPLOAD_DIR, { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.mkdirSync(UI_OUTPUT_DIR, { recursive: true });

const upload = multer({
  dest: TEMP_UPLOAD_DIR,
  limits: {
    fileSize: parseUploadLimitMb(process.env.UPLOAD_MAX_MB) * 1024 * 1024,
  },
});

function toPosix(filePath) {
  return filePath.split(path.sep).join('/');
}

function sanitizeFileName(fileName) {
  const base = path.basename(fileName || 'upload');
  return base.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
}

function sanitizeStem(stem) {
  return (stem || 'aligned')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'aligned';
}

function walkDirectory(directory, visitor) {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walkDirectory(absolutePath, visitor);
    } else if (entry.isFile()) {
      visitor(absolutePath);
    }
  }
}

function listSampleFiles() {
  const files = [];

  for (const relativeDir of SAMPLE_DIRS) {
    const absoluteDir = path.join(ROOT_DIR, relativeDir);
    if (!fs.existsSync(absoluteDir)) {
      continue;
    }

    walkDirectory(absoluteDir, (absolutePath) => {
      const extension = path.extname(absolutePath).toLowerCase();
      if (!SUPPORTED_INPUT_EXTENSIONS.has(extension)) {
        return;
      }

      const relativePath = toPosix(path.relative(ROOT_DIR, absolutePath));
      files.push({
        id: relativePath,
        label: relativePath,
        extension,
      });
    });
  }

  return files.sort((a, b) => a.label.localeCompare(b.label));
}

function resolveSamplePath(sampleId) {
  const map = new Map(listSampleFiles().map((item) => [item.id, path.join(ROOT_DIR, item.id)]));
  return map.get(sampleId) || null;
}

function moveUploadedFile(file, requestDir) {
  const targetPath = path.join(requestDir, sanitizeFileName(file.originalname));
  fs.renameSync(file.path, targetPath);
  return targetPath;
}

function makeRequestId() {
  return `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

function parseRetentionHours(value) {
  const parsed = Number.parseInt(value || `${DEFAULT_OUTPUT_RETENTION_HOURS}`, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_OUTPUT_RETENTION_HOURS;
  }

  return parsed;
}

function parseUploadLimitMb(value) {
  const parsed = Number.parseInt(value || '50', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 50;
  }

  return parsed;
}

function cleanupExpiredEntries(rootDir, maxAgeMs) {
  if (maxAgeMs <= 0 || !fs.existsSync(rootDir)) {
    return;
  }

  const cutoff = Date.now() - maxAgeMs;
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const absolutePath = path.join(rootDir, entry.name);
    const stat = fs.statSync(absolutePath, { throwIfNoEntry: false });
    if (!stat) {
      continue;
    }

    const modifiedAt = Math.max(stat.mtimeMs || 0, stat.birthtimeMs || 0);
    if (modifiedAt >= cutoff) {
      continue;
    }

    fs.rmSync(absolutePath, { recursive: true, force: true });
  }
}

function cleanupStaleRunArtifacts() {
  const retentionHours = parseRetentionHours(process.env.OUTPUT_RETENTION_HOURS);
  const maxAgeMs = retentionHours * 60 * 60 * 1000;

  cleanupExpiredEntries(UI_OUTPUT_DIR, maxAgeMs);
  cleanupExpiredEntries(TEMP_UPLOAD_DIR, maxAgeMs);
}

function createLogger() {
  const logs = [];
  return {
    logs,
    logger: {
      info(message) {
        logs.push({ level: 'info', message });
      },
      warn(message) {
        logs.push({ level: 'warn', message });
      },
    },
  };
}

function serializeError(error) {
  return {
    message: error.message || 'Unknown error',
  };
}

app.use(express.json());
app.use('/downloads', express.static(OUTPUT_DIR));
app.use(express.static(PUBLIC_DIR));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/samples', (_req, res) => {
  res.json({
    ok: true,
    files: listSampleFiles(),
  });
});

app.post(
  '/api/align',
  upload.fields([
    { name: 'sourceFile', maxCount: 1 },
    { name: 'templateFile', maxCount: 1 },
  ]),
  async (req, res) => {
    cleanupStaleRunArtifacts();

    const requestId = makeRequestId();
    const requestDir = path.join(TEMP_UPLOAD_DIR, requestId);
    const resultDir = path.join(UI_OUTPUT_DIR, requestId);
    const files = req.files || {};
    const sourceUpload = files.sourceFile ? files.sourceFile[0] : null;
    const templateUpload = files.templateFile ? files.templateFile[0] : null;

    fs.mkdirSync(requestDir, { recursive: true });
    fs.mkdirSync(resultDir, { recursive: true });

    try {
      const sourcePath = sourceUpload
        ? moveUploadedFile(sourceUpload, requestDir)
        : resolveSamplePath(req.body.sourceSample);
      const templatePath = templateUpload
        ? moveUploadedFile(templateUpload, requestDir)
        : resolveSamplePath(req.body.templateSample);

      if (!sourcePath || !templatePath) {
        res.status(400).json({
          ok: false,
          error: { message: 'Choose or upload both a source document and a target template.' },
        });
        return;
      }

      const outputStem = sanitizeStem(req.body.outputName || 'aligned');
      const outputBasePath = path.join(resultDir, outputStem);
      const { logger, logs } = createLogger();

      const result = await runAlignment({
        source: sourcePath,
        template: templatePath,
        output: outputBasePath,
        format: req.body.format,
        model: req.body.model,
        reasoning: req.body.reasoning,
        maxOutputTokens: req.body.maxOutputTokens,
        pdfEngine: req.body.pdfEngine,
        logger,
      });

      const relativeOutputPath = toPosix(path.relative(OUTPUT_DIR, result.outputPath));
      res.json({
        ok: true,
        requestId,
        outputFormat: result.outputFormat,
        outputPath: result.outputPath,
        outputFileName: path.basename(result.outputPath),
        downloadUrl: `/downloads/${relativeOutputPath}`,
        model: result.model,
        requestedModel: result.requestedModel,
        usage: result.usage,
        logs,
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: serializeError(error),
      });
    } finally {
      fs.rmSync(requestDir, { recursive: true, force: true });
      cleanupStaleRunArtifacts();
    }
  },
);

app.use((_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

const port = Number.parseInt(process.env.PORT || '3000', 10);
cleanupStaleRunArtifacts();
app.listen(port, () => {
  console.log(`UI server listening on http://localhost:${port}`);
});
