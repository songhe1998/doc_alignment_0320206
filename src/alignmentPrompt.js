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
    '- Determine the narrative sequence used by the template, including preamble, recitals, operative covenants, miscellaneous provisions, and signature flow.',
    '- Reuse the template notation hierarchy exactly when possible, including Article/Section/Subsection patterns and lettering styles.',
    '',
    '2. Substance Mapping (The Content)',
    '- Reorganize the Source Document into the template sequence.',
    '- Convert the source background and purpose into recitals or whereas clauses when the template uses them.',
    '- Group source definitions, covenants, limitations, remedies, and boilerplate into the corresponding template sections.',
    '- Preserve all source legal values and facts, including durations, parties, jurisdictions, liabilities, remedies, carve-outs, and procedural requirements.',
    '- Never replace source facts with the template sample facts.',
    '',
    '3. Refinement and Polish',
    '- Mirror the template use of capitalization, bolding, defined terms, and stylistic emphasis.',
    '- Ensure the result reads like a single cohesive instrument that looks like the template but acts like the source.',
    '',
    'Hard Constraints',
    '- Do not invent new legal obligations, dates, parties, payment terms, governing law, liability caps, or termination triggers that are not grounded in the source.',
    '- If the template has a structural slot that has no source equivalent, adapt gracefully without adding substantive obligations.',
    '- Resolve conflicts in favor of the source substance and the template structure.',
    '- Keep the output polished and ready to save as the final aligned draft.',
    `- ${formatDirective}`,
    ...buildLanguageGuidance(languageProfile),
  ].join('\n');
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
    lines.push('Produce clean Markdown that preserves structure and numbering because it will be converted into a .docx file after generation.');
  } else if (outputFormat === 'pdf') {
    lines.push('Produce clean Markdown that preserves structure and numbering because it will be converted into a .pdf file after generation.');
  }

  if (languageProfile?.templateLanguage === 'japanese') {
    lines.push('The target template appears to be Japanese. Follow Japanese legal-document tone, numbering, and signature conventions in the final draft.');
  }

  return lines.join('\n');
}

module.exports = {
  buildAlignmentInstructions,
  buildTaskBrief,
};
