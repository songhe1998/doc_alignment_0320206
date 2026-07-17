'use strict';

const fs = require('fs');
const path = require('path');

const SESSION_FILE = 'session.json';
const REQUEST_ID_PATTERN = /^\d{10,16}-[a-f0-9]{8}$/;

function assertRequestId(requestId) {
  if (!REQUEST_ID_PATTERN.test(String(requestId || ''))) {
    throw new Error('Invalid document session ID.');
  }
  return requestId;
}

function resolveSessionDir(rootDir, requestId) {
  assertRequestId(requestId);
  const root = path.resolve(rootDir);
  const sessionDir = path.resolve(root, requestId);
  if (path.dirname(sessionDir) !== root) {
    throw new Error('Invalid document session path.');
  }
  return sessionDir;
}

function resolveSessionFile(sessionDir, relativePath) {
  const root = path.resolve(sessionDir);
  const resolved = path.resolve(root, String(relativePath || ''));
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error('Invalid file path in document session.');
  }
  return resolved;
}

function writeSession(sessionDir, session) {
  fs.mkdirSync(sessionDir, { recursive: true });
  const sessionPath = path.join(sessionDir, SESSION_FILE);
  const tempPath = `${sessionPath}.tmp`;
  session.updatedAt = new Date().toISOString();
  fs.writeFileSync(tempPath, `${JSON.stringify(session, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, sessionPath);
  return session;
}

function loadSession(rootDir, requestId) {
  const sessionDir = resolveSessionDir(rootDir, requestId);
  const sessionPath = path.join(sessionDir, SESSION_FILE);
  const stat = fs.statSync(sessionPath, { throwIfNoEntry: false });
  if (!stat || !stat.isFile()) {
    return null;
  }

  const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  Object.defineProperty(session, 'sessionDir', {
    value: sessionDir,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return session;
}

function draftExtension(outputFormat) {
  return outputFormat === 'latex' ? '.tex' : '.md';
}

function createSession({
  sessionDir,
  requestId,
  sourceFile,
  templateFile,
  outputStem,
  result,
  previewFile = null,
  options = {},
}) {
  const now = new Date().toISOString();
  const draftFile = `draft-v1${draftExtension(result.outputFormat)}`;
  fs.writeFileSync(path.join(sessionDir, draftFile), `${result.finalDocument}\n`, 'utf8');

  const session = {
    schemaVersion: 1,
    requestId,
    createdAt: now,
    updatedAt: now,
    sourceFile: path.relative(sessionDir, sourceFile),
    templateFile: path.relative(sessionDir, templateFile),
    sourceName: path.basename(sourceFile).replace(/^source-/, ''),
    templateName: path.basename(templateFile).replace(/^template-/, ''),
    outputStem,
    outputFormat: result.outputFormat,
    model: result.model,
    requestedModel: result.requestedModel,
    options,
    currentVersion: 1,
    messages: [
      {
        role: 'assistant',
        content: 'Initial alignment completed and verified.',
        warnings: [],
        version: 1,
        createdAt: now,
      },
    ],
    versions: [
      {
        version: 1,
        parentVersion: null,
        createdAt: now,
        instruction: null,
        assistantMessage: 'Initial alignment completed and verified.',
        changeType: 'initial',
        draftFile,
        outputFile: path.relative(sessionDir, result.outputPath),
        previewFile: previewFile ? path.relative(sessionDir, previewFile) : null,
        usage: result.usage || {},
        visualChecks: result.visualChecks || [],
      },
    ],
  };

  return writeSession(sessionDir, session);
}

function currentVersionEntry(session) {
  return session.versions.find((entry) => entry.version === session.currentVersion) || null;
}

function ensureSessionMessages(session) {
  if (session.messages?.length) {
    return session.messages;
  }

  session.messages = session.versions.flatMap((entry) => [
    ...(entry.instruction
      ? [{
          role: 'user',
          content: entry.instruction,
          warnings: [],
          version: entry.version,
          createdAt: entry.createdAt,
        }]
      : []),
    {
      role: 'assistant',
      content: entry.assistantMessage || `Version ${entry.version} saved.`,
      warnings: entry.warnings || [],
      version: entry.version,
      createdAt: entry.createdAt,
    },
  ]);
  return session.messages;
}

function appendVersion(session, {
  instruction,
  result,
  previewFile = null,
}) {
  const sessionDir = session.sessionDir;
  const version = Math.max(...session.versions.map((entry) => entry.version), 0) + 1;
  const draftFile = `draft-v${version}${draftExtension(session.outputFormat)}`;
  fs.writeFileSync(path.join(sessionDir, draftFile), `${result.finalDocument}\n`, 'utf8');

  const entry = {
    version,
    parentVersion: session.currentVersion,
    createdAt: new Date().toISOString(),
    instruction,
    assistantMessage: result.summary,
    warnings: result.warnings || [],
    formatOperations: result.formatOperations || [],
    changeType: result.changeType || 'mixed',
    draftFile,
    outputFile: path.relative(sessionDir, result.outputPath),
    previewFile: previewFile ? path.relative(sessionDir, previewFile) : null,
    usage: result.usage || {},
    visualChecks: result.visualChecks || [],
  };
  session.versions.push(entry);
  session.currentVersion = version;
  ensureSessionMessages(session).push(
    {
      role: 'user',
      content: instruction,
      warnings: [],
      version,
      createdAt: entry.createdAt,
    },
    {
      role: 'assistant',
      content: result.summary,
      warnings: result.warnings || [],
      version,
      createdAt: entry.createdAt,
    },
  );
  writeSession(sessionDir, session);
  return entry;
}

function appendSessionMessage(session, role, content, { warnings = [], version = null } = {}) {
  ensureSessionMessages(session).push({
    role,
    content: String(content || '').trim(),
    warnings,
    version,
    createdAt: new Date().toISOString(),
  });
  writeSession(session.sessionDir, session);
}

function undoSession(session) {
  const current = currentVersionEntry(session);
  if (!current || current.parentVersion === null) {
    return null;
  }

  session.currentVersion = current.parentVersion;
  ensureSessionMessages(session).push({
    role: 'assistant',
    content: `Restored version ${session.currentVersion}.`,
    warnings: [],
    version: session.currentVersion,
    createdAt: new Date().toISOString(),
  });
  writeSession(session.sessionDir, session);
  return currentVersionEntry(session);
}

function readCurrentDraft(session) {
  const current = currentVersionEntry(session);
  if (!current) {
    throw new Error('Document session has no current version.');
  }
  return fs.readFileSync(resolveSessionFile(session.sessionDir, current.draftFile), 'utf8').trim();
}

module.exports = {
  appendSessionMessage,
  appendVersion,
  assertRequestId,
  createSession,
  currentVersionEntry,
  loadSession,
  readCurrentDraft,
  resolveSessionDir,
  resolveSessionFile,
  undoSession,
};
