#!/usr/bin/env node
'use strict';

const { runAlignment } = require('./alignCore');

function printUsage() {
  console.log(`
Usage:
  npm run align -- --source <path> --template <path> [options]

Required:
  --source <path>       Source document whose legal substance must be preserved
  --template <path>     Target template whose structure/style must be reused

Options:
  --output <path>       Output file path or directory for the aligned draft (default: auto in ./output)
  --format <auto|markdown|latex|docx|pdf>   Output format (default: auto)
  --model <model>             OpenAI model (default: OPENAI_MODEL or gpt-5.4)
  --reasoning <level>         none|low|medium|high|xhigh (default: medium)
  --max-output-tokens <n>     Response token cap (default: 12000)
  --pdf-engine <engine>       Pandoc PDF engine override (default: auto; PANDOC_PDF_ENGINE overrides)
  --help                      Show this message

Examples:
  npm run align -- --source examples/source-nda.md --template examples/template-msa.md
  npm run align -- --source ./source.pdf --template ./template.docx
  npm run align -- --source ./source.pdf --template ./template.docx --output ./output/custom-name --format pdf
`);
}

function parseArgs(argv) {
  const args = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (!token.startsWith('--')) {
      throw new Error(`Unexpected argument: ${token}`);
    }

    const [flag, inlineValue] = token.split('=');
    const key = flag.slice(2);

    if (key === 'help') {
      args[key] = true;
      continue;
    }

    const value = inlineValue ?? argv[i + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for --${key}`);
    }

    args[key] = value;
    if (inlineValue === undefined) {
      i += 1;
    }
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printUsage();
    return;
  }

  if (!args.source || !args.template) {
    printUsage();
    throw new Error('Missing one or more required arguments.');
  }

  await runAlignment({
    source: args.source,
    template: args.template,
    output: args.output,
    format: args.format,
    model: args.model,
    reasoning: args.reasoning,
    maxOutputTokens: args['max-output-tokens'],
    pdfEngine: args['pdf-engine'],
    logger: console,
  });
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
