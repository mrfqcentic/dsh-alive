/** Fetch transport: the only network call the voice layer makes. */
import { expect, it } from 'vitest'
import { createFetchTransport } from '../src/models/host/transport.ts'
import type { DownloadResponse, TransportFetch } from '../src/models/host/transport.ts'

/** @param status - response status. @param chunks - body chunks. @returns a minimal response. */
function response(status: number, chunks: readonly Uint8Array[] = []): DownloadResponse {
  return {
    status,
    body: (async function* (): AsyncGenerator<Uint8Array> {
      for (const chunk of chunks) yield chunk
    })(),
  }
}

it('requests the whole file when no offset is needed', async () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  const fetchImpl: TransportFetch = async (url, init) => {
    calls.push({ url, headers: init.headers })
    return response(200, [new Uint8Array([1, 2])])
  }
  const transport = createFetchTransport(fetchImpl)
  const signal = new AbortController().signal
  const answer = await transport.get('https://models.test/a.bin', { offset: 0, signal })
  expect(calls).toEqual([{ url: 'https://models.test/a.bin', headers: {} }])
  expect(answer.status).toBe(200)
  const chunks: Uint8Array[] = []
  if (answer.body !== null) for await (const chunk of answer.body) chunks.push(chunk)
  expect(chunks).toEqual([new Uint8Array([1, 2])])
})

it('sends a byte range when resuming', async () => {
  let headers: Record<string, string> = {}
  const fetchImpl: TransportFetch = async (_url, init) => {
    headers = init.headers
    return response(206)
  }
  const transport = createFetchTransport(fetchImpl)
  await transport.get('https://models.test/a.bin', { offset: 1024, signal: new AbortController().signal })
  expect(headers).toEqual({ Range: 'bytes=1024-' })
})

it('passes a missing body through', async () => {
  const transport = createFetchTransport(async () => ({ status: 204, body: null }))
  const answer = await transport.get('https://models.test/a.bin', { offset: 0, signal: new AbortController().signal })
  expect(answer.body).toBeNull()
})

it('defaults to the global fetch implementation', () => {
  const transport = createFetchTransport()
  expect(typeof transport.get).toBe('function')
})
