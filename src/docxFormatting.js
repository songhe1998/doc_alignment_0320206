'use strict';

const AdmZip = require('adm-zip');
const { XMLParser } = require('fast-xml-parser');

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
});
const SIGNATURE_FIELD_LABEL_REGEX = /^[（(](住所|所在地|代表者名|氏名|名称|会社名|役職|title|name|address)[）)]$/i;

function asArray(value) {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function getAttribute(node, name) {
  if (!node || typeof node !== 'object') {
    return null;
  }

  return node[`@_${name}`] ?? node[`@_${name.replace(/^w:/, '')}`] ?? node[name] ?? node[name.replace(/^w:/, '')] ?? null;
}

function getChild(node, ...names) {
  if (!node || typeof node !== 'object') {
    return undefined;
  }

  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(node, name)) {
      return node[name];
    }
  }

  return undefined;
}

function parseXml(xml) {
  return xmlParser.parse(xml);
}

function readZipText(filePath, entryName) {
  const zip = new AdmZip(filePath);
  const entry = zip.getEntry(entryName);
  if (!entry) {
    return '';
  }

  return entry.getData().toString('utf8');
}

function writeZipText(filePath, entryName, value) {
  const zip = new AdmZip(filePath);
  zip.updateFile(entryName, Buffer.from(value, 'utf8'));
  zip.writeZip(filePath);
}

function collectText(node) {
  if (node === undefined || node === null) {
    return '';
  }

  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }

  if (Array.isArray(node)) {
    return node.map(collectText).join('');
  }

  if (typeof node !== 'object') {
    return '';
  }

  let text = '';
  for (const [key, value] of Object.entries(node)) {
    if (key === 'w:t' || key === 't' || key === '#text') {
      text += collectText(value);
    } else if (key === 'w:tab' || key === 'tab') {
      text += '\t';
    } else if (key === 'w:br' || key === 'br' || key === 'w:cr' || key === 'cr') {
      text += '\n';
    } else if (!key.startsWith('@_') && key !== 'w:pPr' && key !== 'pPr') {
      text += collectText(value);
    }
  }

  return text;
}

function collectRuns(node) {
  if (!node || typeof node !== 'object') {
    return [];
  }

  if (Array.isArray(node)) {
    return node.flatMap(collectRuns);
  }

  const runs = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === 'w:r' || key === 'r') {
      runs.push(...asArray(value));
    } else if (!key.startsWith('@_') && key !== 'w:pPr' && key !== 'pPr') {
      runs.push(...collectRuns(value));
    }
  }

  return runs;
}

function isBooleanOn(node) {
  if (node === undefined || node === null) {
    return false;
  }

  if (typeof node !== 'object') {
    return true;
  }

  const value = getAttribute(node, 'w:val');
  return value === null || !['0', 'false', 'off'].includes(String(value).toLowerCase());
}

function readHalfPointSize(sizeNode) {
  const raw = getAttribute(sizeNode, 'w:val');
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function readSpacingValue(spacingNode, attribute) {
  const raw = getAttribute(spacingNode, attribute);
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function getParagraphs(documentXml) {
  const parsed = parseXml(documentXml);
  const documentNode = parsed['w:document'] || parsed.document || parsed;
  const body = documentNode['w:body'] || documentNode.body || {};
  return asArray(body['w:p'] || body.p);
}

function parseStyles(stylesXml) {
  if (!stylesXml) {
    return new Map();
  }

  const parsed = parseXml(stylesXml);
  const stylesNode = parsed['w:styles'] || parsed.styles || {};
  const styles = new Map();

  for (const style of asArray(stylesNode['w:style'] || stylesNode.style)) {
    if (getAttribute(style, 'w:type') !== 'paragraph') {
      continue;
    }

    const styleId = getAttribute(style, 'w:styleId');
    if (!styleId) {
      continue;
    }

    const rPr = style['w:rPr'] || style.rPr || {};
    const pPr = style['w:pPr'] || style.pPr || {};
    const styleNameNode = style['w:name'] || style.name || {};
    const basedOnNode = style['w:basedOn'] || style.basedOn || {};

    styles.set(styleId, {
      styleId,
      name: getAttribute(styleNameNode, 'w:val') || styleId,
      basedOn: getAttribute(basedOnNode, 'w:val'),
      alignment: getAttribute(pPr['w:jc'] || pPr.jc, 'w:val'),
      spacingBefore: readSpacingValue(pPr['w:spacing'] || pPr.spacing, 'w:before'),
      spacingAfter: readSpacingValue(pPr['w:spacing'] || pPr.spacing, 'w:after'),
      bold: isBooleanOn(getChild(rPr, 'w:b', 'b')),
      sizeHalfPoints: readHalfPointSize(rPr['w:sz'] || rPr.sz),
      hasNumbering: pPr['w:numPr'] || pPr.numPr ? true : undefined,
    });
  }

  return styles;
}

function resolveStyle(styleId, styles, seen = new Set()) {
  if (!styleId || seen.has(styleId)) {
    return {};
  }

  const style = styles.get(styleId);
  if (!style) {
    return {};
  }

  seen.add(styleId);
  return {
    ...resolveStyle(style.basedOn, styles, seen),
    ...Object.fromEntries(Object.entries(style).filter(([, value]) => value !== null && value !== undefined)),
  };
}

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) {
    return null;
  }

  return sorted[Math.floor(sorted.length / 2)];
}

