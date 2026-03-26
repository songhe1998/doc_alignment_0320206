'use strict';

const form = document.getElementById('align-form');
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
  summaryUsage.textContent = `in ${usage.input_tokens || 0} / out ${usage.output_tokens || 0} / total ${usage.total_tokens || 0}`;

  downloadLink.href = result.downloadUrl;
}

function resetSummary() {
  resultSummary.classList.add('hidden');
  summaryFormat.textContent = '-';
  summaryModel.textContent = '-';
  summaryFile.textContent = '-';
  summaryUsage.textContent = '-';
  downloadLink.href = '#';
}

function renderLogs(logs) {
  if (!logs || logs.length === 0) {
    logOutput.textContent = 'No logs returned.';
    return;
  }

  logOutput.textContent = logs.map((entry) => `[${entry.level}] ${entry.message}`).join('\n');
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

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearError();
  resetSummary();
  setStatus('running', 'Running alignment...');
  submitButton.disabled = true;
  logOutput.textContent = 'Submitting request...';

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
    const response = await fetch('/api/align', {
      method: 'POST',
      body: formData,
    });

    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(payload?.error?.message || 'Alignment request failed.');
    }

    showSummary(payload);
    renderLogs(payload.logs);
    setStatus('success', 'Completed');
  } catch (error) {
    setError(error.message || 'Unknown error');
    setStatus('error', 'Failed');
    logOutput.textContent = 'Run failed before logs were available.';
  } finally {
    submitButton.disabled = false;
  }
});

window.addEventListener('DOMContentLoaded', async () => {
  try {
    await loadSamples();
    setStatus('idle', 'Ready');
  } catch (error) {
    setError(error.message || 'Failed to initialize UI.');
    setStatus('error', 'Initialization failed');
  }
});
