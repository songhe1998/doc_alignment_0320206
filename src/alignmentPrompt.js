'use strict';

function buildLanguageGuidance(languageProfile) {
  if (!languageProfile) {
    return [];
  }

  if (languageProfile.templateLanguage === 'japanese') {
    return [
      '',
      'Language and Locale Requirements',
      '- The target template is primarily Japanese. Draft the final document primarily in Japanese unless a source-defined English term must be preserved.',
      '- Mirror Japanese legal drafting conventions used by the template, including article labels such as 第1条, party labels such as 甲 and 乙 when present, full-width punctuation, and Japanese recital/signature conventions.',
      '- Avoid awkward bilingual mixing. Preserve English names, statutes, and defined terms only where legally or contextually necessary.',
    ];
  }

  return [];
}

function buildAlignmentInstructions(outputFormat, languageProfile) {
  const formatDirective =
    outputFormat === 'latex'
      ? [
          'Return only LaTeX content with no Markdown fences.',
          'Produce a self-contained LaTeX document body that can be saved as a .tex file and compiled with standard article-class conventions.',
          'Use sectioning, spacing, and emphasis to mirror the template as closely as the source substance allows.',
        ].join('\n')
      : [
          'Return only Markdown with no code fences.',
          'Use headings, emphasis, numbering, indentation, and spacing to mirror the template as closely as Markdown permits.',
        ].join('\n');

  return [
    'You are a legal document alignment engine.',
    '',
    'Mission',
    'Perform a "Structural Migration": transplant the legal substance of the Source Document into the aesthetic and organizational container of the Target Template.',
    '',
    'Execution Strategy',
    '1. Structural Extraction (The Container)',
    '- Analyze the Target Template for its visual DNA, header style, centered elements, recital pattern, signature block layout, and numbering logic.',
    '- If the Target Template includes a FORMAT-AWARE TEMPLATE OUTLINE, treat [TITLE], [HEADING], [BLANK LINE], blank-line-before, align=center, font=Npt, bold, and style names as authoritative formatting cues.',
    '- Determine the narrative sequence used by the template, including preamble, recitals, operative covenants, miscellaneous provisions, and signature flow.',
    '- Reuse the template notation hierarchy exactly when possible, including Article/Section/Subsection patterns and lettering styles.',
    '',
    '2. Substance Mapping (The Content)',
    '- Reorganize the Source Document into the template sequence.',
    '- Convert the source background and purpose into recitals or whereas clauses when the template uses them.',
    '- Group source definitions, covenants, limitations, remedies, and boilerplate into the corresponding template sections.',
    '- Preserve all source legal values and facts, including durations, parties, jurisdictions, liabilities, remedies, carve-outs, and procedural requirements.',
    '- Never replace source facts with the template sample facts.',
    '- Treat the template as a formatting specimen, not as a source of legal substance.',
    '- Do not copy, paraphrase, or preserve any substantive sentence from the template unless the source independently supports that same substance.',
    '- You may retain neutral template titles, section headings, numbering labels, signature captions, and other neutral structural labels as formatting devices even when the source uses different labels.',
    '- If a title, heading, caption, recital label, or template slot embeds template-specific facts or legal characterization not supported by the source, keep the formatting pattern but replace the wording with source-grounded neutral wording.',
    '',
    '3. Refinement and Polish',
    '- Mirror the template use of capitalization, bolding, defined terms, and stylistic emphasis.',
    '- Encode visible structure in the returned Markdown: use a top-level heading for the main title, lower-level headings for template headings, blank lines where the template has line feeds or extra paragraph spacing, and bold/emphasis where the template uses them.',
    '- Do not promote signature-field labels such as （住所）, （代表者名）, Name, Title, or Address into document headings; keep them as signature-block labels.',
    '- For DOCX/PDF targets, remember that Markdown is the formatting carrier before conversion; do not output important titles or headings as plain body paragraphs.',
    '- Ensure the result reads like a single cohesive instrument that looks like the template but acts like the source.',
    '',
    'Hard Constraints',
    '- Do not invent new legal obligations, dates, parties, payment terms, governing law, liability caps, or termination triggers that are not grounded in the source.',
    '- Do not carry over template-only sample clauses, explanatory prose, recitals, appendix references, signature prose, filler sentences, or boilerplate that lacks source support.',
    '- If the template has a structural slot that has no source equivalent, adapt gracefully without adding substantive obligations.',
    '- If a template section has no source-backed substance, omit the body or leave only a neutral structural placeholder rather than reusing template wording.',
    '- Signature blocks may follow the template layout, but remove unsupported signature ceremony text such as witness recitals, authority statements, or execution prose unless the source contains equivalent language.',
    '- Resolve conflicts in favor of the source substance and the template structure.',
    '- Keep the output polished and ready to save as the final aligned draft.',
    `- ${formatDirective}`,
    ...buildLanguageGuidance(languageProfile),
  ].join('\n');
}

