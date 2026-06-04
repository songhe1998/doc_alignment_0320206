'use strict';

const childProcess = require('child_process');

const SIGNATURE_FIELD_LABEL_REGEX = /^[（(](住所|所在地|代表者名|氏名|名称|会社名|役職|title|name|address)[）)]$/i;
const ARTICLE_HEADING_REGEX =
  /^(?:第[0-9０-９一二三四五六七八九十百]+[条章節]|ARTICLE\s+[0-9IVXLCDM]+|Section\s+[0-9.]+)/i;
const LEGAL_TITLE_REGEX =
  /(契約|契約書|合意|合意書|覚書|規約|約款|Agreement|Contract|NDA|Non[-\s]?Disclosure|Disclosure|Confidentiality|License|Lease|Terms|Policy|Statement|Notice|Addendum|Amendment|Order|SOW|MSA)/i;

const PYMUPDF_LINE_SCRIPT = String.raw`
import json
import re
import sys

try:
    import fitz
except Exception as exc:
    raise SystemExit(f"PyMuPDF unavailable: {exc}")

doc = fitz.open(sys.argv[1])
for page_index, page in enumerate(doc, start=1):
    page_width = float(page.rect.width)
    page_height = float(page.rect.height)
    text_dict = page.get_text("dict")
    for block in text_dict.get("blocks", []):
        if block.get("type") != 0:
            continue
        for line in block.get("lines", []):
            spans = [span for span in line.get("spans", []) if span.get("text")]
            if not spans:
                continue
            text = "".join(span.get("text", "") for span in spans).strip()
            if not text:
                continue
            bbox = line.get("bbox") or block.get("bbox")
            if not bbox:
                continue
            x0, y0, x1, y1 = [float(value) for value in bbox]
            sizes = [float(span.get("size") or 0) for span in spans if float(span.get("size") or 0) > 0]
            fonts = [span.get("font", "") for span in spans if span.get("font")]
            flags = [int(span.get("flags") or 0) for span in spans]
            font_text = " ".join(fonts)
            bold = bool(re.search(r"(bold|black|heavy|demi|semi)", font_text, re.I)) or any(flag & 16 for flag in flags)
            center_x = (x0 + x1) / 2.0
            page_center_x = page_width / 2.0
            line_width = max(x1 - x0, 0.0)
            left_margin = x0
            right_margin = page_width - x1
            balanced_margins = abs(left_margin - right_margin) <= max(18.0, page_width * 0.04)
            floating_line = line_width <= page_width * 0.70 or (left_margin >= page_width * 0.18 and right_margin >= page_width * 0.18)
            if abs(center_x - page_center_x) <= max(24.0, page_width * 0.06) and balanced_margins and floating_line:
                alignment = "center"
            elif right_margin <= page_width * 0.12 and x0 >= page_width * 0.30:
                alignment = "right"
            else:
                alignment = "left"
            print(json.dumps({
                "page": page_index,
                "pageWidth": page_width,
                "pageHeight": page_height,
                "text": text,
                "x0": x0,
                "y0": y0,
                "x1": x1,
                "y1": y1,
                "fontSizePt": max(sizes) if sizes else None,
                "bold": bold,
                "alignment": alignment,
            }, ensure_ascii=False))
`;

function normalizeText(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isUsefulTextExtraction(text) {
  if (!text) {
    return false;
  }

  const stripped = text.replace(/--\s*\d+\s+of\s+\d+\s*--/gi, '').trim();
  if (stripped.length < 40) {
    return false;
  }

  const badGlyphs = stripped.match(/[\uFFFD\uFFFF\uFFFC]/g) || [];
  if (badGlyphs.length / stripped.length > 0.08) {
    return false;
  }

  return /[\p{L}\p{N}\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/u.test(stripped);
}

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) {
    return null;
  }

  return sorted[Math.floor(sorted.length / 2)];
}

