'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dotenv = require('dotenv');
const OpenAI = require('openai');

const {
  buildAlignmentInstructions,
  buildTaskBrief,
  buildVerifiedAlignmentInstructions,
  buildVerifiedAlignmentBrief,
  buildVisualRepairInstructions,
  buildVisualRepairBrief,
} = require('./alignmentPrompt');
const {
  applyTemplateDocxFormatting,
  extractDocxParagraphProfiles,
} = require('./docxFormatting');
const { loadDocumentText, loadTemplatePromptText } = require('./documentLoader');
const { extractPdfLineProfiles } = require('./pdfFormatting');
const {
  resolveVisualCheckOptions,
  runRenderedVisualCheck,
  shouldRunVisualCheck,
  summarizeVisualReport,
} = require('./visualChecker');

dotenv.config({ quiet: true });

const VALID_FORMATS = new Set(['markdown', 'latex', 'docx', 'pdf']);
const VALID_REASONING = new Set(['none', 'low', 'medium', 'high', 'xhigh']);
const MODEL_FALLBACK_ORDER = ['gpt-5.4', 'gpt-5.2', 'gpt-5', 'gpt-5-mini', 'gpt-5-nano'];
const JAPANESE_OR_CJK_REGEX = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const JAPANESE_PDF_FONT_CANDIDATES = {
  serif: [
    'Hiragino Mincho ProN',
    'Hiragino Mincho Pro',
    'Yu Mincho',
    'Noto Serif CJK JP',
    'Source Han Serif JP',
    'IPAexMincho',
    'BIZ UDPMincho',
    'Arial Unicode MS',
  ],
  sans: [
    'Hiragino Sans',
    'Hiragino Kaku Gothic ProN',
    'Yu Gothic',
    'Noto Sans CJK JP',
    'Source Han Sans JP',
    'IPAexGothic',
    'BIZ UDPGothic',
    'Arial Unicode MS',
  ],
  mono: [
    'Noto Sans Mono CJK JP',
    'Noto Sans Mono',
    'DejaVu Sans Mono',
    'Liberation Mono',
    'Menlo',
    'Courier New',
    'Osaka-Mono',
  ],
};
const OUTPUT_FORMAT_TO_EXTENSION = {
  markdown: '.md',
  latex: '.tex',
  docx: '.docx',
  pdf: '.pdf',
};
const ARTICLE_TITLE_PREFIX_REGEX =
  /^(第[0-9０-９一二三四五六七八九十百]+[条章節]|ARTICLE\s+[0-9IVXLCDM]+|Section\s+[0-9.]+)\s*[：:．.\-–—　\s]+(.+)$/i;
const LEGAL_TITLE_REMAINDER_REGEX =
  /(契約書|合意書|覚書|規約|約款|Agreement|Contract|NDA|Non[-\s]?Disclosure|Disclosure|Confidentiality|License|Terms|Policy|Statement|Addendum|Amendment)/i;
const EXTENSION_TO_OUTPUT_FORMAT = new Map([
  ['.md', 'markdown'],
  ['.markdown', 'markdown'],
  ['.txt', 'markdown'],
  ['.text', 'markdown'],
  ['.tex', 'latex'],
  ['.docx', 'docx'],
  ['.pdf', 'pdf'],
]);

