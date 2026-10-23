/**
 * On-disk layout of the model store.
 *
 * Only the finished directory is ever handed to an engine:
 *
 * ```
 * <root>/<id>/                verified weights, exactly the names the engine reads
 * <root>/.staging/<id>/       staging directory, renamed into place on finalize
 * <root>/.staging/<id>/x.part unfinished download of one file
 * ```
 *
 * Staging sits beside the finished directory so the finalize rename stays
 * inside one filesystem and is therefore atomic.
 * @module @deepseek-ai/dsh-voice-alive/models/host/layout
 */
import { join } from 'node:path'
import type { ModelId } from '../types.ts'

/** Child of the store root that holds every staging directory. */
const STAGING = '.staging'

/**
 * Finished directory of one model; this is what an engine loads.
 * @param root - model store root.
 * @param id - catalog entry.
 * @returns absolute directory of the verified weights.
 */
export function modelDirectory(root: string, id: ModelId): string {
  return join(root, id)
}

/**
 * Staging directory one download writes into before finalize.
 * @param root - model store root.
 * @param id - catalog entry.
 * @returns absolute staging directory.
 */
export function stagingDirectory(root: string, id: ModelId): string {
  return join(root, STAGING, id)
}

/**
 * Resolve one catalog file inside a directory.
 * @param directory - finished or staging directory.
 * @param relative - catalog file path, possibly nested.
 * @returns absolute path of the file.
 */
export function filePath(directory: string, relative: string): string {
  return join(directory, relative)
}

/**
 * Resolve the partial file a download appends to.
 * @param directory - finished or staging directory.
 * @param relative - catalog file path, possibly nested.
 * @returns absolute path of the `.part` file.
 */
export function partPath(directory: string, relative: string): string {
  return join(directory, `${relative}.part`)
}