function runPyMuPdfLineExtraction(filePath) {
  const output = childProcess.execFileSync('python3', ['-c', PYMUPDF_LINE_SCRIPT, filePath], {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function addSpacingSignals(lines) {
  let previous = null;

  return lines.map((line, index) => {
    const fontSize = line.fontSizePt || 11;
    let blankBefore = false;

    if (previous && previous.page === line.page) {
      const verticalGap = line.y0 - previous.y1;
      blankBefore = verticalGap >= Math.max(fontSize * 1.25, 12);
    } else if (previous && previous.page !== line.page) {
      blankBefore = true;
    }

    const profile = {
      ...line,
      index,
      text: normalizeText(line.text),
      isEmpty: false,
      blankBefore,
    };
    previous = profile;
    return profile;
  });
}

function isStandaloneArticleHeading(text) {
  const trimmed = text.trim();
  return (
    /^第[0-9０-９一二三四五六七八九十百]+[条章節](?:\s*[（(][^）)]{1,60}[）)])?$/i.test(trimmed) ||
    /^ARTICLE\s+[0-9IVXLCDM]+(?:\s*[-:：.]?\s*[A-Z][A-Z\s]{1,60})?$/i.test(trimmed) ||
    /^Section\s+[0-9.]+(?:\s*[-:：.]?\s*[A-Z][A-Z\s]{1,60})?$/i.test(trimmed)
  );
}

function isPageOrHeaderMetadata(text) {
  const trimmed = text.trim();
  return (
    /^[0-9０-９]+$/.test(trimmed) ||
    /^(final|revised|draft|version)\b/i.test(trimmed) ||
    /\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(trimmed)
  );
}

function annotateLineRoles(lines) {
  const nonEmpty = lines.filter((line) => line.text);
  const normalSize = median(nonEmpty.map((line) => line.fontSizePt)) || 11;
  let foundTitle = false;

  return lines.map((line) => {
    const shortText = line.text.length <= 100;
    const largeText = Number.isFinite(line.fontSizePt) && line.fontSizePt >= normalSize + 2;
    const articleLike = ARTICLE_HEADING_REGEX.test(line.text);
    const parentheticalHeading =
      /^[（(][^）)]{2,80}[）)]$/.test(line.text) && !SIGNATURE_FIELD_LABEL_REGEX.test(line.text);
    const legalTitle = LEGAL_TITLE_REGEX.test(line.text);

    if (!foundTitle) {
      const titleLike =
        shortText &&
        !isStandaloneArticleHeading(line.text) &&
        !parentheticalHeading &&
        !isPageOrHeaderMetadata(line.text) &&
        (line.alignment === 'center' || largeText || legalTitle || (line.bold && !articleLike));

      if (titleLike) {
        foundTitle = true;
        return { ...line, role: 'title' };
      }
    }

    const headingLike =
      parentheticalHeading ||
      (shortText && line.bold && !/[。.!?！？]$/.test(line.text)) ||
      (articleLike && shortText && !/[。.!?！？]$/.test(line.text));

    return {
      ...line,
      role: headingLike ? 'heading' : 'paragraph',
    };
  });
}

function extractPdfLineProfiles(filePath) {
  const lines = runPyMuPdfLineExtraction(filePath);
  return annotateLineRoles(addSpacingSignals(lines));
}

function extractPdfTextWithLayout(filePath) {
  try {
    const profiles = extractPdfLineProfiles(filePath);
    const text = normalizeText(profiles.map((profile) => profile.text).join('\n'));
    return isUsefulTextExtraction(text) ? text : '';
  } catch (error) {
    return '';
  }
}

function formatFontSize(value) {
  if (!Number.isFinite(value)) {
    return null;
  }

  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, '');
}

function formatProfileLine(profile) {
  const attributes = [profile.role.toUpperCase()];
  if (profile.blankBefore) {
    attributes.push('blank-line-before');
  }
  if (profile.alignment && profile.alignment !== 'left') {
    attributes.push(`align=${profile.alignment}`);
  }
  const fontSize = formatFontSize(profile.fontSizePt);
  if (fontSize) {
    attributes.push(`font=${fontSize}pt`);
  }
  if (profile.bold) {
    attributes.push('bold');
  }
  if (profile.page) {
    attributes.push(`page=${profile.page}`);
  }

  return `[${attributes.join(' ')}] ${profile.text}`;
}

function buildPdfFormatOutline(filePath) {
  const profiles = extractPdfLineProfiles(filePath);
  return profiles.map(formatProfileLine).filter(Boolean).join('\n');
}

module.exports = {
  buildPdfFormatOutline,
  extractPdfLineProfiles,
  extractPdfTextWithLayout,
  isUsefulTextExtraction,
};
