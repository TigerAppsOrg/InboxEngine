import { extractWithRules } from './rules.ts';
import type { ExtractionInput, ExtractionResult } from './types.ts';

export * from './types.ts';
export * from './taxonomy.ts';
export * from './time.ts';
export * from './locations.ts';
export { extractWithRules, cleanTitle, RULES_VERSION } from './rules.ts';

export type ExtractorMode = 'rules' | 'llm';

export function extractorMode(): ExtractorMode {
  return process.env.EVENT_EXTRACTOR === 'llm' ? 'llm' : 'rules';
}

/**
 * Extract events from one email. LLM mode falls back to rules if the API call fails, so an
 * outage degrades quality rather than dropping mail.
 */
export async function extractEvents(input: ExtractionInput, mode = extractorMode()): Promise<ExtractionResult> {
  if (mode === 'llm') {
    try {
      const { extractWithClaude } = await import('./llm.ts');
      return await extractWithClaude(input);
    } catch (error) {
      const result = extractWithRules(input);
      result.notes.push(`llm extraction failed, used rules: ${error instanceof Error ? error.name : 'error'}`);
      return result;
    }
  }
  return extractWithRules(input);
}