function profileParagraph(paragraph, styles, previousWasBlank, index) {
  const pPr = paragraph['w:pPr'] || paragraph.pPr || {};
  const styleId = getAttribute(pPr['w:pStyle'] || pPr.pStyle, 'w:val');
  const style = resolveStyle(styleId, styles);
  const runs = collectRuns(paragraph);
  const runSizes = runs
    .map((run) => readHalfPointSize((run['w:rPr'] || run.rPr || {})['w:sz'] || (run['w:rPr'] || run.rPr || {}).sz))
    .filter((value) => value !== null);
  const pRunPr = pPr['w:rPr'] || pPr.rPr || {};
  const pSize = readHalfPointSize(pRunPr['w:sz'] || pRunPr.sz);
  const sizeHalfPoints = Math.max(...[style.sizeHalfPoints, pSize, ...runSizes].filter((value) => Number.isFinite(value)));
  const hasSize = Number.isFinite(sizeHalfPoints);
  const text = collectText(paragraph).replace(/\s+\n/g, '\n').trim();
  const isEmpty = text.length === 0;
  const directBold = runs.some((run) => isBooleanOn(getChild(run['w:rPr'] || run.rPr || {}, 'w:b', 'b')));
  const pBold = isBooleanOn(getChild(pRunPr, 'w:b', 'b'));
  const spacingNode = pPr['w:spacing'] || pPr.spacing || {};

  return {
    index,
    text,
    isEmpty,
    styleId,
    styleName: style.name || styleId || null,
    alignment: getAttribute(pPr['w:jc'] || pPr.jc, 'w:val') || style.alignment || null,
    spacingBefore: readSpacingValue(spacingNode, 'w:before') ?? style.spacingBefore ?? null,
    spacingAfter: readSpacingValue(spacingNode, 'w:after') ?? style.spacingAfter ?? null,
    blankBefore: Boolean(previousWasBlank),
    bold: Boolean(directBold || pBold || style.bold),
    sizeHalfPoints: hasSize ? sizeHalfPoints : null,
    fontSizePt: hasSize ? sizeHalfPoints / 2 : null,
    hasNumbering: Boolean(pPr['w:numPr'] || pPr.numPr || style.hasNumbering),
  };
}

