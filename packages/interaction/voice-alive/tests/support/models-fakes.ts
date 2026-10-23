/** In-memory filesystem and transport used by the model store and downloader suites. */
import { createHash } from 'node:crypto'
import type { FileSink, ModelFileSystem } from '../../src/models/host/io.ts'
import type { DownloadRequest, DownloadResponse, ModelTransport } from '../../src/models/host/transport.ts'

/** One recorded filesystem call. */
export interface FsCall {
  readonly operation: string
  readonly path: string
}

/** Conditional failure the test installs on the memory filesystem. */
interface Failure {
  readonly match: (operation: string, path: string) => boolean
  readonly error: Error
}

/** Memory filesystem with recorded calls and injectable failures. */
export interface MemoryFileSystem extends ModelFileSystem {
  readonly files: Map<string, Uint8Array>
  readonly calls: readonly FsCall[]
  /** @param match - selects the calls that fail. @param error - rejection to throw. */
  fail(match: (operation: string, path: string) => boolean, error: Error): void
  /** @param path - path whose calls to count. @param operation - operation to count. @returns matching call count. */
  count(operation: string, path: string): number
}

/** @param value - text to encode. @returns its bytes. */
export function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

/** @param value - bytes to hash. @returns lowercase hex SHA-256. */
export function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * Create an in-memory filesystem.
 * @param seed - initial files keyed by absolute path.
 * @returns the filesystem port plus its inspection helpers.
 */
export function createMemoryFileSystem(seed: Record<string, Uint8Array> = {}): MemoryFileSystem {
  const files = new Map<string, Uint8Array>(Object.entries(seed))
  const calls: FsCall[] = []
  const failures: Failure[] = []
  const within = (prefix: string): string[] =>
    [...files.keys()].filter(key => key === prefix || key.startsWith(`${prefix}/`))
  const guard = (operation: string, path: string): void => {
    calls.push({ operation, path })
    for (const failure of failures) if (failure.match(operation, path)) throw failure.error
  }

  return {
    files,
    calls,
    fail(match, error) {
      failures.push({ match, error })
    },
    count(operation, path) {
      return calls.filter(call => call.operation === operation && call.path === path).length
    },
    async mkdir(directory) {
      guard('mkdir', directory)
    },
    async remove(path) {
      guard('remove', path)
      for (const key of within(path)) files.delete(key)
    },
    async size(path) {
      guard('size', path)
      return files.get(path)?.byteLength ?? null
    },
    async exists(path) {
      guard('exists', path)
      return within(path).length > 0
    },
    async write(path, mode) {
      guard('write', path)
      let content = mode === 'append' ? files.get(path) ?? new Uint8Array() : new Uint8Array()
      const sink: FileSink = {
        async write(chunk) {
          guard('sink-write', path)
          const next = new Uint8Array(content.byteLength + chunk.byteLength)
          next.set(content)
          next.set(chunk, content.byteLength)
          content = next
          files.set(path, content)
        },
        async close() {
          guard('close', path)
        },
      }
      return sink
    },
    async rename(from, to) {
      guard('rename', from)
      for (const key of within(from)) {
        const value = files.get(key)
        if (value !== undefined) files.set(`${to}${key.slice(from.length)}`, value)
        files.delete(key)
      }
    },
    async hash(path) {
      guard('hash', path)
      const value = files.get(path)
      if (value === undefined) throw Object.assign(new Error(`missing ${path}`), { code: 'ENOENT' })
      return sha256(value)
    },
  }
}

/** One recorded transport request. */
export interface TransportCall {
  readonly url: string
  readonly offset: number
}

/** What the fake server answers for one request. */
export interface ServedBody {
  /** HTTP status; defaults to 206 for a resumed request and 200 for a fresh one. */
  readonly status?: number
  /** Chunks the body yields. */
  readonly chunks?: readonly Uint8Array[]
  /** Send no body at all. */
  readonly empty?: boolean
  /** Reject the request instead of answering it. */
  readonly error?: Error
}

/** Memory transport that records requests and serves scripted bodies. */
export interface FakeTransport extends ModelTransport {
  readonly calls: readonly TransportCall[]
}

/**
 * Create the fake transport.
 * @param serve - scripted answer for one request.
 * @returns the transport port plus its recorded requests.
 */
export function createFakeTransport(
  serve: (url: string, offset: number, signal: AbortSignal) => ServedBody | Promise<ServedBody>,
): FakeTransport {
  const calls: TransportCall[] = []
  return {
    calls,
    async get(url: string, request: DownloadRequest): Promise<DownloadResponse> {
      calls.push({ url, offset: request.offset })
      const served = await serve(url, request.offset, request.signal)
      if (served.error !== undefined) throw served.error
      if (served.empty === true) return { status: served.status ?? 200, body: null }
      const chunks = served.chunks ?? []
      const signal = request.signal
      const body = (async function* (): AsyncGenerator<Uint8Array> {
        for (const chunk of chunks) {
          // A real stream cancels at the next read; mirror that so the engine sees the abort.
          if (signal.aborted) throw new Error('The operation was aborted')
          yield chunk
        }
      })()
      return { status: served.status ?? (request.offset === 0 ? 200 : 206), body }
    },
  }
}

/**
 * Build the complete byte payload of a fake file.
 * @param size - byte count.
 * @returns bytes whose every position is its index modulo 251, so a short read is detectable.
 */
export function payload(size: number): Uint8Array {
  const value = new Uint8Array(size)
  for (let index = 0; index < size; index++) value[index] = index % 251
  return value
}
