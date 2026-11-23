// Claude provider (MODEL_PROVIDER=claude), same interface, validation, error codes and budget as OpenRouter
// (one request loop: chain.ts). Request shape from the `claude-api` skill (curl/examples.md, README):
//   POST https://api.anthropic.com/v1/messages · headers x-api-key, anthropic-version: 2026-10-21,
//   content-type · body {model, max_tokens, system, messages, output_config: {effort, format: {type:
//   "json_schema", schema}}} · answer = the `text` blocks of `content`, `stop_reason` checked first.
// No temperature (a 400 on API version 2026-10-21); thinking left at the model's default (adaptive).
// Raw fetch, not the SDK: app/server has no dependency and every provider takes an injected fetch (tests, Worker).
// Key: opts.apiKey, then env ANTHROPIC_API_KEY. Model: opts.models, then env CLAUDE_MODEL, then DEFAULT_CLAUDE_MODEL.
import { buildMessages } from './prompt.ts';
import { extractOuterJson, parseAnswer } from './validate.ts';
import { cleanBase, readEnv, runChain } from './chain.ts';
import type { Check } from './chain.ts';
import { TriageError } from './types.ts';
import type { Item, TriageOptions, TriageResult } from './types.ts';

export const ANTHROPIC_BASE = 'https://api.anthropic.com';
export const ANTHROPIC_PATH = '/v1/messages';
export const ANTHROPIC_VERSION = '2026-10-21';
/** The skill's current small fast model (« Claude Haiku 5.5 - the current Haiku »), when CLAUDE_MODEL is not set. */
export const DEFAULT_CLAUDE_MODEL = 'claude-haiku-5-5';
/** Short JSON answers; room for adaptive thinking at low effort so the answer is not cut. */
export const CLAUDE_MAX_TOKENS = 4096;

export const TRIAGE_SCHEMA = {
  type: 'object',
  properties: {
    needs_reply: { type: 'boolean' },
    summary: { type: 'string' },
    draft: { type: 'string' },
    alts: { type: 'array', items: { type: 'string' } },
  },
  required: ['needs_reply', 'summary', 'draft', 'alts'],
  additionalProperties: false,
} as const;

/** The text of a Messages API answer, or why it cannot be used. */
export function claudeContent(raw: string): Check<unknown> {
  const data = JSON.parse(raw) as { stop_reason?: unknown; content?: Array<{ type?: unknown; text?: unknown }> };
  if (data.stop_reason === 'refusal') return { ok: false, reason: 'stop_reason refusal' };
  if (data.stop_reason === 'max_tokens') return { ok: false, reason: 'stop_reason max_tokens' };
  if (!Array.isArray(data.content)) return { ok: false, reason: 'no content array' };
  const text = data.content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text as string).join('');
  return { ok: true, value: text };
}

/** Any chat task on Claude: one system prompt + one user message → a checked value. */
export function chatClaude<T>(
  system: string,
  user: string,
  schema: object,
  check: (content: unknown) => Check<T>,
  opts: TriageOptions,
): Promise<T & { provider: string }> {
  const apiKey = opts.apiKey ?? readEnv('ANTHROPIC_API_KEY', opts);
  if (!apiKey) return Promise.reject(new TriageError('missing_key', [], 'ANTHROPIC_API_KEY is not set'));
  let base = ANTHROPIC_BASE;
  try {
    if (opts.baseUrl) base = cleanBase(opts.baseUrl);
  } catch (e) {
    return Promise.reject(e);
  }
  const model = readEnv('CLAUDE_MODEL', opts) ?? DEFAULT_CLAUDE_MODEL;
  return runChain({
    prefix: 'claude',
    url: `${base}${ANTHROPIC_PATH}`,
    models: opts.models ?? [model],
    headers: { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION, 'content-type': 'application/json' },
    body: (m) => JSON.stringify({
      model: m,
      max_tokens: CLAUDE_MAX_TOKENS,
      system,
      messages: [{ role: 'user', content: user }],
      output_config: { effort: 'low', format: { type: 'json_schema', schema } },
    }),
    content: claudeContent,
    check,
  }, opts);
}

/** Structured output already gives JSON; parseAnswer still runs every rule of validate.ts. */
function checkTriage(content: unknown): Check<Omit<TriageResult, 'provider'>> {
  if (typeof content === 'string' && extractOuterJson(content) === null) return { ok: false, reason: 'no {…} in content' };
  const r = parseAnswer(content);
  return r.ok ? { ok: true, value: r.value } : r;
}

export function triageClaude(item: Item, opts: TriageOptions): Promise<TriageResult> {
  const [sys, usr] = buildMessages(item);
  return chatClaude(sys.content, usr.content, TRIAGE_SCHEMA, checkTriage, opts);
}

