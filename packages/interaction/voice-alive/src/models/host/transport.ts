/**
 * HTTP port of the model store.
 *
 * The only network traffic the voice layer produces is a pinned model download,
 * so the transport exposes exactly one operation: fetch a file, resuming from a
 * byte offset when the caller already holds a partial payload.
 * @module @deepseek-ai/dsh-voice-alive/models/host/transport
 */
/** One response body as the downloader consumes it. */
export interface DownloadResponse {
  /** HTTP status; `200` is a full body, `206` a resumed body. */
  readonly status: number
  /** Chunks in arrival order, or null when the server sent no body. */
  readonly body: AsyncIterable<Uint8Array> | null
}

/** One file request. */
export interface DownloadRequest {
  /** Byte offset to resume from; zero requests the whole file. */
  readonly offset: number
  /** Cancels the request and its body. */
  readonly signal: AbortSignal
}

/** File transport the downloader drives. */
export interface ModelTransport {
  /**
   * Request one pinned file.
   * @param url - revision-pinned https URL.
   * @param request - resume offset and cancellation.
   * @returns the response status and body.
   */
  get(url: string, request: DownloadRequest): Promise<DownloadResponse>
}

/** The subset of `fetch` the transport uses; the global function satisfies it. */
export type TransportFetch = (url: string, init: {
  readonly headers: Record<string, string>
  readonly signal: AbortSignal
}) => Promise<DownloadResponse>

/**
 * Create the fetch-backed transport.
 * @param fetchImpl - fetch implementation; tests pass a fake, production omits it.
 * @returns a transport that sends `Range` only when resuming.
 */
export function createFetchTransport(fetchImpl: TransportFetch = fetch): ModelTransport {
  return {
    async get(url, request) {
      const response = await fetchImpl(url, {
        headers: request.offset === 0 ? {} : { Range: `bytes=${String(request.offset)}-` },
        signal: request.signal,
      })
      return { status: response.status, body: response.body }
    },
  }
}
