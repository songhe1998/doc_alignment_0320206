'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildDocxFormatOutline } = require('./docxFormatting');

const VISUAL_OUTPUT_FORMATS = new Set(['docx', 'pdf']);
const RENDERABLE_EXTENSIONS = new Set(['.pdf', '.docx', '.md', '.markdown', '.txt', '.text']);
const CJK_FONT_CANDIDATES = {
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
  mono: ['Menlo', 'Courier New', 'Osaka-Mono'],
};

const VISUAL_CHECK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['pass', 'summary', 'issues', 'repair_instructions'],
  properties: {
    pass: { type: 'boolean' },
    summary: { type: 'string' },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'severity', 'page', 'message'],
        properties: {
          type: { type: 'string' },
          severity: { type: 'string', enum: ['low', 'medium', 'high'] },
          page: { type: 'integer' },
          message: { type: 'string' },
        },
      },
    },
    repair_instructions: {
      type: 'array',
      items: { type: 'string' },
    },
  },
};

const RENDER_PDF_SCRIPT = String.raw`
import json
import pathlib
import sys

import fitz

pdf_path = sys.argv[1]
output_dir = pathlib.Path(sys.argv[2])
base_name = sys.argv[3]
max_pages = int(sys.argv[4])
output_dir.mkdir(parents=True, exist_ok=True)

doc = fitz.open(pdf_path)
paths = []
for page_index in range(min(len(doc), max_pages)):
    page = doc[page_index]
    pix = page.get_pixmap(matrix=fitz.Matrix(1.6, 1.6), alpha=False)
    output_path = output_dir / f"{base_name}-page-{page_index + 1}.png"
    pix.save(str(output_path))
    paths.append(str(output_path))

print(json.dumps(paths))
`;

function commandExists(command) {
  try {
    childProcess.execFileSync('sh', ['-lc', `command -v ${command}`], { stdio: 'ignore' });
    return true;
  } catch (error) {
    return false;
  }
}

let cachedFontCatalog = null;

function listFontCatalog() {
  if (cachedFontCatalog !== null) {
    return cachedFontCatalog;
  }

  try {
    cachedFontCatalog = childProcess.execFileSync('fc-list', [':', 'family'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toLowerCase();
  } catch (error) {
    cachedFontCatalog = '';
  }

  return cachedFontCatalog;
}

function resolveInstalledFont(candidates) {
  const catalog = listFontCatalog();
  for (const candidate of candidates) {
    if (!catalog || catalog.includes(candidate.toLowerCase())) {
      return candidate;
    }
  }

  return candidates[0] || null;
}

function normalizeBooleanMode(value, defaultValue = 'auto') {
  const raw = String(value ?? defaultValue).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(raw)) {
    return 'true';
  }
  if (['0', 'false', 'no', 'off', 'disabled'].includes(raw)) {
    return 'false';
  }
  if (!raw || raw === 'auto') {
    return 'auto';
  }

  throw new Error(`Invalid visual check value: ${value}`);
}

function normalizePositiveInteger(value, defaultValue, { min = 0, max = 10 } = {}) {
  const parsed = Number.parseInt(value ?? `${defaultValue}`, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`Invalid positive integer value: ${value ?? defaultValue}`);
  }

  return parsed;
}

function resolveVisualCheckOptions(options = {}) {
  return {
    mode: normalizeBooleanMode(options.visualCheck ?? process.env.VISUAL_CHECK ?? 'auto'),
    repairAttempts: normalizePositiveInteger(
      options.visualCheckRepairAttempts ?? process.env.VISUAL_CHECK_REPAIR_ATTEMPTS,
      1,
      { min: 0, max: 3 },
    ),
    maxPages: normalizePositiveInteger(options.visualCheckMaxPages ?? process.env.VISUAL_CHECK_MAX_PAGES, 2, {
      min: 1,
      max: 5,
    }),
    model: options.visualCheckModel || process.env.OPENAI_VISUAL_CHECK_MODEL || null,
  };
}

function shouldRunVisualCheck(outputFormat, visualCheckOptions) {
  if (visualCheckOptions.mode === 'false') {
    return false;
  }

  return VISUAL_OUTPUT_FORMATS.has(outputFormat);
}

function resolvePreviewPdfEngine() {
  if (commandExists('xelatex')) {
    return 'xelatex';
  }
  if (commandExists('lualatex')) {
    return 'lualatex';
  }
  return 'pdflatex';
}

function addFontArgs(args, engine) {
  if (engine !== 'xelatex' && engine !== 'lualatex') {
    return args;
  }

  const serif = resolveInstalledFont(CJK_FONT_CANDIDATES.serif);
  const sans = resolveInstalledFont(CJK_FONT_CANDIDATES.sans);
  const mono = resolveInstalledFont(CJK_FONT_CANDIDATES.mono);

  if (serif) {
    args.push(`-Vmainfont=${serif}`);
    args.push(`-VCJKmainfont=${serif}`);
    args.push('-Vlang=ja-JP');
  }
  if (sans) {
    args.push(`-Vsansfont=${sans}`);
  }
  if (mono) {
    args.push(`-Vmonofont=${mono}`);
  }

  return args;
}