function annotateParagraphRoles(profiles) {
  const sizes = profiles.filter((profile) => !profile.isEmpty).map((profile) => profile.fontSizePt);
  const normalSize = median(sizes) || 11;
  let foundTitle = false;

  return profiles.map((profile) => {
    if (profile.isEmpty) {
      return { ...profile, role: 'blank' };
    }

    const styleName = `${profile.styleName || ''} ${profile.styleId || ''}`;
    const headingStyle = /heading|title|subtitle|見出し|標題|題名|表題/i.test(styleName);
    const parentheticalHeading =
      /^[（(][^）)]{2,80}[）)]$/.test(profile.text) && !SIGNATURE_FIELD_LABEL_REGEX.test(profile.text);
    const largeText = profile.fontSizePt !== null && profile.fontSizePt >= normalSize + 2;
    const shortText = profile.text.length <= 80;

    if (!foundTitle) {
      const titleLike =
        /title|標題|題名|表題/i.test(styleName) ||
        profile.alignment === 'center' ||
        largeText ||
        shortText;
      if (titleLike) {
        foundTitle = true;
        return { ...profile, role: 'title' };
      }
    }

    const headingLike =
      headingStyle ||
      parentheticalHeading ||
      (shortText && profile.bold && !/[。.]$/.test(profile.text)) ||
      /^ARTICLE\s+\S+/i.test(profile.text) ||
      (/^第[0-9０-９一二三四五六七八九十百]+[条章節]/.test(profile.text) && shortText && !/[。.]$/.test(profile.text));

    return {
      ...profile,
      role: headingLike ? 'heading' : 'paragraph',
    };
  });
}

function extractDocxParagraphProfiles(filePath) {
  const documentXml = readZipText(filePath, 'word/document.xml');
  if (!documentXml) {
    return [];
  }

  const styles = parseStyles(readZipText(filePath, 'word/styles.xml'));
  let previousWasBlank = false;
  const profiles = getParagraphs(documentXml).map((paragraph, index) => {
    const profile = profileParagraph(paragraph, styles, previousWasBlank, index);
    previousWasBlank = profile.isEmpty;
    return profile;
  });

  return annotateParagraphRoles(profiles);
}

function formatProfileLine(profile) {
  if (profile.role === 'blank') {
    return '[BLANK LINE]';
  }

  const attributes = [profile.role.toUpperCase()];
  if (profile.blankBefore) {
    attributes.push('blank-line-before');
  }
  if (profile.alignment && profile.alignment !== 'left') {
    attributes.push(`align=${profile.alignment}`);
  }
  if (profile.fontSizePt) {
    attributes.push(`font=${profile.fontSizePt}pt`);
  }
  if (profile.bold) {
    attributes.push('bold');
  }
  if (profile.styleName) {
    attributes.push(`style="${profile.styleName}"`);
  }
  if (profile.spacingBefore !== null) {
    attributes.push(`space-before=${profile.spacingBefore}`);
  }
  if (profile.spacingAfter !== null) {
    attributes.push(`space-after=${profile.spacingAfter}`);
  }

  return `[${attributes.join(' ')}] ${profile.text}`;
}