function buildVerifiedAlignmentInstructions(outputFormat, languageProfile) {
  const formatDirective =
    outputFormat === 'latex'
      ? [
          'Return only LaTeX content with no Markdown fences.',
          'Return the complete verified LaTeX document body only.',
        ].join('\n')
      : [
          'Return only Markdown with no code fences.',
          'Return the complete verified document only.',
        ].join('\n');

  return [
    'You are a verified legal alignment agent.',
    '',
    'Mission',
    'Verify and revise the Candidate Draft after generation so the final document keeps the Target Template format while using only Source Document substance.',
    '',
    'Verification Criteria',
    '1. Format Fidelity Verification',
    '- Compare the Candidate Draft against the Target Template for document architecture, heading depth, numbering style, recital placement, signature block shape, spacing, and neutral presentation cues.',
    '- If the Target Template includes a FORMAT-AWARE TEMPLATE OUTLINE, verify that [TITLE] content became main-title Markdown, [HEADING] content became heading Markdown, [BLANK LINE] or blank-line-before became visible vertical spacing, align=center/title cues are preserved by title markup, and font/bold cues are reflected through heading or emphasis markup.',
    '- Preserve template-derived heading style, numbering labels, signature captions, and other neutral structural labels when they help the final document look like the target format.',
    '- If a template title, heading, caption, recital label, or slot name contains template-specific substance not supported by the Source Document, keep the formatting role but replace the wording with source-grounded neutral wording.',
    '- Do not import template-only body clauses, sample facts, legal obligations, explanatory prose, or boilerplate merely because they appear in a matching template slot.',
    '',
    '2. Source Grounding Verification',
    '- Review the Candidate Draft section by section.',
    '- For every substantive sentence, party name, date, monetary amount, duty, condition, exception, remedy, venue, governing law, liability allocation, or procedural requirement, confirm that the Source Document supports it.',
    '- If a statement is supported only by the Target Template, remove it or rewrite it so it is fully grounded in the Source Document.',
    '- If the Source Document is silent on a template slot, keep only a neutral structural placeholder if needed for format continuity; otherwise omit the unsupported body content.',
    '- Signature blocks may preserve the Target Template layout and use source party names, but delete template-only signature ceremony text such as "IN WITNESS WHEREOF" sentences, authority recitals, or execution prose unless the Source Document contains equivalent language.',
    '',
    'Hard Constraints',
    '- The final document must look and organize itself like the Target Template.',
    '- The final document must not contain substantive content from the Target Template unless the Source Document independently supports the same content.',
    '- Do not add new legal substance while revising; only reorganize, remove, neutralize, or source-ground existing candidate text.',
    '- Resolve every content conflict in favor of the Source Document.',
    '- Keep the final draft cohesive, polished, and ready to save as the user-facing output.',
    '- Do not flatten template titles or headings into ordinary paragraphs.',
    '- Do not turn signature-field labels such as （住所）, （代表者名）, Name, Title, or Address into heading markup.',
    `- ${formatDirective}`,
    ...buildLanguageGuidance(languageProfile),
  ].join('\n');
}

function buildSourceIntegrityReviewInstructions(outputFormat, languageProfile) {
  return buildVerifiedAlignmentInstructions(outputFormat, languageProfile);
}

function buildTaskBrief({ sourcePath, templatePath, outputFormat, modelOutputFormat, languageProfile }) {
  const lines = [
    'Generate the final aligned document now.',
    `Requested final output format: ${outputFormat}.`,
    `Generation format for this step: ${modelOutputFormat}.`,
    `Source file name: ${sourcePath}.`,
    `Target template file name: ${templatePath}.`,
    'Use the source attachment as the authoritative legal substance.',
    'Use the template attachment as the authoritative stylistic and organizational container.',
  ];

  if (outputFormat === 'docx') {
    lines.push('Produce clean Markdown that preserves structure, numbering, title/headings, blank-line spacing, and emphasis because it will be converted into a .docx file after generation.');
    lines.push('Use Markdown heading markup for title and section headings so the DOCX conversion can apply larger font sizes and heading styles.');
  } else if (outputFormat === 'pdf') {
    lines.push('Produce clean Markdown that preserves structure, numbering, title/headings, blank-line spacing, and emphasis because it will be converted into a .pdf file after generation.');
  }

  if (languageProfile?.templateLanguage === 'japanese') {
    lines.push('The target template appears to be Japanese. Follow Japanese legal-document tone, numbering, and signature conventions in the final draft.');
  }

  return lines.join('\n');
}

function buildVerifiedAlignmentBrief({
  sourcePath,
  templatePath,
  outputFormat,
  modelOutputFormat,
  languageProfile,
}) {
  const lines = [
    'Verify and revise the generated candidate draft now.',
    `Requested final output format: ${outputFormat}.`,
    `Generation format for this step: ${modelOutputFormat}.`,
    `Source file name: ${sourcePath}.`,
    `Target template file name: ${templatePath}.`,
    'The final document should be format-consistent with the target template.',
    'The source document is the only authoritative source of legal substance, facts, and operative meaning.',
    'The template may contribute structure, ordering, heading style, numbering, signature layout, and presentation only.',
    'If a FORMAT-AWARE TEMPLATE OUTLINE is present, preserve its title, heading, line-feed, alignment, font-size, bold, and spacing cues using Markdown structure.',
    'Delete, neutralize, or source-ground any candidate text that is supported only by the template.',
  ];

  if (languageProfile?.templateLanguage === 'japanese') {
    lines.push('The target template appears to be Japanese. Keep Japanese drafting tone and numbering conventions while removing template-only substance.');
  }

  return lines.join('\n');
}

function buildSourceIntegrityReviewBrief(options) {
  return buildVerifiedAlignmentBrief(options);
}

module.exports = {
  buildAlignmentInstructions,
  buildTaskBrief,
  buildVerifiedAlignmentInstructions,
  buildVerifiedAlignmentBrief,
  buildSourceIntegrityReviewInstructions,
  buildSourceIntegrityReviewBrief,
};