function ensureRenderable(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (!RENDERABLE_EXTENSIONS.has(extension)) {
    throw new Error(`Visual checker cannot render ${extension || 'extensionless'} files.`);
  }
}

function convertDocumentToPreviewPdf(filePath, tempDir, label) {
  const extension = path.extname(filePath).toLowerCase();
  ensureRenderable(filePath);

  if (extension === '.pdf') {
    return filePath;
  }

  const previewPdfPath = path.join(tempDir, `${label}.pdf`);
  const engine = resolvePreviewPdfEngine();
  const args = [filePath, '-o', previewPdfPath, `--pdf-engine=${engine}`, '-Vgeometry=margin=1in'];
  addFontArgs(args, engine);
  childProcess.execFileSync('pandoc', args, { stdio: 'pipe' });
  return previewPdfPath;
}

function renderPdfToImages(pdfPath, outputDir, label, maxPages) {
  const output = childProcess.execFileSync('python3', ['-c', RENDER_PDF_SCRIPT, pdfPath, outputDir, label, String(maxPages)], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return JSON.parse(output);
}

function renderDocumentPreviewImages(filePath, { tempDir, label, maxPages }) {
  const previewPdfPath = convertDocumentToPreviewPdf(filePath, tempDir, label);
  return renderPdfToImages(previewPdfPath, tempDir, label, maxPages);
}

function imageToDataUrl(filePath) {
  const bytes = fs.readFileSync(filePath);
  return `data:image/png;base64,${bytes.toString('base64')}`;
}

function buildVisualCheckDeveloperPrompt() {
  return [
    'You are a document visual QA checker.',
    'Compare rendered target-template screenshots against rendered final-output screenshots.',
    'If a target template visual outline is provided instead of template screenshots, use the outline attributes as the visual-format reference.',
    'A template visual outline is document-level guidance, not a page-by-page map; do not require all outline entries or the same number of sections to appear on the inspected output page.',
    'Judge only visual format fidelity and layout quality, not legal substance or exact wording.',
    'Do not penalize source-specific party names, dates, clauses, or text content differences.',
    'Do not require template-only metadata such as revision dates, sample footer text, page-count placement, or sample-specific headers unless the final output has source-supported equivalent metadata.',
    'Do not require template-specific body clauses, sample section titles, exact list type, or exact section timing to appear; compare analogous visual roles and readability instead.',
    'Do not flag natural title/subtitle line wrapping caused by longer source wording if the title block remains centered, prominent, and hierarchically similar.',
    'Focus on visual roles: main title placement/alignment/font hierarchy, heading treatment, line feeds/spacing, margins, lists/tables/signature-block shape, clipping, overlap, and page-level readability.',
    'A final output can pass even when wording differs from the template, as long as the visual hierarchy and structure match the template well.',
    'Flag title/article or title/section visual merges, missing heading styling, missing blank-line spacing before headings, severe crowding, glyph failures, text overflow, or obvious page layout breakage.',
    'Return only the requested JSON object.',
  ].join('\n');
}

function buildVisualCheckUserContent({ templateImages = [], templateOutline = '', outputImages, outputFormat }) {
  const hasTemplateOutline = Boolean(templateOutline);
  const pageCount = hasTemplateOutline ? outputImages.length : Math.min(templateImages.length, outputImages.length);
  const content = [
    {
      type: 'input_text',
      text: [
        `Output format: ${outputFormat}.`,
        hasTemplateOutline
          ? `Compare ${pageCount} final output page(s) against the target template visual outline.`
          : `Compare ${pageCount} page pair(s). For each pair, the target template page appears before the final output page.`,
        hasTemplateOutline
          ? 'Use the target template visual outline as the visual-format reference only.'
          : 'Use the target pages as the visual-format reference only.',
        'The final output should preserve source content, so do not require exact wording matches.',
        'Set pass=true only if there are no high or medium visual-format issues.',
      ].join('\n'),
    },
  ];

  if (hasTemplateOutline) {
    content.push({
      type: 'input_text',
      text: [
        'TARGET TEMPLATE VISUAL OUTLINE',
        'The bracketed labels describe visual roles from the target DOCX, including title, heading, spacing, alignment, font size, and bold cues.',
        'This outline is not a page-by-page rendering. Use it for role/style/spacing expectations, not for exact first-page density or exact section count.',
        templateOutline,
      ].join('\n'),
    });
  }

  for (let index = 0; index < pageCount; index += 1) {
    if (!hasTemplateOutline) {
      content.push({ type: 'input_text', text: `TARGET TEMPLATE PAGE ${index + 1}` });
      content.push({ type: 'input_image', image_url: imageToDataUrl(templateImages[index]), detail: 'high' });
    }
    content.push({ type: 'input_text', text: `FINAL OUTPUT PAGE ${index + 1}` });
    content.push({ type: 'input_image', image_url: imageToDataUrl(outputImages[index]), detail: 'high' });
  }

  return content;
}

function normalizeVisualCheckReport(value) {
  const report = value && typeof value === 'object' ? value : {};
  const issues = Array.isArray(report.issues)
    ? report.issues.map((issue, index) => ({
        type: String(issue.type || 'visual_issue'),
        severity: ['low', 'medium', 'high'].includes(issue.severity) ? issue.severity : 'medium',
        page: Number.isInteger(issue.page) && issue.page > 0 ? issue.page : 1,
        message: String(issue.message || `Visual issue ${index + 1}`),
      }))
    : [];
  const blockingIssues = issues.filter((issue) => issue.severity === 'high' || issue.severity === 'medium');

  return {
    pass: typeof report.pass === 'boolean' ? report.pass && blockingIssues.length === 0 : blockingIssues.length === 0,
    summary: String(report.summary || (blockingIssues.length ? 'Visual issues found.' : 'Visual check passed.')),
    issues,
    repair_instructions: Array.isArray(report.repair_instructions)
      ? report.repair_instructions.map((instruction) => String(instruction)).filter(Boolean)
      : [],
  };
}

function compactTemplateOutline(outline, maxLines = 80) {
  const lines = String(outline || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length <= maxLines) {
    return lines.join('\n');
  }

  return [...lines.slice(0, maxLines), `[OUTLINE TRUNCATED after ${maxLines} lines]`].join('\n');
}

function parseVisualCheckJson(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) {
    throw new Error('Visual checker returned no text.');
  }

  try {
    return JSON.parse(trimmed);
  } catch (error) {
    const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fencedMatch) {
      return JSON.parse(fencedMatch[1].trim());
    }

    const objectMatch = trimmed.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      return JSON.parse(objectMatch[0]);
    }

    throw error;
  }
}