function createLogger(logger = console) {
  return {
    info: typeof logger.info === 'function' ? logger.info.bind(logger) : () => {},
    warn: typeof logger.warn === 'function' ? logger.warn.bind(logger) : () => {},
  };
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function ensureReadableFile(filePath, label) {
  const resolved = path.resolve(filePath);
  const stat = fs.statSync(resolved, { throwIfNoEntry: false });

  if (!stat || !stat.isFile()) {
    throw new Error(`${label} not found: ${resolved}`);
  }

  return resolved;
}

function normalizeFormat(value) {
  if (!value) {
    return null;
  }

  const format = value.toLowerCase();
  if (format === 'auto') {
    return null;
  }

  if (!VALID_FORMATS.has(format)) {
    throw new Error(`Invalid format value: ${value}`);
  }
  return format;
}

function normalizeReasoning(value) {
  const reasoning = (value || process.env.OPENAI_REASONING_EFFORT || 'medium').toLowerCase();
  if (!VALID_REASONING.has(reasoning)) {
    throw new Error(`Invalid reasoning value: ${value}`);
  }
  return reasoning;
}

function normalizeMaxOutputTokens(value) {
  const raw = value || process.env.OPENAI_MAX_OUTPUT_TOKENS || '12000';
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid max output tokens value: ${raw}`);
  }
  return parsed;
}

function combineUsages(usages) {
  return usages.reduce(
    (combined, usage) => ({
      input_tokens: combined.input_tokens + (usage?.input_tokens || 0),
      output_tokens: combined.output_tokens + (usage?.output_tokens || 0),
      total_tokens: combined.total_tokens + (usage?.total_tokens || 0),
    }),
    { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  );
}

function hasUsage(usage) {
  return Boolean(usage?.input_tokens || usage?.output_tokens || usage?.total_tokens);
}

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) {
    return null;
  }

  return sorted[Math.floor(sorted.length / 2)];
}

function containsJapaneseOrCjk(text) {
  return JAPANESE_OR_CJK_REGEX.test(text || '');
}

function detectLanguageProfile(sourceText, templateText) {
  const templateHasJapanese = containsJapaneseOrCjk(templateText);
  const sourceHasJapanese = containsJapaneseOrCjk(sourceText);

  return {
    sourceHasJapanese,
    templateHasJapanese,
    templateLanguage: templateHasJapanese ? 'japanese' : 'default',
  };
}

function commandExists(command) {
  try {
    childProcess.execFileSync('sh', ['-lc', `command -v ${command}`], { stdio: 'ignore' });
    return true;
  } catch (error) {
    return false;
  }
}

function ensurePandoc() {
  try {
    childProcess.execFileSync('pandoc', ['--version'], { stdio: 'ignore' });
  } catch (error) {
    throw new Error('Pandoc-based output requires pandoc to be installed and available on PATH.');
  }
}

function resolvePdfEngine(value) {
  const engine = (value || process.env.PANDOC_PDF_ENGINE || '').trim();
  if (!engine || engine.toLowerCase() === 'auto') {
    return null;
  }

  return engine;
}

let cachedFontCatalog = null;

function listFontCatalog() {
  if (cachedFontCatalog !== null) {
    return cachedFontCatalog;
  }

  try {
    const output = childProcess.execFileSync('fc-list', [':', 'family'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    cachedFontCatalog = output;
    return cachedFontCatalog;
  } catch (error) {
    cachedFontCatalog = null;
    return cachedFontCatalog;
  }
}

function resolveInstalledFont(candidates, fontCatalog = listFontCatalog()) {
  if (fontCatalog === null) {
    return candidates[0] || null;
  }

  const catalog = String(fontCatalog || '').toLowerCase();
  for (const candidate of candidates) {
    if (catalog.includes(candidate.toLowerCase())) {
      return candidate;
    }
  }

  return null;
}

function resolveJapanesePdfProfile() {
  const serif = resolveInstalledFont(JAPANESE_PDF_FONT_CANDIDATES.serif);
  const sans = resolveInstalledFont(JAPANESE_PDF_FONT_CANDIDATES.sans);
  const mono = resolveInstalledFont(JAPANESE_PDF_FONT_CANDIDATES.mono);

  return { serif, sans, mono };
}

function resolvePdfConversionOptions({ explicitPdfEngine, markdown, sourceText, templateText }) {
  const engineOverride = resolvePdfEngine(explicitPdfEngine);
  if (engineOverride) {
    const shouldWarn = containsJapaneseOrCjk(markdown) && engineOverride === 'pdflatex';
    return {
      engine: engineOverride,
      isJapaneseAware: false,
      fontProfile: null,
      warning: shouldWarn
        ? 'Japanese/CJK content detected while using pdflatex. If PDF generation fails or glyphs are missing, try --pdf-engine xelatex.'
        : null,
    };
  }

  const hasJapaneseContent =
    containsJapaneseOrCjk(markdown) || containsJapaneseOrCjk(sourceText) || containsJapaneseOrCjk(templateText);

  if (commandExists('xelatex')) {
    return {
      engine: 'xelatex',
      isJapaneseAware: hasJapaneseContent,
      fontProfile: hasJapaneseContent ? resolveJapanesePdfProfile() : null,
      warning: null,
    };
  }

  if (commandExists('lualatex')) {
    return {
      engine: 'lualatex',
      isJapaneseAware: hasJapaneseContent,
      fontProfile: hasJapaneseContent ? resolveJapanesePdfProfile() : null,
      warning: null,
    };
  }

  return {
    engine: 'pdflatex',
    isJapaneseAware: false,
    fontProfile: null,
    warning: null,
  };
}

function inferFormatFromExtension(filePath) {
  if (!filePath) {
    return null;
  }

  return EXTENSION_TO_OUTPUT_FORMAT.get(path.extname(filePath).toLowerCase()) || null;
}

function sanitizeStem(filePath) {
  return path
    .parse(filePath)
    .name
    .replace(/[\\/]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function inferOutputFormat({ explicitFormat, outputArg, sourcePath, templatePath }) {
  if (explicitFormat) {
    return explicitFormat;
  }

  const fromOutput = inferFormatFromExtension(outputArg);
  if (fromOutput) {
    return fromOutput;
  }

  const fromTemplate = inferFormatFromExtension(templatePath);
  if (fromTemplate) {
    return fromTemplate;
  }

  const fromSource = inferFormatFromExtension(sourcePath);
  if (fromSource) {
    return fromSource;
  }

  return 'markdown';
}

function buildDefaultOutputFilename(sourcePath, templatePath, outputFormat) {
  const sourceStem = sanitizeStem(sourcePath);
  const templateStem = sanitizeStem(templatePath);
  return `${sourceStem}-aligned-to-${templateStem}${OUTPUT_FORMAT_TO_EXTENSION[outputFormat]}`;
}

function unwrapSimpleMarkdownLine(line) {
  const headingMatch = line.match(/^(\s{0,3}(?:#{1,6}\s*)?)(.*)$/);
  const headingPrefix = headingMatch ? headingMatch[1] : '';
  let body = headingMatch ? headingMatch[2] : line;
  let emphasisPrefix = '';
  let emphasisSuffix = '';

  const boldMatch = body.match(/^(\*\*|__)(.+)\1\s*$/);
  if (boldMatch) {
    emphasisPrefix = boldMatch[1];
    emphasisSuffix = boldMatch[1];
    body = boldMatch[2];
  }

  return {
    prefix: headingPrefix + emphasisPrefix,
    body,
    suffix: emphasisSuffix,
  };
}

function isTitleLikeArticleRemainder(value) {
  const text = value.trim();
  if (!text || text.length > 120) {
    return false;
  }

  if (/^[（(][^）)]{1,80}[）)]$/.test(text)) {
    return false;
  }

  if (/[。.!?！？]$/.test(text)) {
    return false;
  }

  return LEGAL_TITLE_REMAINDER_REGEX.test(text);
}

function sanitizeTitleArticleCollision(line) {
  const { prefix, body, suffix } = unwrapSimpleMarkdownLine(line);
  const match = body.trim().match(ARTICLE_TITLE_PREFIX_REGEX);
  if (!match || !isTitleLikeArticleRemainder(match[2])) {
    return line;
  }

  return `${prefix}${match[2].trim()}${suffix}`;
}

function removeHtmlAlignmentWrappers(documentText) {
  return String(documentText || '')
    .replace(/^\s*<div\s+align=["']?center["']?\s*>\s*([\s\S]*?)\s*<\/div>\s*$/gim, '$1')
    .replace(/^\s*<center\s*>\s*([\s\S]*?)\s*<\/center>\s*$/gim, '$1')
    .replace(/^\s*<div\s+align=["']?center["']?\s*>\s*$/gim, '')
    .replace(/^\s*<\/div>\s*$/gim, '')
    .replace(/^\s*<center\s*>\s*$/gim, '')
    .replace(/^\s*<\/center>\s*$/gim, '');
}

function isSplitNumberHeadingLine(value) {
  return /^[0-9０-９]+[.)．。]$/.test(String(value || '').trim());
}

function isShortHeadingText(value) {
  const text = stripInlineMarkdown(value);
  if (!text || text.length > 140) {
    return false;
  }

  if (/^(whereas|now,?\s+therefore|this agreement|the purpose|for purposes)\b/i.test(text)) {
    return false;
  }

  return /[A-Za-z\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/.test(text);
}

function normalizeSplitNumberedHeadings(documentText) {
  const lines = String(documentText || '').split('\n');
  const normalized = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!isSplitNumberHeadingLine(line)) {
      normalized.push(line);
      continue;
    }

    let headingIndex = index + 1;
    while (headingIndex < lines.length && !lines[headingIndex].trim()) {
      headingIndex += 1;
    }

    if (headingIndex < lines.length && isShortHeadingText(lines[headingIndex])) {
      normalized.push(`**${line.trim()} ${stripInlineMarkdown(lines[headingIndex])}**`);
      index = headingIndex;
      continue;
    }

    normalized.push(line);
  }

  return normalized.join('\n');
}

function sanitizeGeneratedDocumentStructure(documentText) {
  const strippedText = normalizeSplitNumberedHeadings(removeHtmlAlignmentWrappers(documentText));
  const lines = strippedText.split('\n');
  const firstNonEmptyIndex = lines.findIndex((line) => line.trim());
  if (firstNonEmptyIndex === -1) {
    return strippedText;
  }

  const original = lines[firstNonEmptyIndex];
  const sanitized = sanitizeTitleArticleCollision(original);
  lines[firstNonEmptyIndex] = sanitized;
  const result = lines.join('\n');
  return result === documentText ? documentText : result;
}

function stripInlineMarkdown(value) {
  return String(value || '')
    .trim()
    .replace(/^(\*\*|__)([\s\S]+)\1$/, '$2')
    .replace(/^(\*|_)([\s\S]+)\1$/, '$2')
    .trim();
}

function escapeLatexText(value) {
  return String(value || '')
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/&/g, '\\&')
    .replace(/%/g, '\\%')
    .replace(/\$/g, '\\$')
    .replace(/#/g, '\\#')
    .replace(/_/g, '\\_')
    .replace(/{/g, '\\{')
    .replace(/}/g, '\\}')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}');
}

function resolveLatexTitleSize(fontSizePt) {
  if (!Number.isFinite(fontSizePt)) {
    return '\\Large';
  }
  if (fontSizePt >= 18) {
    return '\\huge';
  }
  if (fontSizePt >= 16) {
    return '\\LARGE';
  }
  if (fontSizePt >= 14) {
    return '\\Large';
  }
  return '\\large';
}

function renderCenteredLatexBlock(text, { sizeCommand = '\\Large', bold = true } = {}) {
  const boldCommand = bold ? '\\bfseries ' : '';
  return [
    '\\begin{center}',
    `{${sizeCommand} ${boldCommand}${escapeLatexText(text)}\\par}`,
    '\\end{center}',
  ].join('\n');
}

function renderLatexStyledLine(text, { fontSizePt = 10, bold = false, alignment = 'left' } = {}) {
  const size = Number.isFinite(fontSizePt) ? Math.max(8, Math.min(24, fontSizePt)) : 10;
  const leading = Math.max(size * 1.2, size + 2);
  const boldCommand = bold ? '\\bfseries ' : '';
  const body = `{\\fontsize{${formatLatexNumber(size)}pt}{${formatLatexNumber(leading)}pt}\\selectfont ${boldCommand}${escapeLatexText(text)}\\par}`;

  if (alignment === 'center') {
    return ['\\begin{center}', body, '\\end{center}'].join('\n');
  }

  if (alignment === 'right') {
    return ['\\begin{flushright}', body, '\\end{flushright}'].join('\n');
  }

  return `\\noindent${body}`;
}

function formatLatexNumber(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

function isArticleOrSectionLine(value) {
  return /^(?:第[0-9０-９一二三四五六七八九十百]+[条章節]|ARTICLE\s+[0-9IVXLCDM]+|Section\s+[0-9.]+)/i.test(
    stripInlineMarkdown(value),
  );
}

function isStandaloneArticleLabel(value) {
  return /^(?:第[0-9０-９一二三四五六七八九十百]+[条章節]|ARTICLE\s+[0-9IVXLCDM]+|Section\s+[0-9.]+)$/i.test(
    stripInlineMarkdown(value),
  );
}

function headingLineParts(line) {
  const match = String(line || '').match(/^(\s{0,3})(#{1,6})\s+(.+?)\s*$/);
  if (!match) {
    return null;
  }

  return {
    indent: match[1],
    marker: match[2],
    level: match[2].length,
    text: stripInlineMarkdown(match[3]),
  };
}

function normalizeSplitArticleHeadingsForPdf(markdown) {
  const lines = String(markdown || '').split('\n');
  const normalized = [];

  for (let index = 0; index < lines.length; index += 1) {
    const parts = headingLineParts(lines[index]);
    if (!parts || !isStandaloneArticleLabel(parts.text)) {
      normalized.push(lines[index]);
      continue;
    }

    let nextIndex = index + 1;
    while (nextIndex < lines.length && !lines[nextIndex].trim()) {
      nextIndex += 1;
    }

    const nextParts = nextIndex < lines.length ? headingLineParts(lines[nextIndex]) : null;
    if (nextParts && nextParts.level >= parts.level && isShortHeadingText(nextParts.text)) {
      normalized.push(`${parts.indent}${parts.marker} ${parts.text} ${nextParts.text}`);
      index = nextIndex;
      continue;
    }

    normalized.push(lines[index]);
  }

  return normalized.join('\n');
}

function centerOpeningLinesForPdf(markdown, openingProfiles) {
  const titleProfile = openingProfiles?.title || null;
  if (!titleProfile || titleProfile.alignment !== 'center') {
    return markdown;
  }

  const lines = String(markdown || '').split('\n');
  const firstNonEmptyIndex = lines.findIndex((line) => line.trim());
  if (firstNonEmptyIndex === -1 || /^\\begin\{center\}/.test(lines[firstNonEmptyIndex].trim())) {
    return markdown;
  }

  const headingMatch = lines[firstNonEmptyIndex].match(/^\s{0,3}#{1,6}\s+(.+)$/);
  const titleText = stripInlineMarkdown(headingMatch ? headingMatch[1] : lines[firstNonEmptyIndex]);
  if (!titleText) {
    return markdown;
  }

  const sizeCommand = resolveLatexTitleSize(titleProfile.fontSizePt);
  lines[firstNonEmptyIndex] = renderCenteredLatexBlock(titleText, { sizeCommand, bold: true });

  const subtitleProfile = openingProfiles?.subtitle || null;
  if (subtitleProfile?.alignment === 'center') {
    const subtitleIndex = lines.findIndex((line, index) => index > firstNonEmptyIndex && line.trim());
    const subtitleText = subtitleIndex === -1 ? '' : stripInlineMarkdown(lines[subtitleIndex]);
    if (subtitleText && subtitleText.length <= 160 && !isArticleOrSectionLine(subtitleText)) {
      lines[subtitleIndex] = renderCenteredLatexBlock(subtitleText, {
        sizeCommand: resolveLatexTitleSize(subtitleProfile.fontSizePt || 11),
        bold: Boolean(subtitleProfile.bold || subtitleProfile.role === 'heading'),
      });
    }
  }

  return lines.join('\n');
}

function templateUsesModestHeading(profile, normalFontSizePt) {
  if (!profile) {
    return false;
  }

  const normalSize = Number.isFinite(normalFontSizePt) ? normalFontSizePt : 10;
  const fontSize = Number.isFinite(profile.fontSizePt) ? profile.fontSizePt : normalSize;
  return fontSize <= normalSize + 1.25 && !profile.bold;
}

function applyModestPdfHeadingStyle(markdown, layout) {
  const titleProfile = layout?.title || null;
  const headingProfile = layout?.heading || null;
  const normalFontSizePt = layout?.normalFontSizePt || null;
  const modestTitle = templateUsesModestHeading(titleProfile, normalFontSizePt);
  const modestHeading = templateUsesModestHeading(headingProfile, normalFontSizePt);

  if (!modestTitle && !modestHeading) {
    return markdown;
  }

  const lines = String(markdown || '').split('\n');
  let firstHeadingSeen = false;

  return lines
    .map((line) => {
      const parts = headingLineParts(line);
      if (!parts) {
        return line;
      }

      if (!firstHeadingSeen) {
        firstHeadingSeen = true;
        if (modestTitle) {
          return renderLatexStyledLine(parts.text, {
            fontSizePt: titleProfile.fontSizePt || normalFontSizePt || 10,
            bold: Boolean(titleProfile.bold),
            alignment: titleProfile.alignment || 'left',
          });
        }
        return line;
      }

      if (modestHeading) {
        return renderLatexStyledLine(parts.text, {
          fontSizePt: headingProfile.fontSizePt || normalFontSizePt || 10,
          bold: Boolean(headingProfile.bold),
          alignment: headingProfile.alignment || 'left',
        });
      }

      return line;
    })
    .join('\n');
}

function isCenteredSubtitleProfile(profile) {
  if (!profile || profile.isEmpty || profile.alignment !== 'center') {
    return false;
  }

  if (profile.text.length > 160 || /^[。.!?！？]/.test(profile.text)) {
    return false;
  }

  return profile.role === 'heading' || profile.bold || Number.isFinite(profile.fontSizePt);
}

function getTemplateOpeningProfiles(templatePath) {
  const extension = path.extname(templatePath).toLowerCase();

  try {
    let profiles = [];
    if (extension === '.docx') {
      profiles = extractDocxParagraphProfiles(templatePath);
    } else if (extension === '.pdf') {
      profiles = extractPdfLineProfiles(templatePath);
    }

    const nonEmpty = profiles.filter((profile) => !profile.isEmpty);
    const titleIndex = nonEmpty.findIndex((profile) => profile.role === 'title');
    const title = titleIndex === -1 ? null : nonEmpty[titleIndex];
    const subtitle = titleIndex === -1 ? null : nonEmpty.slice(titleIndex + 1, titleIndex + 4).find(isCenteredSubtitleProfile) || null;
    return { title, subtitle };
  } catch (error) {
    return { title: null, subtitle: null };
  }

  return { title: null, subtitle: null };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function resolvePdfTemplateLayout(templatePath) {
  if (path.extname(templatePath).toLowerCase() !== '.pdf') {
    return null;
  }

  try {
    const profiles = extractPdfLineProfiles(templatePath).filter((profile) => profile.text && profile.page === 1);
    if (!profiles.length) {
      return null;
    }

    const paragraphProfiles = profiles.filter((profile) => profile.role === 'paragraph');
    const contentProfiles = paragraphProfiles.length ? paragraphProfiles : profiles;
    const pageWidth = profiles[0].pageWidth || 612;
    const pageHeight = profiles[0].pageHeight || 792;
    const left = Math.min(...contentProfiles.map((profile) => profile.x0).filter(Number.isFinite));
    const right = Math.max(...contentProfiles.map((profile) => profile.x1).filter(Number.isFinite));
    const top = Math.min(...profiles.map((profile) => profile.y0).filter(Number.isFinite));
    const normalFontSizePt = median(paragraphProfiles.map((profile) => profile.fontSizePt)) || median(profiles.map((profile) => profile.fontSizePt)) || 10;
    const nonEmpty = profiles.filter((profile) => !profile.isEmpty);
    const title = nonEmpty.find((profile) => profile.role === 'title') || null;
    const heading = nonEmpty.find((profile) => profile.role === 'heading') || null;

    if (!Number.isFinite(left) || !Number.isFinite(right) || !Number.isFinite(top)) {
      return { title, heading, normalFontSizePt };
    }

    return {
      title,
      heading,
      normalFontSizePt,
      geometry: {
        leftIn: clamp(left / 72, 0.75, 2.5),
        rightIn: clamp((pageWidth - right) / 72, 0.75, 2.5),
        topIn: clamp(top / 72, 0.75, 2.0),
        bottomIn: clamp((pageHeight - Math.max(...profiles.map((profile) => profile.y1).filter(Number.isFinite))) / 72, 0.75, 1.5),
      },
    };
  } catch (error) {
    return null;
  }
}

function applyTemplatePdfMarkdownFormatting(markdown, templatePath) {
  const layout = resolvePdfTemplateLayout(templatePath);
  const mergedMarkdown = normalizeSplitArticleHeadingsForPdf(markdown);
  const styledMarkdown = applyModestPdfHeadingStyle(mergedMarkdown, layout);
  const openingProfiles = getTemplateOpeningProfiles(templatePath);
  return centerOpeningLinesForPdf(styledMarkdown, openingProfiles);
}

function resolvePdfGeometryArg(layout) {
  const geometry = layout?.geometry;
  if (!geometry) {
    return '-Vgeometry=margin=1in';
  }

  return `-Vgeometry=${[
    `left=${formatLatexNumber(geometry.leftIn)}in`,
    `right=${formatLatexNumber(geometry.rightIn)}in`,
    `top=${formatLatexNumber(geometry.topIn)}in`,
    `bottom=${formatLatexNumber(geometry.bottomIn)}in`,
  ].join(',')}`;
}

function resolveOutputPath({ outputArg, outputFormat, sourcePath, templatePath }) {
  const filename = buildDefaultOutputFilename(sourcePath, templatePath, outputFormat);
  const canonicalExtension = OUTPUT_FORMAT_TO_EXTENSION[outputFormat];

  if (!outputArg) {
    return {
      outputPath: path.resolve('output', filename),
      outputNotice: null,
    };
  }

  const resolved = path.resolve(outputArg);
  const stat = fs.statSync(resolved, { throwIfNoEntry: false });
  if (stat && stat.isDirectory()) {
    return {
      outputPath: path.join(resolved, filename),
      outputNotice: null,
    };
  }

  const parsed = path.parse(resolved);
  if (!parsed.ext) {
    return {
      outputPath: `${resolved}${canonicalExtension}`,
      outputNotice: null,
    };
  }

  if (parsed.ext.toLowerCase() === canonicalExtension) {
    return {
      outputPath: resolved,
      outputNotice: null,
    };
  }

  const normalizedPath = path.join(parsed.dir, `${parsed.name}${canonicalExtension}`);
  return {
    outputPath: normalizedPath,
    outputNotice: `Output path extension ${parsed.ext} does not match ${outputFormat}. Writing to ${normalizedPath} instead.`,
  };
}

function convertMarkdownToDocx(markdown, outputPath, templatePath) {
  ensurePandoc();

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-align-'));
  const tempMarkdownPath = path.join(tempDir, 'aligned.md');

  try {
    fs.writeFileSync(tempMarkdownPath, `${markdown}\n`, 'utf8');

    const pandocArgs = [tempMarkdownPath, '-f', 'gfm', '-o', outputPath];
    if (path.extname(templatePath).toLowerCase() === '.docx') {
      pandocArgs.push(`--reference-doc=${templatePath}`);
    }

    childProcess.execFileSync('pandoc', pandocArgs, { stdio: 'pipe' });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function convertMarkdownToPdf(markdown, outputPath, pdfOptions) {
  ensurePandoc();

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-align-'));
  const tempMarkdownPath = path.join(tempDir, 'aligned.md');

  try {
    fs.writeFileSync(tempMarkdownPath, `${markdown}\n`, 'utf8');

    const pandocArgs = [
      tempMarkdownPath,
      '-f',
      'markdown+raw_tex',
      '-o',
      outputPath,
      `--pdf-engine=${pdfOptions.engine}`,
      resolvePdfGeometryArg(pdfOptions.layout),
    ];

    if (pdfOptions.isJapaneseAware && pdfOptions.fontProfile?.serif) {
      pandocArgs.push(`-Vmainfont=${pdfOptions.fontProfile.serif}`);
      pandocArgs.push('-Vlang=ja-JP');
    }
    if (pdfOptions.isJapaneseAware && pdfOptions.fontProfile?.sans) {
      pandocArgs.push(`-Vsansfont=${pdfOptions.fontProfile.sans}`);
    }
    if (pdfOptions.isJapaneseAware && pdfOptions.fontProfile?.mono) {
      pandocArgs.push(`-Vmonofont=${pdfOptions.fontProfile.mono}`);
    }

    childProcess.execFileSync('pandoc', pandocArgs, { stdio: 'pipe' });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function writeRenderedOutputFromMarkdown({
  document,
  outputFormat,
  outputPath,
  templatePath,
  options,
  sourceText,
  templateText,
  logger,
}) {
  if (outputFormat === 'docx') {
    logger.info('Converting generated Markdown to DOCX');
    convertMarkdownToDocx(document, outputPath, templatePath);
    if (path.extname(templatePath).toLowerCase() === '.docx') {
      logger.info('Applying target DOCX title, heading, spacing, and font cues');
      try {
        applyTemplateDocxFormatting(outputPath, templatePath);
      } catch (error) {
        logger.warn(`DOCX visual formatting pass skipped: ${error.message}`);
      }
    }
    return;
  }

  if (outputFormat === 'pdf') {
    const pdfLayout = resolvePdfTemplateLayout(templatePath);
    const pdfDocument = applyTemplatePdfMarkdownFormatting(document, templatePath);
    const pdfOptions = resolvePdfConversionOptions({
      explicitPdfEngine: options.pdfEngine,
      markdown: pdfDocument,
      sourceText,
      templateText,
    });
    pdfOptions.layout = pdfLayout;

    if (pdfOptions.warning) {
      logger.warn(pdfOptions.warning);
    }

    const fontSuffix =
      pdfOptions.isJapaneseAware && pdfOptions.fontProfile?.serif
        ? ` using ${pdfOptions.fontProfile.serif}`
        : '';
    logger.info(`Converting generated Markdown to PDF with ${pdfOptions.engine}${fontSuffix}`);
    convertMarkdownToPdf(pdfDocument, outputPath, pdfOptions);
    return;
  }

  fs.writeFileSync(outputPath, `${document}\n`, 'utf8');
}

async function resolveModel(client, requestedModel, isExplicitModel) {
  if (isExplicitModel) {
    return { model: requestedModel, fallbackMessage: null };
  }

  const modelsPage = await client.models.list();
  const available = new Set(modelsPage.data.map((model) => model.id));

  if (available.has(requestedModel)) {
    return { model: requestedModel, fallbackMessage: null };
  }

  for (const candidate of MODEL_FALLBACK_ORDER) {
    if (available.has(candidate)) {
      return {
        model: candidate,
        fallbackMessage: `Model ${requestedModel} is not available to this project. Falling back to ${candidate}.`,
      };
    }
  }

  return { model: requestedModel, fallbackMessage: null };
}

async function runVerifiedAgentLayer({
  client,
  model,
  reasoning,
  maxOutputTokens,
  sourcePath,
  templatePath,
  outputFormat,
  modelOutputFormat,
  languageProfile,
  sourceText,
  templateText,
  templatePromptText,
  candidateDraft,
}) {
  const response = await client.responses.create({
    model,
    reasoning: { effort: reasoning === 'none' ? 'low' : reasoning },
    max_output_tokens: maxOutputTokens,
    input: [
      {
        role: 'developer',
        content: buildVerifiedAlignmentInstructions(modelOutputFormat, languageProfile),
      },
      {
        role: 'user',
        content: buildVerifiedAlignmentBrief({
          sourcePath: path.basename(sourcePath),
          templatePath: path.basename(templatePath),
          outputFormat,
          modelOutputFormat,
          languageProfile,
        }),
      },
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: [
              `Source Document (${path.basename(sourcePath)}): this is the only authoritative legal substance.`,
              'BEGIN SOURCE DOCUMENT',
              sourceText,
              'END SOURCE DOCUMENT',
            ].join('\n\n'),
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: [
              `Target Template (${path.basename(templatePath)}): structure and presentation only; do not preserve its unsupported content.`,
              'BEGIN TARGET TEMPLATE',
              templatePromptText || templateText,
              'END TARGET TEMPLATE',
            ].join('\n\n'),
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: [
              'Candidate Draft: verify this generated draft for target-format fidelity and source-only substance, then return the complete revised final document.',
              'BEGIN CANDIDATE DRAFT',
              candidateDraft,
              'END CANDIDATE DRAFT',
            ].join('\n\n'),
          },
        ],
      },
    ],
  });

  const verifiedDocument = response.output_text ? response.output_text.trim() : '';
  if (!verifiedDocument) {
    throw new Error(`Verified agent layer returned no text output. Response ID: ${response.id}`);
  }

  return {
    verifiedDocument,
    usage: response.usage || {},
    responseId: response.id,
  };
}

async function runVisualRepairLayer({
  client,
  model,
  reasoning,
  maxOutputTokens,
  sourcePath,
  templatePath,
  outputFormat,
  modelOutputFormat,
  languageProfile,
  sourceText,
  templateText,
  templatePromptText,
  candidateDraft,
  visualReport,
}) {
  const response = await client.responses.create({
    model,
    reasoning: { effort: reasoning === 'none' ? 'low' : reasoning },
    max_output_tokens: maxOutputTokens,
    input: [
      {
        role: 'developer',
        content: buildVisualRepairInstructions(modelOutputFormat, languageProfile),
      },
      {
        role: 'user',
        content: buildVisualRepairBrief({
          sourcePath: path.basename(sourcePath),
          templatePath: path.basename(templatePath),
          outputFormat,
          modelOutputFormat,
          languageProfile,
        }),
      },
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: [
              `Source Document (${path.basename(sourcePath)}): this is the only authoritative legal substance.`,
              'BEGIN SOURCE DOCUMENT',
              sourceText,
              'END SOURCE DOCUMENT',
            ].join('\n\n'),
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: [
              `Target Template (${path.basename(templatePath)}): structure and presentation only; do not preserve unsupported content.`,
              'BEGIN TARGET TEMPLATE',
              templatePromptText || templateText,
              'END TARGET TEMPLATE',
            ].join('\n\n'),
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: [
              'Visual checker report: repair these visual-format issues only.',
              'BEGIN VISUAL CHECK REPORT',
              JSON.stringify(visualReport, null, 2),
              'END VISUAL CHECK REPORT',
            ].join('\n\n'),
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: [
              'Candidate Draft: return the complete visually repaired draft.',
              'BEGIN CANDIDATE DRAFT',
              candidateDraft,
              'END CANDIDATE DRAFT',
            ].join('\n\n'),
          },
        ],
      },
    ],
  });

  const repairedDocument = response.output_text ? response.output_text.trim() : '';
  if (!repairedDocument) {
    throw new Error(`Visual repair layer returned no text output. Response ID: ${response.id}`);
  }

  return {
    repairedDocument,
    usage: response.usage || {},
    responseId: response.id,
  };
}

async function runAlignment(options) {
  const logger = createLogger(options.logger);

  if (!options.source || !options.template) {
    throw new Error('Missing source or template path.');
  }

  const sourcePath = ensureReadableFile(options.source, 'Source file');
  const templatePath = ensureReadableFile(options.template, 'Template file');
  const explicitFormat = normalizeFormat(options.format);
  const outputFormat = inferOutputFormat({
    explicitFormat,
    outputArg: options.output,
    sourcePath,
    templatePath,
  });
  const { outputPath, outputNotice } = resolveOutputPath({
    outputArg: options.output,
    outputFormat,
    sourcePath,
    templatePath,
  });
  const modelOutputFormat = outputFormat === 'docx' || outputFormat === 'pdf' ? 'markdown' : outputFormat;
  const requestedModel = options.model || process.env.OPENAI_MODEL || 'gpt-5.4';
  const isExplicitModel = Boolean(options.model || process.env.OPENAI_MODEL);
  const reasoning = normalizeReasoning(options.reasoning);
  const maxOutputTokens = normalizeMaxOutputTokens(options.maxOutputTokens);
  const visualCheckOptions = resolveVisualCheckOptions(options);

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  if (outputNotice) {
    logger.warn(outputNotice);
  }

  logger.info(`Resolved output format: ${outputFormat}`);
  logger.info(`Resolved output path: ${outputPath}`);

  const client =
    options.client ||
    new OpenAI({
      apiKey: requireEnv('OPENAI_API_KEY'),
    });

  const { model, fallbackMessage } = await resolveModel(client, requestedModel, isExplicitModel);
  if (fallbackMessage) {
    logger.warn(fallbackMessage);
  }
  const visualCheckModel = visualCheckOptions.model || model;

  logger.info(`Extracting source document text: ${path.basename(sourcePath)}`);
  const sourceText = await loadDocumentText(sourcePath);
  if (!sourceText) {
    throw new Error(`No text could be extracted from source file: ${sourcePath}`);
  }

  logger.info(`Extracting target template text: ${path.basename(templatePath)}`);
  const templateText = await loadDocumentText(templatePath);
  if (!templateText) {
    throw new Error(`No text could be extracted from template file: ${templatePath}`);
  }
  const templatePromptText = await loadTemplatePromptText(templatePath);

  const languageProfile = detectLanguageProfile(sourceText, templateText);

  logger.info(`Requesting alignment with model ${model} (${reasoning} reasoning)`);
  const response = await client.responses.create({
    model,
    reasoning: { effort: reasoning },
    max_output_tokens: maxOutputTokens,
    input: [
      {
        role: 'developer',
        content: buildAlignmentInstructions(modelOutputFormat, languageProfile),
      },
      {
        role: 'user',
        content: buildTaskBrief({
          sourcePath: path.basename(sourcePath),
          templatePath: path.basename(templatePath),
          outputFormat,
          modelOutputFormat,
          languageProfile,
        }),
      },
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: [
              `Source Document (${path.basename(sourcePath)}): preserve this document's legal substance, facts, values, and operative meaning.`,
              'BEGIN SOURCE DOCUMENT',
              sourceText,
              'END SOURCE DOCUMENT',
            ].join('\n\n'),
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: [
              `Target Template (${path.basename(templatePath)}): reuse this document's layout signature, sequencing, numbering logic, recital style, and presentation patterns.`,
              'BEGIN TARGET TEMPLATE',
              templatePromptText,
              'END TARGET TEMPLATE',
            ].join('\n\n'),
          },
        ],
      },
    ],
  });

  const alignedDocument = response.output_text ? response.output_text.trim() : '';
  if (!alignedDocument) {
    throw new Error(`Model returned no text output. Response ID: ${response.id}`);
  }

  logger.info('Running verified post-generation agent for template format and source-only substance');
  const verificationResult = await runVerifiedAgentLayer({
    client,
    model,
    reasoning,
    maxOutputTokens,
    sourcePath,
    templatePath,
    outputFormat,
    modelOutputFormat,
    languageProfile,
    sourceText,
    templateText,
    templatePromptText,
    candidateDraft: alignedDocument,
  });
  let finalDocument = sanitizeGeneratedDocumentStructure(verificationResult.verifiedDocument);
  if (finalDocument !== verificationResult.verifiedDocument) {
    logger.info('Normalized a title/article label collision before output conversion');
  }

  writeRenderedOutputFromMarkdown({
    document: finalDocument,
    outputFormat,
    outputPath,
    templatePath,
    options,
    sourceText,
    templateText,
    logger,
  });

  const visualChecks = [];
  const visualRepairs = [];
  if (shouldRunVisualCheck(outputFormat, visualCheckOptions)) {
    for (let attempt = 0; attempt <= visualCheckOptions.repairAttempts; attempt += 1) {
      logger.info(`Running rendered visual checker with ${visualCheckModel} (attempt ${attempt + 1})`);
      const visualReport = await runRenderedVisualCheck({
        client,
        model: visualCheckModel,
        templatePath,
        outputPath,
        outputFormat,
        maxPages: visualCheckOptions.maxPages,
        logger,
      });
      visualChecks.push(visualReport);

      if (visualReport.skipped) {
        logger.warn(`Rendered visual checker skipped: ${visualReport.reason}`);
        break;
      }

      if (visualReport.pass) {
        logger.info(`Rendered visual checker passed: ${summarizeVisualReport(visualReport)}`);
        break;
      }

      logger.warn(`Rendered visual checker found issues: ${summarizeVisualReport(visualReport)}`);
      if (attempt >= visualCheckOptions.repairAttempts) {
        break;
      }

      logger.info('Running visual-format repair agent');
      const repairResult = await runVisualRepairLayer({
        client,
        model,
        reasoning,
        maxOutputTokens,
        sourcePath,
        templatePath,
        outputFormat,
        modelOutputFormat,
        languageProfile,
        sourceText,
        templateText,
        templatePromptText,
        candidateDraft: finalDocument,
        visualReport,
      });
      visualRepairs.push(repairResult);
      const repairedDocument = sanitizeGeneratedDocumentStructure(repairResult.repairedDocument);
      if (repairedDocument !== repairResult.repairedDocument) {
        logger.info('Normalized a title/article label collision after visual repair');
      }
      finalDocument = repairedDocument;
      writeRenderedOutputFromMarkdown({
        document: finalDocument,
        outputFormat,
        outputPath,
        templatePath,
        options,
        sourceText,
        templateText,
        logger,
      });
    }
  }

  const firstPassUsage = response.usage || {};
  const verificationUsage = verificationResult.usage || {};
  const visualCheckerUsage = combineUsages(visualChecks.map((check) => check.usage));
  const visualRepairUsage = combineUsages(visualRepairs.map((repair) => repair.usage));
  const totalUsage = combineUsages([firstPassUsage, verificationUsage, visualCheckerUsage, visualRepairUsage]);
  const usage = {
    input_tokens: totalUsage.input_tokens,
    output_tokens: totalUsage.output_tokens,
    total_tokens: totalUsage.total_tokens,
    generation: firstPassUsage,
    verified_agent: verificationUsage,
  };
  if (hasUsage(visualCheckerUsage)) {
    usage.visual_checker = visualCheckerUsage;
  }
  if (hasUsage(visualRepairUsage)) {
    usage.visual_repair = visualRepairUsage;
  }
  logger.info(`Saved aligned draft to ${outputPath}`);
  if (usage.input_tokens || usage.output_tokens || usage.total_tokens) {
    logger.info(
      `Token usage: input=${usage.input_tokens || 0}, output=${usage.output_tokens || 0}, total=${usage.total_tokens || 0}`,
    );
  }

  return {
    outputPath,
    outputFormat,
    outputNotice,
    requestedModel,
    model,
    usage,
    responseId: response.id,
    verificationResponseId: verificationResult.responseId,
    visualCheckResponseIds: visualChecks.map((check) => check.responseId).filter(Boolean),
    visualRepairResponseIds: visualRepairs.map((repair) => repair.responseId).filter(Boolean),
    visualChecks,
  };
}

module.exports = {
  runAlignment,
  runVerifiedAgentLayer,
  runVisualRepairLayer,
  applyTemplatePdfMarkdownFormatting,
  resolvePdfTemplateLayout,
  sanitizeGeneratedDocumentStructure,
  VALID_FORMATS,
};
