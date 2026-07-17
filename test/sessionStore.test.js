'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const {
  appendSessionMessage,
  appendVersion,
  createSession,
  currentVersionEntry,
  loadSession,
  readCurrentDraft,
  undoSession,
} = require('../src/sessionStore');

test('document sessions persist drafts and undo to the actual parent version', (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'document-session-'));
  const requestId = '1781505410669-01417e60';
  const sessionDir = path.join(rootDir, requestId);
  const inputDir = path.join(sessionDir, 'inputs');
  fs.mkdirSync(inputDir, { recursive: true });
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));

  const sourcePath = path.join(inputDir, 'source-source.md');
  const templatePath = path.join(inputDir, 'template-template.md');
  const outputV1 = path.join(sessionDir, 'aligned.md');
  fs.writeFileSync(sourcePath, '# Source', 'utf8');
  fs.writeFileSync(templatePath, '# Template', 'utf8');
  fs.writeFileSync(outputV1, '# Version 1', 'utf8');

  createSession({
    sessionDir,
    requestId,
    sourceFile: sourcePath,
    templateFile: templatePath,
    outputStem: 'aligned',
    result: {
      outputFormat: 'markdown',
      outputPath: outputV1,
      finalDocument: '# Version 1',
      model: 'gpt-5.4',
      requestedModel: 'gpt-5.4',
      usage: {},
      visualChecks: [],
    },
  });

  let session = loadSession(rootDir, requestId);
  assert.equal(readCurrentDraft(session), '# Version 1');
  assert.equal(currentVersionEntry(session).parentVersion, null);

  const outputV2 = path.join(sessionDir, 'aligned-v2.md');
  fs.writeFileSync(outputV2, '# Version 2', 'utf8');
  appendVersion(session, {
    instruction: 'Change the title.',
    result: {
      outputPath: outputV2,
      finalDocument: '# Version 2',
      summary: 'Changed the title.',
      changeType: 'format',
      usage: {},
      visualChecks: [],
    },
  });

  session = loadSession(rootDir, requestId);
  assert.equal(session.currentVersion, 2);
  assert.deepEqual(session.messages.map((message) => message.role), ['assistant', 'user', 'assistant']);
  assert.equal(currentVersionEntry(session).parentVersion, 1);
  assert.equal(readCurrentDraft(session), '# Version 2');

  const restored = undoSession(session);
  assert.equal(restored.version, 1);
  session = loadSession(rootDir, requestId);
  assert.equal(session.currentVersion, 1);
  assert.equal(readCurrentDraft(session), '# Version 1');
  assert.match(session.messages.at(-1).content, /Restored version 1/);

  appendSessionMessage(session, 'user', 'Add unsupported governing law.');
  appendSessionMessage(session, 'assistant', 'That content is not supported by the source.', {
    warnings: ['No governing-law clause was found.'],
  });
  session = loadSession(rootDir, requestId);
  assert.equal(session.messages.at(-1).warnings[0], 'No governing-law clause was found.');

  const outputV3 = path.join(sessionDir, 'aligned-v3.md');
  fs.writeFileSync(outputV3, '# Version 3', 'utf8');
  appendVersion(session, {
    instruction: 'Add a blank line.',
    result: {
      outputPath: outputV3,
      finalDocument: '# Version 3',
      summary: 'Added a blank line.',
      changeType: 'format',
      usage: {},
      visualChecks: [],
    },
  });

  session = loadSession(rootDir, requestId);
  const branchedVersion = currentVersionEntry(session);
  assert.equal(branchedVersion.version, 3);
  assert.equal(branchedVersion.parentVersion, 1);
});
