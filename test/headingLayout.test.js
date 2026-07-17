'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildArticleHeadingLayout,
  parseArticleHeading,
  resolveArticleHeadingRule,
} = require('../src/headingLayout');

function heading(text, index) {
  return { text, index, headingCandidate: true };
}

test('article heading layout detects split and combined template conventions', () => {
  const split = buildArticleHeadingLayout([
    heading('ARTICLE I', 0),
    heading('DEFINITIONS', 1),
    { text: 'Body text.', index: 2, headingCandidate: false },
    heading('ARTICLE II', 3),
    heading('TERM', 4),
  ]);
  const combined = buildArticleHeadingLayout([
    heading('ARTICLE I DEFINITIONS', 0),
    heading('ARTICLE II TERM', 2),
  ]);

  assert.equal(split.mode, 'split');
  assert.equal(split.kindsByIndex.get(0), 'article_label');
  assert.equal(split.kindsByIndex.get(1), 'article_caption');
  assert.equal(resolveArticleHeadingRule(split, 'ARTICLE IX').mode, 'split');
  assert.equal(combined.mode, 'combined');
  assert.equal(combined.kindsByIndex.get(0), 'article_combined');
  assert.equal(resolveArticleHeadingRule(combined, 'ARTICLE IX').mode, 'combined');
});

test('mixed article layouts use exact label evidence and preserve ambiguous unknown labels', () => {
  const layout = buildArticleHeadingLayout([
    heading('ARTICLE I', 0),
    heading('DEFINITIONS', 1),
    { text: 'Body text.', index: 2, headingCandidate: false },
    heading('ARTICLE II TERM', 3),
  ]);

  assert.equal(layout.mode, 'mixed');
  assert.equal(layout.defaultMode, null);
  assert.equal(resolveArticleHeadingRule(layout, 'ARTICLE I').mode, 'split');
  assert.equal(resolveArticleHeadingRule(layout, 'ARTICLE II').mode, 'combined');
  assert.equal(resolveArticleHeadingRule(layout, 'ARTICLE III'), null);
});

test('article parsing supports Japanese and does not infer structure from body paragraphs', () => {
  assert.deepEqual(parseArticleHeading('第２条（定義）'), {
    label: '第２条',
    caption: '（定義）',
    combined: true,
  });

  const layout = buildArticleHeadingLayout([
    heading('第１条', 0),
    heading('（目的）', 1),
    { text: '第２条に定める情報を利用する', index: 2, headingCandidate: false },
  ]);
  assert.equal(layout.splitCount, 1);
  assert.equal(layout.combinedCount, 0);
  assert.equal(layout.kindsByIndex.has(2), false);
});

test('article captions may use a terminal period without accepting sentence-like body text', () => {
  const layout = buildArticleHeadingLayout([
    heading('ARTICLE I Definitions.', 0),
    heading('ARTICLE II Recipient shall keep all information confidential.', 1),
  ]);

  assert.equal(layout.combinedCount, 1);
  assert.equal(layout.kindsByIndex.get(0), 'article_combined');
  assert.equal(layout.kindsByIndex.has(1), false);
});
