'use strict';

const ARTICLE_LABEL_SOURCE =
  '(?:第[0-9０-９一二三四五六七八九十百]+[条章節]|ARTICLE\\s+[0-9IVXLCDM]+|Section\\s+[0-9.]+)';
const ARTICLE_LABEL_REGEX = new RegExp(`^${ARTICLE_LABEL_SOURCE}$`, 'i');
const ARTICLE_WITH_CAPTION_REGEX = new RegExp(
  `^(${ARTICLE_LABEL_SOURCE})(?:[：:．.\\-–—　\\s]+|(?=[（(]))(.+)$`,
  'i',
);

function normalizeHeadingText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function parseArticleHeading(value) {
  const text = normalizeHeadingText(value);
  if (!text) {
    return null;
  }
  if (ARTICLE_LABEL_REGEX.test(text)) {
    return { label: text, caption: '', combined: false };
  }
  const match = text.match(ARTICLE_WITH_CAPTION_REGEX);
  if (!match) {
    return null;
  }
  return {
    label: normalizeHeadingText(match[1]),
    caption: normalizeHeadingText(match[2]),
    combined: true,
  };
}

function articleLabelKey(value) {
  const parsed = parseArticleHeading(value);
  return parsed ? parsed.label.replace(/\s+/g, ' ').toUpperCase() : '';
}

function isStandaloneArticleLabel(value) {
  const parsed = parseArticleHeading(value);
  return Boolean(parsed && !parsed.caption);
}

function isLikelyHeadingCaption(value) {
  const text = normalizeHeadingText(value);
  if (!text || text.length > 100 || parseArticleHeading(text)) {
    return false;
  }
  if (/^[0-9０-９]+(?:[.．]|\s)/.test(text) || /[;。！？!?]$/.test(text)) {
    return false;
  }
  if (/^[（(][^）)]{1,90}[）)]$/.test(text)) {
    return true;
  }

  const caption = text.replace(/\.$/, '');
  const words = caption.split(/\s+/).filter(Boolean);
  const letters = caption.replace(/[^A-Za-z]/g, '');
  const uppercase = letters.length >= 2 && letters === letters.toUpperCase();
  if (/\.$/.test(text) && !uppercase) {
    const titleWords = words.filter(
      (word) =>
        /^(?:a|an|and|as|at|by|for|from|in|no|of|on|or|the|to|with)$/i.test(word) ||
        /^[A-Z][A-Za-z'’-]*$/.test(word),
    );
    return words.length > 0 && words.length <= 12 && titleWords.length / words.length >= 0.75;
  }
  return uppercase || words.length <= 10;
}

function normalizeRecords(records) {
  return (records || [])
    .map((record, position) => ({
      ...record,
      position,
      index: Number.isInteger(record?.index) ? record.index : position,
      text: normalizeHeadingText(record?.text),
      headingCandidate: Boolean(record?.headingCandidate),
    }))
    .filter((record) => record.text);
}

function dominantMode(splitCount, combinedCount) {
  if (splitCount > 0 && combinedCount === 0) {
    return { mode: 'split', defaultMode: 'split' };
  }
  if (combinedCount > 0 && splitCount === 0) {
    return { mode: 'combined', defaultMode: 'combined' };
  }
  if (splitCount === 0 && combinedCount === 0) {
    return { mode: 'unknown', defaultMode: null };
  }

  const defaultMode = splitCount >= combinedCount * 2
    ? 'split'
    : combinedCount >= splitCount * 2
      ? 'combined'
      : null;
  return { mode: 'mixed', defaultMode };
}

function buildArticleHeadingLayout(records) {
  const normalized = normalizeRecords(records);
  const rulesByLabel = new Map();
  const kindsByIndex = new Map();
  const samples = [];
  let splitCount = 0;
  let combinedCount = 0;

  function addRule(rule) {
    samples.push(rule);
    const key = articleLabelKey(rule.label);
    if (!rulesByLabel.has(key)) {
      rulesByLabel.set(key, []);
    }
    rulesByLabel.get(key).push(rule);
  }

  for (let position = 0; position < normalized.length; position += 1) {
    const record = normalized[position];
    if (!record.headingCandidate) {
      continue;
    }

    const parsed = parseArticleHeading(record.text);
    if (!parsed) {
      continue;
    }

    if (parsed.caption && isLikelyHeadingCaption(parsed.caption)) {
      combinedCount += 1;
      kindsByIndex.set(record.index, 'article_combined');
      addRule({
        mode: 'combined',
        label: parsed.label,
        caption: parsed.caption,
        articleRecord: record,
        captionRecord: null,
      });
      continue;
    }

    if (parsed.caption) {
      continue;
    }

    const next = normalized[position + 1];
    if (next?.headingCandidate && isLikelyHeadingCaption(next.text)) {
      splitCount += 1;
      kindsByIndex.set(record.index, 'article_label');
      kindsByIndex.set(next.index, 'article_caption');
      addRule({
        mode: 'split',
        label: parsed.label,
        caption: next.text,
        articleRecord: record,
        captionRecord: next,
      });
    } else {
      kindsByIndex.set(record.index, 'article_label');
    }
  }

  const { mode, defaultMode } = dominantMode(splitCount, combinedCount);
  return {
    mode,
    defaultMode,
    splitCount,
    combinedCount,
    rulesByLabel,
    kindsByIndex,
    samples,
  };
}

function resolveArticleHeadingRule(layout, label) {
  if (!layout) {
    return null;
  }
  const exactRules = layout.rulesByLabel?.get(articleLabelKey(label)) || [];
  if (exactRules.length) {
    const modes = new Set(exactRules.map((rule) => rule.mode));
    return modes.size === 1 ? exactRules[0] : null;
  }

  const mode = layout.mode === 'split' || layout.mode === 'combined'
    ? layout.mode
    : layout.defaultMode;
  if (!mode) {
    return null;
  }
  return layout.samples.find((sample) => sample.mode === mode) || { mode, label, caption: '' };
}

module.exports = {
  articleLabelKey,
  buildArticleHeadingLayout,
  isLikelyHeadingCaption,
  isStandaloneArticleLabel,
  normalizeHeadingText,
  parseArticleHeading,
  resolveArticleHeadingRule,
};
