// Day 5, job B (BRIEF-D5 3.9): the fake learns Workers AI. Started in this process on 127.0.0.1, a free port; no other host.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createFake, wavProblem, STT_MODEL, LLM_MODEL, HEARD, REPLY } from './fake-upstreams.ts';
import { checkSpoken } from '../triage/spoken.ts';

/** The 44-byte header of BRIEF-D5 3.3 in front of raw 16 kHz mono 16-bit samples (made by code: a tone). */
function wav(seconds: number, over: { rate?: number; dataSize?: number; riffSize?: number; tag?: string } = {}): Buffer {
  const n = Math.round(seconds * 16000);
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 16000)), i * 2);
  const h = Buffer.alloc(44);
  const rate = over.rate ?? 16000;
  h.write(over.tag ?? 'RIFF', 0, 'latin1');
  h.writeUInt32LE(over.riffSize ?? 36 + pcm.length, 4);
  h.write('WAVE', 8, 'latin1');
  h.write('fmt ', 12, 'latin1');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'latin1');
  h.writeUInt32LE(over.dataSize ?? pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

async function withFake(fn: (c: { base: string; stt: (b: unknown, signal?: AbortSignal) => Promise<Response>; llm: (signal?: AbortSignal) => Promise<Response>; mode: (o: unknown) => Promise<Response>; get: (p: string) => Promise<unknown> }) => Promise<void>): Promise<void> {
  const server = createFake({ hangMs: 1500 });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown, signal?: AbortSignal) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
  try {
    await fn({
      base,
      stt: (b, signal) => post(`/ai/run/${STT_MODEL}`, b, signal),
      llm: (signal) => post(`/ai/run/${LLM_MODEL}`, { messages: [{ role: 'user', content: '{}' }], max_tokens: 120, temperature: 0.2 }, signal),
      mode: (o) => post('/_mode', o),
      get: async (p) => (await fetch(`${base}${p}`)).json(),
    });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

const good = (w: Buffer) => ({ audio: w.toString('base64'), language: 'en', vad_filter: true });

test('wavProblem: a good header passes; each field wrong is named', () => {
  assert.equal(wavProblem(wav(1)), null);
  assert.equal(wavProblem(Buffer.alloc(20)), 'short');
  assert.equal(wavProblem(wav(1, { tag: 'RIFX' })), 'riff');
  assert.equal(wavProblem(wav(1, { rate: 8000 })), 'rate');
  assert.equal(wavProblem(wav(1, { dataSize: 5 })), 'data size');
  assert.equal(wavProblem(wav(1, { riffSize: 5 })), 'riff size');
});

test('fake voice: speech call with a good WAV → 200 text, durations and units as the contract says', async () => {
  await withFake(async ({ stt, get }) => {
    const r = await stt(good(wav(2)));
    assert.equal(r.status, 200);
    const j = await r.json() as { success: boolean; result: { text: string; word_count: number; transcription_info: Record<string, unknown>; usage: { neurons: number } } };
    assert.equal(j.success, true);
    assert.equal(j.result.text, HEARD);
    assert.equal(j.result.text, 'Say Thursday at two instead, and thank him for the update.');
    assert.equal(j.result.word_count, 10);
    assert.deepEqual(j.result.transcription_info, { language: 'en', duration: 2, duration_after_vad: 2 });
    assert.ok(Math.abs(j.result.usage.neurons - 0.78 * 2) < 1e-9);
    // /_voice: sizes only, one per speech call
    assert.deepEqual(await get('/_voice'), [{ bytes: 44 + 64000, seconds: 2 }]);
  });
});

test('fake voice: raw samples with no header, a wrong rate, a wrong data size → 400 code 3030, the exact message', async () => {
  await withFake(async ({ stt }) => {
    const w = wav(1);
    for (const bad of [w.subarray(44), wav(1, { rate: 8000 }), wav(1, { dataSize: 10 }), wav(1, { riffSize: 10 }), wav(1, { tag: 'RIFX' })]) {
      const r = await stt(good(bad));
      assert.equal(r.status, 400);
      assert.deepEqual(await r.json(), { success: false, errors: [{ code: 3030, message: 'Failed to decode audio file. Ensure it is a valid audio format.' }] });
    }
    // audio missing or not base64 → the same refusal
    for (const body of [{ language: 'en', vad_filter: true }, { audio: 5, language: 'en', vad_filter: true }, { audio: '***', language: 'en', vad_filter: true }]) {
      const r = await stt(body);
      assert.equal(r.status, 400);
      assert.equal(((await r.json()) as { errors: Array<{ code: number }> }).errors[0].code, 3030);
    }
  });
});

test('fake voice: language not "en" or vad_filter not true → 400 code 9000, the exact message', async () => {
  await withFake(async ({ stt }) => {
    const audio = wav(1).toString('base64');
    for (const body of [{ audio, vad_filter: true }, { audio, language: 'fr', vad_filter: true }, { audio, language: 'en' }, { audio, language: 'en', vad_filter: 'true' }, { audio, language: 'en', vad_filter: false }]) {
      const r = await stt(body);
      assert.equal(r.status, 400, JSON.stringify(Object.keys(body)));
      assert.deepEqual(await r.json(), { success: false, errors: [{ code: 9000, message: 'fake: language and vad_filter are required' }] });
    }
  });
});

test('fake voice: _mode stt silence / 500 / hang / ok', async () => {
  await withFake(async ({ stt, mode }) => {
    assert.equal((await mode({ stt: 'silence' })).status, 200);
    let j = await (await stt(good(wav(1)))).json() as { result: { text: string; transcription_info: { duration_after_vad: number } } };
    assert.equal(j.result.text, '');
    assert.equal(j.result.transcription_info.duration_after_vad, 0);

    assert.equal((await mode({ stt: '500' })).status, 200);
    const r = await stt(good(wav(1)));
    assert.equal(r.status, 500);
    assert.equal(((await r.json()) as { success: boolean }).success, false);

    // hang: no answer within 300 ms (the fake answers after 1.5 s here, 20 s by default)
    assert.equal((await mode({ stt: 'hang' })).status, 200);
    await assert.rejects(stt(good(wav(1)), AbortSignal.timeout(300)));

    assert.equal((await mode({ stt: 'ok' })).status, 200);
    j = await (await stt(good(wav(1)))).json() as typeof j;
    assert.equal(j.result.text, HEARD);
  });
});

test('fake voice: the rewrite, every _mode of llm, and the answers pass checkSpoken as they should', async () => {
  await withFake(async ({ llm, mode, get }) => {
    const text = async () => {
      const r = await llm();
      assert.equal(r.status, 200);
      const j = await r.json() as { success: boolean; result: { response: string; usage: { neurons: number } } };
      assert.equal(j.success, true);
      assert.equal(j.result.usage.neurons, 9.3);
      return j.result.response;
    };
    assert.equal(await text(), 'Thursday at two works for me instead. Thanks for the update.');
    assert.equal(await text(), REPLY);
    assert.deepEqual(checkSpoken(REPLY), { ok: true, draft: REPLY });

    assert.equal((await mode({ llm: 'long' })).status, 200);
    for (let i = 0; i < 3; i++) {
      const t = await text();
      assert.equal(t.length, 200); // long = 200 characters every time
      assert.equal(checkSpoken(t).ok, false);
    }

    assert.equal((await mode({ llm: 'long-once' })).status, 200);
    const first = await text();
    assert.equal(first.length, 200);
    assert.equal(await text(), REPLY); // the next one is fine
    assert.equal(await text(), REPLY);

    assert.equal((await mode({ llm: 'link' })).status, 200);
    const link = await text();
    assert.ok(link.includes('https://'));
    assert.deepEqual(checkSpoken(link), { ok: false, reason: 'unsafe link' });

    assert.equal((await mode({ llm: '500' })).status, 200);
    const r = await llm();
    assert.equal(r.status, 500);
    assert.deepEqual(await r.json(), { success: false, errors: [{ code: 3040, message: 'fake: internal error' }] });

    assert.equal((await mode({ llm: 'hang' })).status, 200);
    await assert.rejects(llm(AbortSignal.timeout(300)));

    assert.equal((await mode({ llm: 'ok' })).status, 200);
    assert.equal(await text(), REPLY);

    // /_seen keeps listing method and path of every request, the rewrite calls included
    const seen = await get('/_seen') as { seen: Array<{ method: string; path: string }> };
    assert.equal(seen.seen.filter((x) => x.method === 'POST' && x.path === `/ai/run/${LLM_MODEL}`).length, 12);
    assert.ok(seen.seen.every((x) => Object.keys(x).join(',') === 'method,path'));
  });
});

test('fake voice: /_mode takes several keys at once, refuses a bad key or value and then changes nothing', async () => {
  await withFake(async ({ stt, llm, mode }) => {
    const j = await (await mode({ stt: 'silence', llm: 'long', send: '500' })).json();
    assert.deepEqual(j, { send: '500', stt: 'silence', llm: 'long' });
    for (const bad of [{ stt: 'nope' }, { llm: 'long-twice' }, { other: 'ok' }, {}, { stt: 'ok', llm: 'nope' }, { stt: 5 }, [], null]) {
      const r = await mode(bad);
      assert.equal(r.status, 400, JSON.stringify(bad));
      assert.deepEqual(await r.json(), { error: 'bad_mode' });
    }
    // nothing changed by the refused calls (including the half-valid one)
    assert.equal(((await (await stt(good(wav(1)))).json()) as { result: { text: string } }).result.text, '');
    assert.equal((((await (await llm()).json()) as { result: { response: string } }).result.response).length, 200);
    assert.equal((await mode({ send: 'ok', stt: 'ok', llm: 'ok' })).status, 200);
  });
});

test('fake voice: /_voice holds sizes only; the clip, the text and the replies are not in it nor in /_seen', async () => {
  await withFake(async ({ stt, llm, get }) => {
    await stt(good(wav(0.5)));
    await stt(good(wav(3)));
    await llm();
    const voice = await get('/_voice') as Array<Record<string, unknown>>;
    assert.deepEqual(voice, [{ bytes: 44 + 16000, seconds: 0.5 }, { bytes: 44 + 96000, seconds: 3 }]);
    for (const row of voice) assert.deepEqual(Object.keys(row), ['bytes', 'seconds']);
    const dump = JSON.stringify([voice, await get('/_seen')]);
    for (const leak of [HEARD, REPLY, 'audio', 'RIFF', 'UklGR']) assert.equal(dump.includes(leak), false, leak); // UklGR = base64 of "RIFF"
  });
});

test('fake voice: a request body over 1 MB is refused 413 and not decoded', async () => {
  await withFake(async ({ base, get }) => {
    const r = await fetch(`${base}/ai/run/${STT_MODEL}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ audio: 'A'.repeat(1_100_000) }) });
    assert.equal(r.status, 413);
    assert.deepEqual(await get('/_voice'), []);
  });
});