async function runVisualCheck({
  client,
  model,
  templateImages = [],
  templateOutline = '',
  outputImages,
  outputFormat,
  maxOutputTokens = 1600,
}) {
  if ((!templateImages.length && !templateOutline) || !outputImages.length) {
    throw new Error('Visual checker needs at least one template reference and one output image.');
  }

  const response = await client.responses.create({
    model,
    reasoning: { effort: 'low' },
    max_output_tokens: maxOutputTokens,
    text: {
      verbosity: 'low',
      format: {
        type: 'json_schema',
        name: 'visual_check_report',
        strict: true,
        schema: VISUAL_CHECK_SCHEMA,
      },
    },
    input: [
      {
        role: 'developer',
        content: buildVisualCheckDeveloperPrompt(),
      },
      {
        role: 'user',
        content: buildVisualCheckUserContent({ templateImages, templateOutline, outputImages, outputFormat }),
      },
    ],
  });

  const report = normalizeVisualCheckReport(parseVisualCheckJson(response.output_text || ''));
  return {
    ...report,
    responseId: response.id,
    usage: response.usage || {},
  };
}

async function runRenderedVisualCheck({
  client,
  model,
  templatePath,
  outputPath,
  outputFormat,
  maxPages,
  logger = console,
}) {
  if (!VISUAL_OUTPUT_FORMATS.has(outputFormat)) {
    return { skipped: true, reason: `Visual checker is not supported for ${outputFormat} output.` };
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-align-visual-'));
  try {
    const templateExtension = path.extname(templatePath).toLowerCase();
    let templateImages = [];
    let templateOutline = '';
    if (templateExtension === '.docx' && !commandExists('soffice')) {
      templateOutline = compactTemplateOutline(buildDocxFormatOutline(templatePath));
    }
    if (!templateOutline) {
      templateImages = renderDocumentPreviewImages(templatePath, {
        tempDir,
        label: 'template',
        maxPages,
      });
    }
    const outputImages = renderDocumentPreviewImages(outputPath, {
      tempDir,
      label: 'output',
      maxPages,
    });

    if ((!templateImages.length && !templateOutline) || !outputImages.length) {
      return { skipped: true, reason: 'Visual checker could not render comparable page images.' };
    }

    return await runVisualCheck({
      client,
      model,
      templateImages,
      templateOutline,
      outputImages,
      outputFormat,
    });
  } catch (error) {
    if (logger && typeof logger.warn === 'function') {
      logger.warn(`Visual checker skipped: ${error.message}`);
    }
    return { skipped: true, reason: error.message };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function summarizeVisualReport(report) {
  if (!report || report.skipped) {
    return report?.reason || 'Visual checker skipped.';
  }

  if (report.pass) {
    return report.summary || 'Visual checker passed.';
  }

  const issueSummary = report.issues
    .filter((issue) => issue.severity === 'high' || issue.severity === 'medium')
    .slice(0, 5)
    .map((issue) => `[${issue.severity}] page ${issue.page}: ${issue.message}`)
    .join('; ');

  return issueSummary || report.summary || 'Visual checker found issues.';
}

module.exports = {
  VISUAL_OUTPUT_FORMATS,
  buildVisualCheckDeveloperPrompt,
  buildVisualCheckUserContent,
  normalizeVisualCheckReport,
  parseVisualCheckJson,
  renderDocumentPreviewImages,
  resolveVisualCheckOptions,
  runRenderedVisualCheck,
  runVisualCheck,
  shouldRunVisualCheck,
  summarizeVisualReport,
};
