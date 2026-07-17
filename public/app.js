'use strict';

const form = document.getElementById('align-form');
const setupWorkspace = document.getElementById('setup-workspace');
const reviewWorkspace = document.getElementById('review-workspace');
const sourceSample = document.getElementById('source-sample');
const templateSample = document.getElementById('template-sample');
const sourceFile = document.getElementById('source-file');
const templateFile = document.getElementById('template-file');
const submitButton = document.getElementById('submit-button');
const statusCard = document.getElementById('status-card');
const statusText = document.getElementById('status-text');
const resultSummary = document.getElementById('result-summary');
const errorBox = document.getElementById('error-box');
const logOutput = document.getElementById('log-output');
const summaryFormat = document.getElementById('summary-format');
const summaryModel = document.getElementById('summary-model');
const summaryFile = document.getElementById('summary-file');
const summaryUsage = document.getElementById('summary-usage');
const downloadLink = document.getElementById('download-link');
const reviewContext = document.getElementById('review-context');
const reviewFile = document.getElementById('review-file');
const versionLabel = document.getElementById('version-label');
const undoButton = document.getElementById('undo-button');
const reviewDownloadLink = document.getElementById('review-download-link');
const newRunButton = document.getElementById('new-run-button');
const chatThread = document.getElementById('chat-thread');
const chatState = document.getElementById('chat-state');
const revisionForm = document.getElementById('revision-form');
const revisionInput = document.getElementById('revision-input');
const revisionSubmit = document.getElementById('revision-submit');
const previewFormat = document.getElementById('preview-format');
const previewLoading = document.getElementById('preview-loading');
const pdfPreview = document.getElementById('pdf-preview');
const textPreview = document.getElementById('text-preview');
const versionHistory = document.getElementById('version-history');
const historyCount = document.getElementById('history-count');
const reviewLogOutput = document.getElementById('review-log-output');

let currentSession = null;
let previewSequence = 0;

function setStatus(mode, message) {
  statusCard.className = `status-card ${mode}`;
  statusText.textContent = message;
}

function setError(message) {
  errorBox.textContent = message;
  errorBox.classList.remove('hidden');
}

function clearError() {
  errorBox.textContent = '';
  errorBox.classList.add('hidden');
}

function showSummary(result) {
  resultSummary.classList.remove('hidden');
  summaryFormat.textContent = result.outputFormat || '-';
  summaryModel.textContent = result.model || '-';
  summaryFile.textContent = result.outputFileName || '-';

  const usage = result.usage || {};
  summaryUsage.textContent = `${usage.input_tokens || 0} in / ${usage.output_tokens || 0} out`;
  downloadLink.href = result.downloadUrl || '#';
}

function renderLogs(logs, target = logOutput) {
  if (!logs || logs.length === 0) {
    target.textContent = 'No logs returned.';
    return;
  }
  target.textContent = logs.map((entry) => `[${entry.level}] ${entry.message}`).join('\n');
}

function appendChatMessage(role, text, warnings = [], options = {}) {
  const message = document.createElement('div');
  message.className = `chat-message ${role}${options.pending ? ' pending' : ''}`;
  if (options.id) {
    message.id = options.id;
  }
  message.textContent = text;

  for (const warning of warnings || []) {
    const warningText = document.createElement('span');
    warningText.className = 'chat-warning';
    warningText.textContent = warning;
    message.appendChild(warningText);
  }

  chatThread.appendChild(message);
  chatThread.scrollTop = chatThread.scrollHeight;
  return message;
}

function renderConversation(session) {
  chatThread.replaceChildren();
  if (session.messages?.length) {
    for (const message of session.messages) {
      appendChatMessage(message.role, message.content, message.warnings);
    }
    return;
  }

  for (const version of session.versions) {
    if (version.instruction) {
      appendChatMessage('user', version.instruction);
    }
    appendChatMessage('assistant', version.assistantMessage || `Version ${version.version} saved.`, version.warnings);
  }
}

function renderHistory(session) {
  versionHistory.replaceChildren();
  historyCount.textContent = String(session.versions.length);

  for (const version of [...session.versions].reverse()) {
    const item = document.createElement('li');
    item.className = `version-item${version.active ? ' active' : ''}`;

    const title = document.createElement('strong');
    title.textContent = `Version ${version.version}${version.active ? ' · current' : ''}`;
    const meta = document.createElement('span');
    meta.textContent = version.changeType === 'initial' ? 'Initial alignment' : `${version.changeType} revision`;
    const body = document.createElement('p');
    body.textContent = version.instruction || version.assistantMessage || 'Aligned document';

    item.append(title, meta, body);
    versionHistory.appendChild(item);
  }
}

async function renderPreview(session) {
  const sequence = ++previewSequence;
  previewLoading.classList.remove('hidden');
  previewLoading.textContent = 'Loading preview…';
  pdfPreview.classList.add('hidden');
  textPreview.classList.add('hidden');
  pdfPreview.removeAttribute('src');
  previewFormat.textContent = session.outputFormat.toUpperCase();

  if (session.previewUrl) {
    pdfPreview.onload = () => {
      if (sequence !== previewSequence) {
        return;
      }
      previewLoading.classList.add('hidden');
      pdfPreview.classList.remove('hidden');
    };
    pdfPreview.src = `${session.previewUrl}#toolbar=1&navpanes=0&view=FitH`;
    return;
  }

  try {
    const response = await fetch(session.draftUrl, { cache: 'no-store' });
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(payload?.error?.message || 'Preview could not be loaded.');
    }
    if (sequence !== previewSequence) {
      return;
    }
    textPreview.textContent = payload.draft;
    previewLoading.classList.add('hidden');
    textPreview.classList.remove('hidden');
  } catch (error) {
    if (sequence !== previewSequence) {
      return;
    }
    previewLoading.textContent = error.message || 'Preview unavailable.';
  }
}

