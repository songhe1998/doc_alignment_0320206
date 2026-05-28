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
} = require('./alignmentPrompt');
const { applyTemplateDocxFormatting } = require('./docxFormatting');
const { loadDocumentText, loadTemplatePromptText } = require('./documentLoader');

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
  mono: ['Menlo', 'Courier New', 'Osaka-Mono'],
};
const OUTPUT_FORMAT_TO_EXTENSION = {
  markdown: '.md',
  latex: '.tex',
  docx: '.docx',
  pdf: '.pdf',
};
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
  return value || process.env.PANDOC_PDF_ENGINE || null;
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

    cachedFontCatalog = output.toLowerCase();
    return cachedFontCatalog;
  } catch (error) {
    cachedFontCatalog = '';
    return cachedFontCatalog;
  }
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

  if (hasJapaneseContent && commandExists('xelatex')) {
    return {
      engine: 'xelatex',
      isJapaneseAware: true,
      fontProfile: resolveJapanesePdfProfile(),
      warning: null,
    };
  }

  if (hasJapaneseContent && commandExists('lualatex')) {
    return {
      engine: 'lualatex',
      isJapaneseAware: true,
      fontProfile: resolveJapanesePdfProfile(),
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
      'gfm',
      '-o',
      outputPath,
      `--pdf-engine=${pdfOptions.engine}`,
    ];

    if (pdfOptions.isJapaneseAware && pdfOptions.fontProfile?.serif) {
      pandocArgs.push(`-Vmainfont=${pdfOptions.fontProfile.serif}`);
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
  const finalDocument = verificationResult.verifiedDocument;

  if (outputFormat === 'docx') {
    logger.info('Converting generated Markdown to DOCX');
    convertMarkdownToDocx(finalDocument, outputPath, templatePath);
    if (path.extname(templatePath).toLowerCase() === '.docx') {
      logger.info('Applying target DOCX title, heading, spacing, and font cues');
      try {
        applyTemplateDocxFormatting(outputPath, templatePath);
      } catch (error) {
        logger.warn(`DOCX visual formatting pass skipped: ${error.message}`);
      }
    }
  } else if (outputFormat === 'pdf') {
    const pdfOptions = resolvePdfConversionOptions({
      explicitPdfEngine: options.pdfEngine,
      markdown: finalDocument,
      sourceText,
      templateText,
    });

    if (pdfOptions.warning) {
      logger.warn(pdfOptions.warning);
    }

    const fontSuffix =
      pdfOptions.isJapaneseAware && pdfOptions.fontProfile?.serif
        ? ` using ${pdfOptions.fontProfile.serif}`
        : '';
    logger.info(`Converting generated Markdown to PDF with ${pdfOptions.engine}${fontSuffix}`);
    convertMarkdownToPdf(finalDocument, outputPath, pdfOptions);
  } else {
    fs.writeFileSync(outputPath, `${finalDocument}\n`, 'utf8');
  }

  const firstPassUsage = response.usage || {};
  const verificationUsage = verificationResult.usage || {};
  const usage = {
    input_tokens: (firstPassUsage.input_tokens || 0) + (verificationUsage.input_tokens || 0),
    output_tokens: (firstPassUsage.output_tokens || 0) + (verificationUsage.output_tokens || 0),
    total_tokens: (firstPassUsage.total_tokens || 0) + (verificationUsage.total_tokens || 0),
    generation: firstPassUsage,
    verified_agent: verificationUsage,
  };
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
  };
}

module.exports = {
  runAlignment,
  runVerifiedAgentLayer,
  VALID_FORMATS,
};
