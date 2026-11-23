// Claude provider: same interface as the OpenRouter one, switched on from 2026-11-27
// (MODEL_PROVIDER=claude) when the API credits exist.
// TODO(2026-11-27): fill in from the `claude-api` skill docs (model id, endpoint, headers,
// price). Model ids and prices are NOT guessed here on purpose.
import { TriageError } from './types.ts';
import type { Item, TriageOptions, TriageResult } from './types.ts';

export async function triageClaude(_item: Item, _opts: TriageOptions): Promise<TriageResult> {
  throw new TriageError('not_configured');
}
