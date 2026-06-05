# Document Alignment CLI + UI

This project aligns a source legal document into the structural container of a target template using the OpenAI Responses API.

## Why this implementation

- Uses the current OpenAI text-generation path: `client.responses.create(...)`
- Prefers `gpt-5.4`, and if the current project has no access to it, falls back to the best available GPT-5 family default
- Extracts text locally from `pdf`, `docx`, `md`, and `txt`, then sends the extracted text to the Responses API
- For PDFs, uses layout-aware PyMuPDF extraction first and falls back to `pdf-parse` when needed, which helps preserve visual line roles and Japanese/CJK text
- Can emit `.docx` by generating Markdown first and converting it with `pandoc`
- For `.docx` templates, extracts title, heading, alignment, font-size, bold, and paragraph-spacing cues from WordprocessingML and reapplies key cues after conversion
- Can emit `.pdf` by generating Markdown first and converting it with `pandoc`
- Includes a local browser UI for uploading files or selecting fixtures and running alignments without using the CLI
- Defaults to automatic output format inference based on the target template, then the source, and finally the output path if you provide one
- Encodes your "Structural Migration" prompt directly into the developer instructions
- Runs a verified post-generation agent layer that keeps the target template's format while removing or rewriting template-only substantive content
- For rendered `.docx` and `.pdf` outputs, can run a VLM visual checker after rendering; if it finds medium/high visual issues, the pipeline performs a visual-format repair pass and rechecks

## Setup

1. Install dependencies:

```sh
npm install
```

2. Ensure `.env` contains:

```sh
OPENAI_API_KEY=...
```

Optional environment variables:

```sh
OPENAI_MODEL=gpt-5.4
OPENAI_REASONING_EFFORT=medium
OPENAI_MAX_OUTPUT_TOKENS=12000
PANDOC_PDF_ENGINE=xelatex
VISUAL_CHECK=auto
OPENAI_VISUAL_CHECK_MODEL=gpt-5.4
VISUAL_CHECK_MAX_PAGES=2
VISUAL_CHECK_REPAIR_ATTEMPTS=1
```

## CLI Usage

```sh
npm run align -- \
  --source ./path/to/source.pdf \
  --template ./path/to/template.docx
```

If you omit `--format`, the CLI infers the final output format in this order:

1. `--output` extension, if present and recognized
2. target `--template` extension
3. source `--source` extension
4. fallback to Markdown

If you omit `--output`, the CLI writes to `./output/<source>-aligned-to-<template>.<ext>`.

LaTeX output:

```sh
npm run align -- \
  --source ./path/to/source.docx \
  --template ./path/to/template.pdf \
  --output ./output/aligned.tex \
  --format latex
```

DOCX output:

```sh
npm run align -- \
  --source ./path/to/source.docx \
  --template ./path/to/template.docx \
  --output ./output/aligned.docx \
  --format docx
```

PDF output:

```sh
npm run align -- \
  --source ./path/to/source.pdf \
  --template ./path/to/template.pdf \
  --output ./output/aligned.pdf \
  --format pdf
```

Example run:

```sh
npm run align:example
```

Run local tests without calling the OpenAI API:

```sh
npm test
```

## UI Usage

Start the local server:

```sh
npm run ui
```

Then open:

```text
http://localhost:3000
```

The UI supports:

- uploading a source and template file directly
- selecting sample files from `data/`, `examples/`, and `manual_test_assets/`
- automatic output-format inference, or forcing `markdown`, `docx`, `pdf`, or `latex`
- downloading the generated result from the browser after the run completes

## Render Deployment

This repo now includes a `Dockerfile` and `render.yaml`, so Render can deploy it as a Docker web service without any extra build scripting.

Recommended path:

1. Push this repo to GitHub.
2. In Render, create a new Blueprint or Web Service from the repo.
3. Render will detect `render.yaml` and the Docker runtime configuration.
4. Set `OPENAI_API_KEY` in Render before the first deploy.
5. Deploy and open the generated Render URL.

Default Render environment values are defined in `render.yaml`:

- `OPENAI_MODEL=gpt-5.4`
- `OPENAI_REASONING_EFFORT=medium`
- `OPENAI_MAX_OUTPUT_TOKENS=12000`
- `PANDOC_PDF_ENGINE=xelatex`
- `VISUAL_CHECK=auto`
- `VISUAL_CHECK_MAX_PAGES=2`
- `VISUAL_CHECK_REPAIR_ATTEMPTS=1`
- `OUTPUT_RETENTION_HOURS=24`
- `UPLOAD_MAX_MB=50`

Notes for hosted use:

- The Docker image installs `pandoc`, `xelatex`, `lmodern`, Japanese fonts, and PyMuPDF so `docx`, `pdf`, and Japanese/CJK PDF output work in Render.
- Browser-triggered files are stored under `./output/ui/<request-id>/` and old runs are cleaned up automatically based on `OUTPUT_RETENTION_HOURS`.
- Render instances use ephemeral local storage by default, so generated files are meant for immediate download, not long-term retention.

## CLI options

- `--source`: source document whose legal meaning must be preserved
- `--template`: target template whose structure and look-and-feel should be reused
- `--output`: optional path or directory for the aligned draft; if omitted, one is generated automatically
- `--format`: `auto`, `markdown`, `latex`, `docx`, or `pdf`
- `--model`: override the default model
- `--reasoning`: `none`, `low`, `medium`, `high`, or `xhigh`
- `--max-output-tokens`: cap the generated output
- `--pdf-engine`: override the Pandoc PDF engine, for example `pdflatex`, `xelatex`, or another installed engine
- `--visual-check`: `auto`, `true`, or `false`; render DOCX/PDF outputs and run VLM visual QA
- `--visual-check-model`: override the model used for the VLM visual QA pass
- `--visual-check-max-pages`: number of leading pages to compare visually
- `--visual-check-repair-attempts`: number of visual-format repair attempts after a failed visual check

## Notes

- The script writes only the model's final document output to the target file.
- Every run uses two model passes: initial alignment, then a verified agent pass for target-format fidelity and source-only substance.
- For DOCX/PDF outputs, the default visual QA path renders the template and final output to images, asks a VLM to compare visual roles and layout hierarchy, and runs one visual-format repair pass if medium/high issues are found.
- DOCX template runs include a format-aware outline in the prompt and a post-conversion DOCX styling pass for main titles, headings, line feeds/spacing, alignment, and font-size cues.
- The UI writes browser-triggered runs to `./output/ui/<request-id>/`.
- Supported inputs: `.pdf`, `.docx`, `.md`, `.markdown`, `.txt`, `.text`
- For auto-format output, `.pdf` maps to PDF, `.docx` maps to DOCX, and text-like inputs map to Markdown.
- `docx` output requires `pandoc` on PATH.
- `pdf` output requires `pandoc` plus a working PDF engine on PATH.
- For PDF output, the CLI now prefers `xelatex` when available and applies a Japanese-capable font profile for Japanese/CJK content.
- PDF conversion uses explicit 1-inch margins and CJK-aware font variables so long Japanese/CJK text wraps instead of running into the page edge.
- If you explicitly force `pdflatex` for Japanese/CJK content, generation may fail or drop glyphs.
- Scanned PDFs without selectable text are not OCR'd by this version.
- For the highest visual fidelity, prefer `--format latex`.
# doc_alignment_0320206
