// BRIEF-D5 § 3.7, § 3.8 and § 6.3: the settings, the two `ai` clients, the config failure, the two wrangler files.
// The real `[ai]` binding is never called here: every `AI` below is a plain object made by the test.
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../src/env'
import worker from '../src/index'
import { aiOf, httpAi, MODEL_STT } from '../src/voice'
import { testEnv } from './helpers'
import { tone, TWO_S } from './d5-helpers'

const raw = env as unknown as Env & { WRANGLER_TOML_SOURCE: string; WRANGLER_LOCAL_TOML_SOURCE: string; WORKER_README_SOURCE: string }

let logs: string[]
beforeEach(() => {
  logs = []
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    logs.push(a.map(String).join(' '))
  })
})

/** A stand-in for the binding: records its calls, answers like Workers AI would. */
function fakeBinding() {
  const calls: Array<{ model: string; input: Record<string, unknown> }> = []
  return {
    calls,
    run: async (model: string, input: Record<string, unknown>) => {
      calls.push({ model, input })
      return model === MODEL_STT
        ? { text: 'Say Thursday at two instead, and thank him for the update.', transcription_info: { duration_after_vad: 2 }, usage: { neurons: 1.6 } }
        : { response: 'Thursday at two works for me instead. Thanks for the update.', usage: { neurons: 9.3 } }
    },
  }
}

describe('aiOf: which Workers AI client a request gets (§ 3.8)', () => {
  it('production = the binding: run(model, input) passed through, its answer returned; AI_BASE ignored', async () => {
    const b = fakeBinding()
    const fetch = vi.fn(async () => new Response('no'))
    const ai = aiOf(testEnv({ ENV: 'production', AI: b, AI_BASE: 'http://127.0.0.1:8799' }), fetch)
    expect(ai).toBeDefined()
    const answer = await ai!('@cf/meta/llama-3.3-70b-instruct-fp8-fast', { messages: [], max_tokens: 120 })
    expect(answer).toMatchObject({ usage: { neurons: 9.3 } })
    expect(b.calls).toEqual([{ model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', input: { messages: [], max_tokens: 120 } }])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('ENV "dev" + AI_BASE = POST the input as JSON to ${AI_BASE}/ai/run/<model> through deps.fetch, returns `result`', async () => {
    const seen: Array<{ url: string; init: RequestInit | undefined }> = []
    const fetch = async (url: string, init?: RequestInit) => {
      seen.push({ url, init })
      return Response.json({ success: true, result: { text: 'hello', usage: { neurons: 0.5 } } })
    }
    const b = fakeBinding()
    const ai = aiOf(testEnv({ ENV: 'dev', AI_BASE: 'http://127.0.0.1:8799/', AI: b }), fetch)
    expect(await ai!(MODEL_STT, { audio: 'UklGRg==', language: 'en', vad_filter: true })).toEqual({ text: 'hello', usage: { neurons: 0.5 } })
    expect(seen).toHaveLength(1)
    expect(seen[0]!.url).toBe('http://127.0.0.1:8799/ai/run/@cf/openai/whisper-large-v3-turbo')
    expect(seen[0]!.init?.method).toBe('POST')
    expect(new Headers(seen[0]!.init?.headers).get('content-type')).toBe('application/json')
    expect(JSON.parse(String(seen[0]!.init?.body))).toEqual({ audio: 'UklGRg==', language: 'en', vad_filter: true })
    expect(b.calls).toEqual([]) // a dev Worker never uses the binding
  })

  it('the dev client throws Error("<code>: <message>") on a non-200, as the binding does', async () => {
    const bad = httpAi('http://127.0.0.1:8799', async () =>
      Response.json(
        { success: false, errors: [{ code: 3030, message: 'Failed to decode audio file. Ensure it is a valid audio format.' }] },
        { status: 400 },
      ),
    )
    await expect(bad(MODEL_STT, {})).rejects.toThrow('3030: Failed to decode audio file. Ensure it is a valid audio format.')
    const plain = httpAi('http://127.0.0.1:8799', async () => new Response('upstream down', { status: 500 }))
    await expect(plain(MODEL_STT, {})).rejects.toThrow('500: HTTP 500')
  })

  it('no client: no binding outside dev · ENV "dev" without AI_BASE (even with a binding)', () => {
    const fetch = async () => new Response('no')
    expect(aiOf(testEnv({ ENV: 'production', AI: undefined }), fetch)).toBeUndefined()
    expect(aiOf(testEnv({ ENV: 'dev', AI_BASE: undefined, AI: fakeBinding() }), fetch)).toBeUndefined()
    expect(aiOf(testEnv({ ENV: 'dev', AI_BASE: '  ', AI: fakeBinding() }), fetch)).toBeUndefined()
  })
})

describe('the Worker entry wires the client (index.ts)', () => {
  async function viaEntry(e: Env): Promise<Response> {
    const ctx = createExecutionContext()
    const s = await worker.fetch(
      new Request('https://brief.appfinishers.com/api/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.31' },
        body: '{"mode":"demo"}',
      }),
      e,
      ctx,
    )
    const { session } = (await s.json()) as { session: string }
    const res = await worker.fetch(
      new Request('https://brief.appfinishers.com/api/items/mail-0/speak', {
        method: 'POST',
        headers: { authorization: `Bearer ${session}`, 'content-type': 'application/octet-stream', 'cf-connecting-ip': '192.0.2.31' },
        body: tone(TWO_S),
      }),
      e,
      ctx,
    )
    await waitOnExecutionContext(ctx)
    return res
  }

  it('no binding and no AI_BASE → 502 voice_failed, logged at "config"', async () => {
    const res = await viaEntry(testEnv({ AI: undefined }))
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'voice_failed' })
    expect(logs.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.outcome)).toMatchObject({ outcome: 'failed', at: 'config' })
  })

  it('with a binding (a stand-in): the speech call and the rewrite go through env.AI.run → 200', async () => {
    const b = fakeBinding()
    const res = await viaEntry(testEnv({ AI: b }))
    expect(res.status).toBe(200)
    expect(b.calls.map((c) => c.model)).toEqual([MODEL_STT, '@cf/meta/llama-3.3-70b-instruct-fp8-fast'])
  })
})