function renderSession(session, { conversation = true } = {}) {
  currentSession = session;
  reviewContext.textContent = `${session.sourceName} → ${session.templateName}`;
  reviewFile.textContent = session.outputFileName;
  versionLabel.textContent = `Version ${session.currentVersion}`;
  undoButton.disabled = !session.canUndo;
  reviewDownloadLink.href = session.downloadUrl;
  renderHistory(session);
  if (conversation) {
    renderConversation(session);
  }
  renderPreview(session);
}

function openReview(session) {
  setupWorkspace.classList.add('hidden');
  reviewWorkspace.classList.remove('hidden');
  renderSession(session);
  const url = new URL(window.location.href);
  url.searchParams.set('session', session.requestId);
  window.history.replaceState({}, '', url);
}

function openSetup() {
  reviewWorkspace.classList.add('hidden');
  setupWorkspace.classList.remove('hidden');
  currentSession = null;
  const url = new URL(window.location.href);
  url.searchParams.delete('session');
  window.history.replaceState({}, '', url);
  setStatus('idle', 'Ready');
}

async function loadSamples() {
  const response = await fetch('/api/samples');
  const payload = await response.json();
  if (!payload.ok) {
    throw new Error('Failed to load sample files.');
  }

  for (const file of payload.files) {
    const option = new Option(file.label, file.id);
    sourceSample.add(option.cloneNode(true));
    templateSample.add(option);
  }
}

async function loadExistingSession(requestId) {
  const response = await fetch(`/api/sessions/${encodeURIComponent(requestId)}`, { cache: 'no-store' });
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(payload?.error?.message || 'Document session could not be loaded.');
  }
  openReview(payload.session);
  setStatus('success', 'Ready');
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearError();
  setStatus('running', 'Aligning');
  submitButton.disabled = true;
  logOutput.textContent = 'Submitting alignment…';

  const formData = new FormData(form);
  if (sourceFile.files[0]) {
    formData.set('sourceFile', sourceFile.files[0]);
  } else {
    formData.delete('sourceFile');
  }
  if (templateFile.files[0]) {
    formData.set('templateFile', templateFile.files[0]);
  } else {
    formData.delete('templateFile');
  }

  try {
    const response = await fetch('/api/align', { method: 'POST', body: formData });
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(payload?.error?.message || 'Alignment request failed.');
    }

    showSummary(payload);
    renderLogs(payload.logs);
    renderLogs(payload.logs, reviewLogOutput);
    openReview(payload.session);
    setStatus('success', 'Ready');
  } catch (error) {
    setError(error.message || 'Unknown error');
    setStatus('error', 'Failed');
    logOutput.textContent = 'Run failed before logs were available.';
  } finally {
    submitButton.disabled = false;
  }
});

revisionForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = revisionInput.value.trim();
  if (!message || !currentSession) {
    return;
  }

  const requestId = currentSession.requestId;
  const pendingId = `pending-${Date.now()}`;
  appendChatMessage('user', message);
  appendChatMessage('assistant', 'Applying and verifying the revision…', [], { pending: true, id: pendingId });
  revisionInput.value = '';
  revisionInput.disabled = true;
  revisionSubmit.disabled = true;
  undoButton.disabled = true;
  chatState.textContent = 'Working';
  setStatus('running', 'Revising');

  try {
    const response = await fetch(`/api/sessions/${encodeURIComponent(requestId)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(payload?.error?.message || 'Revision failed.');
    }

    renderLogs(payload.logs, reviewLogOutput);
    if (payload.applied) {
      renderSession(payload.session);
    } else {
      document.getElementById(pendingId)?.remove();
      appendChatMessage('assistant', payload.assistantMessage || 'No change was applied.', payload.warnings);
      renderSession(payload.session, { conversation: false });
    }
    setStatus('success', 'Ready');
  } catch (error) {
    document.getElementById(pendingId)?.remove();
    appendChatMessage('assistant', `Revision failed: ${error.message || 'Unknown error'}`);
    setStatus('error', 'Failed');
  } finally {
    revisionInput.disabled = false;
    revisionSubmit.disabled = false;
    undoButton.disabled = !currentSession?.canUndo;
    chatState.textContent = 'Ready';
    revisionInput.focus();
  }
});

undoButton.addEventListener('click', async () => {
  if (!currentSession?.canUndo) {
    return;
  }

  undoButton.disabled = true;
  revisionSubmit.disabled = true;
  setStatus('running', 'Restoring');
  try {
    const response = await fetch(`/api/sessions/${encodeURIComponent(currentSession.requestId)}/undo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(payload?.error?.message || 'Undo failed.');
    }
    renderSession(payload.session);
    appendChatMessage('assistant', payload.assistantMessage);
    setStatus('success', 'Ready');
  } catch (error) {
    appendChatMessage('assistant', `Undo failed: ${error.message || 'Unknown error'}`);
    setStatus('error', 'Failed');
  } finally {
    undoButton.disabled = !currentSession?.canUndo;
    revisionSubmit.disabled = false;
  }
});

newRunButton.addEventListener('click', openSetup);

window.addEventListener('DOMContentLoaded', async () => {
  try {
    await loadSamples();
    const requestId = new URL(window.location.href).searchParams.get('session');
    if (requestId) {
      setStatus('running', 'Loading');
      await loadExistingSession(requestId);
    } else {
      setStatus('idle', 'Ready');
    }
  } catch (error) {
    setError(error.message || 'Failed to initialize UI.');
    openSetup();
    setStatus('error', 'Failed');
  }
});