function buildDocxFormatOutline(filePath) {
  const profiles = extractDocxParagraphProfiles(filePath);
  const lines = profiles.map(formatProfileLine).filter(Boolean);

  return lines.join('\n');
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function ensureParagraphProperties(paragraphXml) {
  if (/<w:pPr[\s/>]/.test(paragraphXml)) {
    return paragraphXml;
  }

  return paragraphXml.replace(/(<w:p\b[^>]*>)/, '$1<w:pPr/>');
}

function updateParagraphProperty(paragraphXml, tagName, elementXml) {
  const ensured = ensureParagraphProperties(paragraphXml);
  return ensured.replace(/<w:pPr\b([^>]*)>([\s\S]*?)<\/w:pPr>|<w:pPr\b([^>]*)\/>/, (match, attrs = '', contents = '', selfClosingAttrs = '') => {
    const existingContents = contents || '';
    const cleanContents = existingContents.replace(new RegExp(`<${tagName}\\b[\\s\\S]*?</${tagName}>|<${tagName}\\b[\\s\\S]*?\\/>`), '');
    const finalAttrs = attrs || selfClosingAttrs || '';
    return `<w:pPr${finalAttrs}>${elementXml}${cleanContents}</w:pPr>`;
  });
}

function removeParagraphProperty(paragraphXml, tagName) {
  if (!/<w:pPr[\s/>]/.test(paragraphXml)) {
    return paragraphXml;
  }

  return paragraphXml.replace(/<w:pPr\b([^>]*)>([\s\S]*?)<\/w:pPr>|<w:pPr\b([^>]*)\/>/, (match, attrs = '', contents = '', selfClosingAttrs = '') => {
    const existingContents = contents || '';
    const cleanContents = existingContents.replace(new RegExp(`<${tagName}\\b[\\s\\S]*?</${tagName}>|<${tagName}\\b[\\s\\S]*?\\/>`), '');
    const finalAttrs = attrs || selfClosingAttrs || '';
    return `<w:pPr${finalAttrs}>${cleanContents}</w:pPr>`;
  });
}

function updateRunProperty(runXml, tagName, elementXml) {
  if (/<w:rPr[\s/>]/.test(runXml)) {
    return runXml.replace(/<w:rPr\b([^>]*)>([\s\S]*?)<\/w:rPr>|<w:rPr\b([^>]*)\/>/, (match, attrs = '', contents = '', selfClosingAttrs = '') => {
      const existingContents = contents || '';
      const cleanContents = existingContents.replace(new RegExp(`<${tagName}\\b[\\s\\S]*?\\/>|<${tagName}\\b[\\s\\S]*?</${tagName}>`), '');
      const finalAttrs = attrs || selfClosingAttrs || '';
      return `<w:rPr${finalAttrs}>${elementXml}${cleanContents}</w:rPr>`;
    });
  }

  return runXml.replace(/(<w:r\b[^>]*>)/, `$1<w:rPr>${elementXml}</w:rPr>`);
}

function removeRunProperty(runXml, tagName) {
  if (!/<w:rPr[\s/>]/.test(runXml)) {
    return runXml;
  }

  return runXml.replace(/<w:rPr\b([^>]*)>([\s\S]*?)<\/w:rPr>|<w:rPr\b([^>]*)\/>/, (match, attrs = '', contents = '', selfClosingAttrs = '') => {
    const existingContents = contents || '';
    const cleanContents = existingContents.replace(new RegExp(`<${tagName}\\b[\\s\\S]*?\\/>|<${tagName}\\b[\\s\\S]*?</${tagName}>`), '');
    const finalAttrs = attrs || selfClosingAttrs || '';
    return `<w:rPr${finalAttrs}>${cleanContents}</w:rPr>`;
  });
}

function demoteSignatureFieldParagraph(paragraphXml) {
  let patched = removeParagraphProperty(paragraphXml, 'w:pStyle');
  patched = patched.replace(/<w:r\b[\s\S]*?<\/w:r>/g, (runXml) => {
    let cleanRun = removeRunProperty(runXml, 'w:b');
    cleanRun = removeRunProperty(cleanRun, 'w:bCs');
    cleanRun = removeRunProperty(cleanRun, 'w:sz');
    return removeRunProperty(cleanRun, 'w:szCs');
  });
  return patched;
}

function applyTextRunProperties(paragraphXml, profile) {
  let patched = paragraphXml;

  if (profile.bold) {
    patched = patched.replace(/<w:r\b[\s\S]*?<\/w:r>/g, (runXml) => {
      const withBold = updateRunProperty(runXml, 'w:b', '<w:b/>');
      return updateRunProperty(withBold, 'w:bCs', '<w:bCs/>');
    });
  }

  if (profile.sizeHalfPoints) {
    const size = xmlEscape(profile.sizeHalfPoints);
    patched = patched.replace(/<w:r\b[\s\S]*?<\/w:r>/g, (runXml) => {
      const withSize = updateRunProperty(runXml, 'w:sz', `<w:sz w:val="${size}"/>`);
      return updateRunProperty(withSize, 'w:szCs', `<w:szCs w:val="${size}"/>`);
    });
  }

  return patched;
}

function applyParagraphProfile(paragraphXml, profile) {
  let patched = paragraphXml;

  if (profile.styleId && !profile.hasNumbering) {
    patched = updateParagraphProperty(patched, 'w:pStyle', `<w:pStyle w:val="${xmlEscape(profile.styleId)}"/>`);
  } else {
    patched = removeParagraphProperty(patched, 'w:pStyle');
    patched = removeParagraphProperty(patched, 'w:numPr');
  }

  if (profile.alignment) {
    patched = updateParagraphProperty(patched, 'w:jc', `<w:jc w:val="${xmlEscape(profile.alignment)}"/>`);
  }

  if (profile.spacingBefore !== null || profile.spacingAfter !== null) {
    const attrs = [];
    if (profile.spacingBefore !== null) {
      attrs.push(`w:before="${xmlEscape(profile.spacingBefore)}"`);
    }
    if (profile.spacingAfter !== null) {
      attrs.push(`w:after="${xmlEscape(profile.spacingAfter)}"`);
    }
    patched = updateParagraphProperty(patched, 'w:spacing', `<w:spacing ${attrs.join(' ')}/>`);
  }

  return applyTextRunProperties(patched, profile);
}

function extractParagraphXml(documentXml) {
  const matches = [];
  const paragraphRegex = /<w:p\b[\s\S]*?<\/w:p>|<w:p\b[^>]*\/>/g;
  let match;
  while ((match = paragraphRegex.exec(documentXml)) !== null) {
    matches.push({
      start: match.index,
      end: paragraphRegex.lastIndex,
      xml: match[0],
    });
  }
  return matches;
}

function profileParagraphXml(paragraphXml, index) {
  const parsed = parseXml(paragraphXml);
  const paragraph = parsed['w:p'] || parsed.p || {};
  return annotateParagraphRoles([profileParagraph(paragraph, new Map(), false, index)])[0];
}

function chooseTemplateProfiles(templateProfiles) {
  const nonEmpty = templateProfiles.filter((profile) => !profile.isEmpty);
  const title = nonEmpty.find((profile) => profile.role === 'title') || nonEmpty[0] || null;
  const heading =
    nonEmpty.find((profile) => profile.role === 'heading' && /^[（(]/.test(profile.text)) ||
    nonEmpty.find((profile) => profile.role === 'heading') ||
    null;

  return { title, heading };
}

function isOutputHeading(profile) {
  if (profile.role === 'heading') {
    return true;
  }

  if (profile.isEmpty) {
    return false;
  }

  return (
    (/^[（(][^）)]{2,100}[）)]$/.test(profile.text) && !SIGNATURE_FIELD_LABEL_REGEX.test(profile.text)) ||
    /^ARTICLE\s+\S+/i.test(profile.text) ||
    (/^第[0-9０-９一二三四五六七八九十百]+[条章節]/.test(profile.text) &&
      profile.text.length <= 80 &&
      !/[。.]$/.test(profile.text))
  );
}

function applyTemplateDocxFormatting(outputPath, templatePath) {
  const templateProfiles = extractDocxParagraphProfiles(templatePath);
  const { title, heading } = chooseTemplateProfiles(templateProfiles);

  if (!title && !heading) {
    return false;
  }

  const documentXml = readZipText(outputPath, 'word/document.xml');
  if (!documentXml) {
    return false;
  }

  const outputProfiles = extractDocxParagraphProfiles(outputPath);
  const paragraphMatches = extractParagraphXml(documentXml);
  let nonEmptySeen = 0;
  let result = '';
  let lastIndex = 0;

  for (let i = 0; i < paragraphMatches.length; i += 1) {
    const match = paragraphMatches[i];
    const currentProfile = profileParagraphXml(match.xml, i);
    const outputProfile = outputProfiles[i] || {};
    const profile = {
      ...outputProfile,
      text: currentProfile.text,
      isEmpty: currentProfile.isEmpty,
      role: currentProfile.role === 'paragraph' && outputProfile.role ? outputProfile.role : currentProfile.role,
    };
    let paragraphXml = match.xml;
    let prefix = '';

    result += documentXml.slice(lastIndex, match.start);

    if (profile && !profile.isEmpty) {
      nonEmptySeen += 1;
      if (nonEmptySeen === 1 && title) {
        paragraphXml = applyParagraphProfile(paragraphXml, title);
      } else if (SIGNATURE_FIELD_LABEL_REGEX.test(profile.text)) {
        paragraphXml = demoteSignatureFieldParagraph(paragraphXml);
      } else if (heading && isOutputHeading(profile)) {
        if (heading.blankBefore) {
          prefix = '<w:p/>';
        }
        paragraphXml = applyParagraphProfile(paragraphXml, heading);
      }
    }

    result += prefix + paragraphXml;
    lastIndex = match.end;
  }

  result += documentXml.slice(lastIndex);
  writeZipText(outputPath, 'word/document.xml', result);
  return true;
}

module.exports = {
  applyTemplateDocxFormatting,
  buildDocxFormatOutline,
  extractDocxParagraphProfiles,
};