describe('the settings (§ 3.8, § 6.3, § 6.5)', () => {
  it('wrangler.toml: the [ai] binding "AI", VOICE "on", VOICE_DAILY_NEURONS "3000"', () => {
    const t = raw.WRANGLER_TOML_SOURCE
    expect(t).toMatch(/^\[ai\]\nbinding = "AI"$/m)
    expect(t).toMatch(/^VOICE = "on"$/m)
    expect(t).toMatch(/^VOICE_DAILY_NEURONS = "3000"$/m)
    expect(t).not.toMatch(/^AI_BASE/m)
  })

  it('wrangler.local.toml = wrangler.toml without its [ai] block, nothing else differs', () => {
    const block = /^# Day 5 \(BRIEF-D5 § 3\.8\): Workers AI[^\n]*\n(?:#[^\n]*\n)*\[ai\]\nbinding = "AI"\n\n/m
    expect(raw.WRANGLER_TOML_SOURCE).toMatch(block)
    expect(raw.WRANGLER_TOML_SOURCE.replace(block, '')).toBe(raw.WRANGLER_LOCAL_TOML_SOURCE)
    expect(raw.WRANGLER_LOCAL_TOML_SOURCE).not.toMatch(/\[ai\]/)
  })

  it('the tests run with VOICE and VOICE_DAILY_NEURONS pinned (a leftover .dev.vars cannot change them)', () => {
    expect(raw.VOICE).toBe('on')
    expect(raw.VOICE_DAILY_NEURONS).toBe('3000')
    expect(raw.ENV).toBe('production')
    expect(raw.AI).toBeUndefined()
  })

  it('the README names the day-5 deploy steps and the local config', () => {
    const r = raw.WORKER_README_SOURCE
    expect(r).toContain('0004_spoken.sql')
    expect(r).toContain('--config wrangler.local.toml')
    expect(r).toContain('VOICE')
    expect(r).toContain('--data-binary')
  })
})
