/**
 * Download policy for one catalog entry.
 *
 * Bytes land in the staging directory as `.part` files and are verified against
 * the catalog's pinned size and SHA-256 before the whole directory is renamed
 * into place, so an engine never sees a partial or corrupt model. A retry
 * resumes each partial file with a `Range` request and never re-downloads a file
 * that already matches its pin; a hash mismatch deletes the payload instead of
 * resuming bytes that are already wrong.
 * @module @deepseek-ai/dsh-voice-alive/models/host/download
 */
import { dirname } from 'node:path'
import { modelBytes } from '../catalog.ts'
import type { ModelFile, ModelRecord } from '../types.ts'
import { ModelStoreError, diskStep, reasonOf } from './errors.ts'
import type { FileSink, ModelFileSystem } from './io.ts'
import { filePath, modelDirectory, partPath, stagingDirectory } from './layout.ts'
import type { DownloadResponse, ModelTransport } from './transport.ts'

/** Cumulative bytes present for one model. */
export interface DownloadProgress {
  /** Bytes on disk for the whole model, including files kept from an earlier attempt. */
  readonly receivedBytes: number
  /** Pinned byte count of the whole model. */
  readonly totalBytes: number
}

/** Everything one download needs; the store owns the lifecycle. */
export interface DownloadOptions {
  /** Catalog entry being installed. */
  readonly record: ModelRecord
  /** Model store root. */
  readonly root: string
  /** Filesystem port. */
  readonly fs: ModelFileSystem
  /** HTTP port. */
  readonly transport: ModelTransport
  /** Cancellation signal; aborting stops the transfer and leaves cleanup to the caller. */
  readonly signal: AbortSignal
  /** Called for the initial state, every chunk, and every file kept from an earlier attempt. */
  readonly onProgress: (progress: DownloadProgress) => void
}

/** A response body and the offset it starts at. */
interface BodyPlan {
  /** Offset of the first body byte inside the pinned file. */
  readonly start: number
  /** Chunks in arrival order. */
  readonly body: AsyncIterable<Uint8Array>
}

/**
 * Reject when the caller cancelled.
 * @param signal - download cancellation signal.
 */
function checkCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new ModelStoreError('cancelled', 'Model download was cancelled')
}

/**
 * Request one file, mapping a transport rejection to its typed category.
 * @param transport - HTTP port.
 * @param file - catalog file to fetch.
 * @param offset - resume offset.
 * @param signal - cancellation signal.
 * @returns the response status and body.
 */
async function request(
  transport: ModelTransport,
  file: ModelFile,
  offset: number,
  signal: AbortSignal,
): Promise<DownloadResponse> {
  try {
    return await transport.get(file.url, { offset, signal })
  } catch (error) {
    if (signal.aborted) {
      throw new ModelStoreError('cancelled', 'Model download was cancelled', { cause: error })
    }
    throw new ModelStoreError('network', `download of ${file.path} failed (${reasonOf(error)})`, { cause: error })
  }
}

/**
 * Decide where a response body starts inside the pinned file.
 * @param response - response the server returned.
 * @param file - catalog file being fetched.
 * @param offset - offset requested with `Range`.
 * @returns the body and its start offset.
 * @throws {ModelStoreError} with `network` for an unusable status or a missing body.
 */
function bodyPlan(response: DownloadResponse, file: ModelFile, offset: number): BodyPlan {
  const body = response.body
  if (body === null) {
    throw new ModelStoreError('network', `download of ${file.path} returned no body (HTTP ${String(response.status)})`)
  }
  if (response.status === 206) return { start: offset, body }
  if (response.status === 200) return { start: 0, body }
  throw new ModelStoreError('network', `download of ${file.path} was refused (HTTP ${String(response.status)})`)
}

/**
 * Download every file of one model and finalize its directory.
 * @param options - record, root, ports, cancellation, and progress sink.
 * @returns the finished model directory.
 */
export async function downloadModel(options: DownloadOptions): Promise<string> {
  const { record, root, fs, transport, signal, onProgress } = options
  const totalBytes = modelBytes(record)
  const staging = stagingDirectory(root, record.id)
  const target = modelDirectory(root, record.id)
  let receivedBytes = 0
  const report = (): void => { onProgress({ receivedBytes, totalBytes }) }

  await diskStep(fs.mkdir(staging), 'create the staging directory')
  report()
  for (const file of record.files) {
    checkCancelled(signal)
    const finalPath = filePath(staging, file.path)
    const part = partPath(staging, file.path)
    const existing = await diskStep(fs.size(finalPath), `measure ${file.path}`)
    if (existing !== null) {
      if (existing === file.bytes && await diskStep(fs.hash(finalPath), `verify ${file.path}`) === file.sha256) {
        receivedBytes += file.bytes
        report()
        continue
      }
      await diskStep(fs.remove(finalPath), `remove the unusable ${file.path}`)
    }
    const partial = (await diskStep(fs.size(part), `measure the partial ${file.path}`)) ?? 0
    let offset = partial
    if (partial > file.bytes) {
      await diskStep(fs.remove(part), `restart the oversized partial ${file.path}`)
      offset = 0
    }
    await diskStep(fs.mkdir(dirname(part)), `create the directory for ${file.path}`)
    let response = await request(transport, file, offset, signal)
    if (response.status === 416 && offset > 0) {
      // The server cannot continue from this offset, so the partial is not a prefix of the pin.
      await diskStep(fs.remove(part), `restart the rejected partial ${file.path}`)
      offset = 0
      response = await request(transport, file, offset, signal)
    }
    const { start, body } = bodyPlan(response, file, offset)
    let written = start
    receivedBytes += start
    report()
    const sink: FileSink = await diskStep(fs.write(part, start > 0 ? 'append' : 'truncate'), `open ${file.path}`)
    try {
      for await (const chunk of body) {
        checkCancelled(signal)
        await diskStep(sink.write(chunk), `write ${file.path}`)
        written += chunk.byteLength
        if (written > file.bytes) {
          throw new ModelStoreError('size-mismatch',
            `${file.path} is larger than its pinned ${String(file.bytes)} bytes`)
        }
        receivedBytes += chunk.byteLength
        report()
      }
    } catch (error) {
      if (error instanceof ModelStoreError) throw error
      if (signal.aborted) throw new ModelStoreError('cancelled', 'Model download was cancelled', { cause: error })
      throw new ModelStoreError('network', `download of ${file.path} was interrupted (${reasonOf(error)})`, { cause: error })
    } finally {
      await diskStep(sink.close(), `close ${file.path}`)
    }
    if (written !== file.bytes) {
      // The payload stays for a later resume; a short body is a network failure, not a bad pin.
      throw new ModelStoreError('network',
        `download of ${file.path} ended after ${String(written)} of ${String(file.bytes)} bytes`)
    }
    const digest = await diskStep(fs.hash(part), `verify ${file.path}`)
    if (digest !== file.sha256) {
      await diskStep(fs.remove(part), `remove the corrupt ${file.path}`)
      throw new ModelStoreError('hash-mismatch', `${file.path} does not match its pinned SHA-256 (${digest})`)
    }
    await diskStep(fs.rename(part, finalPath), `finalize ${file.path}`)
  }
  // A directory that appeared while this download ran cannot be merged with it.
  if (await diskStep(fs.exists(target), `check ${record.id}`)) {
    await diskStep(fs.remove(target), `replace ${record.id}`)
  }
  await diskStep(fs.rename(staging, target), `finalize ${record.id}`)
  return target
}
