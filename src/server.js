'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const express = require('express');
const multer = require('multer');

const { runAlignment, runRevision } = require('./alignCore');
const {
  appendSessionMessage,
  appendVersion,
  createSession,
  currentVersionEntry,
  loadSession,
  readCurrentDraft,
  resolveSessionFile,
  undoSession,
} = require('./sessionStore');
const { convertDocumentToPreviewPdf } = require('./visualChecker');

const app = express();

const ROOT_DIR = process.cwd();
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const OUTPUT_DIR = path.join(ROOT_DIR, 'output');
const UI_OUTPUT_DIR = path.join(OUTPUT_DIR, 'ui');
const TEMP_UPLOAD_DIR = path.join(ROOT_DIR, '.tmp_ui_uploads');
const SUPPORTED_INPUT_EXTENSIONS = new Set(['.pdf', '.docx', '.md', '.markdown', '.txt', '.text']);
const SAMPLE_DIRS = ['data', 'examples', 'manual_test_assets'];
const DEFAULT_OUTPUT_RETENTION_HOURS = 24;
const activeRevisionSessions = new Set();

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

function copySessionInput(sourcePath, role, resultDir) {
  const inputDir = path.join(resultDir, 'inputs');
  fs.mkdirSync(inputDir, { recursive: true });
  const targetPath = path.join(inputDir, `${role}-${sanitizeFileName(path.basename(sourcePath))}`);
  fs.copyFileSync(sourcePath, targetPath);
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

function relativeDownloadUrl(filePath) {
  const relativePath = toPosix(path.relative(OUTPUT_DIR, filePath));
  return `/downloads/${relativePath}`;
}

function createVersionPreview(outputPath, outputFormat, sessionDir, version, logger) {
  if (outputFormat === 'pdf') {
    return outputPath;
  }
  if (outputFormat !== 'docx') {
    return null;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-align-ui-preview-'));
  try {
    const convertedPath = convertDocumentToPreviewPdf(outputPath, tempDir, `version-${version}`);
    const previewPath = path.join(sessionDir, `preview-v${version}.pdf`);
    fs.copyFileSync(convertedPath, previewPath);
    return previewPath;
  } catch (error) {
    logger.warn(`Browser preview unavailable: ${error.message}`);
    return null;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function serializeSession(session) {
  const current = currentVersionEntry(session);
  if (!current) {
    throw new Error('Document session has no current version.');
  }

  const outputPath = resolveSessionFile(session.sessionDir, current.outputFile);
  const previewPath = current.previewFile
    ? resolveSessionFile(session.sessionDir, current.previewFile)
    : null;
  const messages = session.messages || session.versions.flatMap((entry) => [
    ...(entry.instruction
      ? [{ role: 'user', content: entry.instruction, warnings: [], version: entry.version }]
      : []),
    {
      role: 'assistant',
      content: entry.assistantMessage || `Version ${entry.version} saved.`,
      warnings: entry.warnings || [],
      version: entry.version,
    },
  ]);

  return {
    requestId: session.requestId,
    sourceName: session.sourceName,
    templateName: session.templateName,
    outputFormat: session.outputFormat,
    model: session.model,
    currentVersion: session.currentVersion,
    canUndo: current.parentVersion !== null,
    outputFileName: path.basename(outputPath),
    downloadUrl: relativeDownloadUrl(outputPath),
    previewUrl: previewPath ? relativeDownloadUrl(previewPath) : null,
    draftUrl: `/api/sessions/${session.requestId}/draft`,
    messages,
    versions: session.versions.map((entry) => ({
      version: entry.version,
      parentVersion: entry.parentVersion,
      createdAt: entry.createdAt,
      instruction: entry.instruction,
      assistantMessage: entry.assistantMessage,
      warnings: entry.warnings || [],
      changeType: entry.changeType,
      active: entry.version === session.currentVersion,
    })),
  };
}

app.use(express.json());
app.use('/downloads', (req, res, next) => {
  const segments = req.path.split('/').filter(Boolean);
  const fileName = segments.at(-1) || '';
  if (
    segments.includes('inputs') ||
    fileName === 'session.json' ||
    /^draft-v\d+\.(?:md|tex)$/i.test(fileName)
  ) {
    res.sendStatus(404);
    return;
  }
  next();
});
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

app.get('/api/sessions/:requestId', (req, res) => {
  try {
    const session = loadSession(UI_OUTPUT_DIR, req.params.requestId);
    if (!session) {
      res.status(404).json({ ok: false, error: { message: 'Document session not found or expired.' } });
      return;
    }
    res.json({ ok: true, session: serializeSession(session) });
  } catch (error) {
    res.status(400).json({ ok: false, error: serializeError(error) });
  }
});

app.get('/api/sessions/:requestId/draft', (req, res) => {
  try {
    const session = loadSession(UI_OUTPUT_DIR, req.params.requestId);
    if (!session) {
      res.status(404).json({ ok: false, error: { message: 'Document session not found or expired.' } });
      return;
    }
    res.json({
      ok: true,
      version: session.currentVersion,
      outputFormat: session.outputFormat,
      draft: readCurrentDraft(session),
    });
  } catch (error) {
    res.status(400).json({ ok: false, error: serializeError(error) });
  }
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
      const resolvedSourcePath = sourceUpload
        ? moveUploadedFile(sourceUpload, requestDir)
        : resolveSamplePath(req.body.sourceSample);
      const resolvedTemplatePath = templateUpload
        ? moveUploadedFile(templateUpload, requestDir)
        : resolveSamplePath(req.body.templateSample);

      if (!resolvedSourcePath || !resolvedTemplatePath) {
        res.status(400).json({
          ok: false,
          error: { message: 'Choose or upload both a source document and a target template.' },
        });
        return;
      }

      const sourcePath = copySessionInput(resolvedSourcePath, 'source', resultDir);
      const templatePath = copySessionInput(resolvedTemplatePath, 'template', resultDir);

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
        visualCheck: req.body.visualCheck,
        visualCheckModel: req.body.visualCheckModel,
        visualCheckMaxPages: req.body.visualCheckMaxPages,
        visualCheckRepairAttempts: req.body.visualCheckRepairAttempts,
        logger,
      });

      const previewPath = createVersionPreview(
        result.outputPath,
        result.outputFormat,
        resultDir,
        1,
        logger,
      );
      createSession({
        sessionDir: resultDir,
        requestId,
        sourceFile: sourcePath,
        templateFile: templatePath,
        outputStem,
        result,
        previewFile: previewPath,
        options: {
          reasoning: req.body.reasoning,
          maxOutputTokens: req.body.maxOutputTokens,
          pdfEngine: req.body.pdfEngine,
          visualCheck: req.body.visualCheck,
          visualCheckModel: req.body.visualCheckModel,
          visualCheckMaxPages: req.body.visualCheckMaxPages,
          visualCheckRepairAttempts: req.body.visualCheckRepairAttempts,
        },
      });
      const session = loadSession(UI_OUTPUT_DIR, requestId);

      const sessionPayload = serializeSession(session);
      res.json({
        ok: true,
        requestId,
        outputFormat: result.outputFormat,
        outputPath: result.outputPath,
        outputFileName: path.basename(result.outputPath),
        downloadUrl: sessionPayload.downloadUrl,
        previewUrl: sessionPayload.previewUrl,
        draftUrl: sessionPayload.draftUrl,
        session: sessionPayload,
        model: result.model,
        requestedModel: result.requestedModel,
        usage: result.usage,
        visualChecks: result.visualChecks,
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

app.post('/api/sessions/:requestId/messages', async (req, res) => {
  cleanupStaleRunArtifacts();
  const requestId = req.params.requestId;
  const instruction = String(req.body?.message || '').trim();

  if (!instruction) {
    res.status(400).json({ ok: false, error: { message: 'Describe what you want to change.' } });
    return;
  }
  if (activeRevisionSessions.has(requestId)) {
    res.status(409).json({ ok: false, error: { message: 'This document is already being revised.' } });
    return;
  }

  activeRevisionSessions.add(requestId);
  try {
    const session = loadSession(UI_OUTPUT_DIR, requestId);
    if (!session) {
      res.status(404).json({ ok: false, error: { message: 'Document session not found or expired.' } });
      return;
    }

    const nextVersion = Math.max(...session.versions.map((entry) => entry.version), 0) + 1;
    const outputBasePath = path.join(session.sessionDir, `${session.outputStem}-v${nextVersion}`);
    const sourcePath = resolveSessionFile(session.sessionDir, session.sourceFile);
    const templatePath = resolveSessionFile(session.sessionDir, session.templateFile);
    const { logger, logs } = createLogger();
    const result = await runRevision({
      source: sourcePath,
      template: templatePath,
      currentDocument: readCurrentDraft(session),
      instruction,
      output: outputBasePath,
      format: session.outputFormat,
      model: session.model,
      ...session.options,
      logger,
    });

    if (!result.applied) {
      appendSessionMessage(session, 'user', instruction);
      appendSessionMessage(session, 'assistant', result.summary, { warnings: result.warnings });
      const updatedSession = loadSession(UI_OUTPUT_DIR, requestId);
      res.json({
        ok: true,
        applied: false,
        assistantMessage: result.summary,
        warnings: result.warnings,
        session: serializeSession(updatedSession),
        logs,
      });
      return;
    }

    const previewPath = createVersionPreview(
      result.outputPath,
      result.outputFormat,
      session.sessionDir,
      nextVersion,
      logger,
    );
    appendVersion(session, { instruction, result, previewFile: previewPath });
    const updatedSession = loadSession(UI_OUTPUT_DIR, requestId);

    res.json({
      ok: true,
      applied: true,
      assistantMessage: result.summary,
      warnings: result.warnings,
      usage: result.usage,
      visualChecks: result.visualChecks,
      session: serializeSession(updatedSession),
      logs,
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: serializeError(error) });
  } finally {
    activeRevisionSessions.delete(requestId);
    cleanupStaleRunArtifacts();
  }
});

app.post('/api/sessions/:requestId/undo', (req, res) => {
  const requestId = req.params.requestId;
  if (activeRevisionSessions.has(requestId)) {
    res.status(409).json({ ok: false, error: { message: 'Wait for the current revision to finish before undoing.' } });
    return;
  }

  try {
    const session = loadSession(UI_OUTPUT_DIR, requestId);
    if (!session) {
      res.status(404).json({ ok: false, error: { message: 'Document session not found or expired.' } });
      return;
    }

    const restored = undoSession(session);
    if (!restored) {
      res.status(409).json({ ok: false, error: { message: 'There is no earlier revision to restore.' } });
      return;
    }

    const updatedSession = loadSession(UI_OUTPUT_DIR, requestId);
    res.json({
      ok: true,
      assistantMessage: `Restored version ${restored.version}.`,
      session: serializeSession(updatedSession),
    });
  } catch (error) {
    res.status(400).json({ ok: false, error: serializeError(error) });
  }
});

app.use((_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

const port = Number.parseInt(process.env.PORT || '3000', 10);
cleanupStaleRunArtifacts();
app.listen(port, () => {
  console.log(`UI server listening on http://localhost:${port}`);
});
