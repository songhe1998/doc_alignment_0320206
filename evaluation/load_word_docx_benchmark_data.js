'use strict';

function loadPairs() {
  try {
    return require('./word_docx_benchmark_data.local').PAIRS;
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND' && String(error.message || '').includes('word_docx_benchmark_data.local')) {
      throw new Error(
        'Missing local benchmark data file: evaluation/word_docx_benchmark_data.local.js. Keep the dataset local and untracked, then rerun the Word DOCX benchmark scripts.',
      );
    }

    throw error;
  }
}

module.exports = {
  loadPairs,
};
