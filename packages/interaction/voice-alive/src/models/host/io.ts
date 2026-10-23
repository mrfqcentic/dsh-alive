/**
 * Filesystem port of the model store.
 *
 * The downloader owns resume, verification, and finalize policy; it reaches the
 * disk only through {@link ModelFileSystem}, so its policy is testable without a
 * real filesystem and the Node implementation stays a thin adapter.
 * @module @deepseek-ai/dsh-voice-alive/models/host/io
 */
import { createReadStream } from 'node:fs'
import { mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'

/** One open append or truncate target. */
export interface FileSink {
  /** @param chunk - bytes to append at the current end. */
  write(chunk: Uint8Array): Promise<void>
  /** Flush and release the handle; a failed close is a disk failure. */
  close(): Promise<void>
}

/** Filesystem operations a download needs. */
export interface ModelFileSystem {
  /** @param directory - directory to create with its parents. */
  mkdir(directory: string): Promise<void>
  /** @param path - file or directory to remove recursively; absent paths are ignored. */
  remove(path: string): Promise<void>
  /** @param path - regular file to measure. @returns its size, or null when absent or not a file. */
  size(path: string): Promise<number | null>
  /** @param path - path to test. @returns whether anything exists there. */
  exists(path: string): Promise<boolean>
  /** @param path - file to open. @param mode - append to existing bytes, or truncate. @returns the open sink. */
  write(path: string, mode: 'append' | 'truncate'): Promise<FileSink>
  /** @param from - existing path. @param to - destination, replaced if present. */
  rename(from: string, to: string): Promise<void>
  /** @param path - file to digest. @returns lowercase hex SHA-256 of its bytes. */
  hash(path: string): Promise<string>
}

/**
 * Whether a thrown filesystem error means the path does not exist.
 * @param error - error a filesystem call rejected with.
 * @returns true for an ENOENT cause.
 */
function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

/**
 * Create the Node filesystem adapter.
 * @returns the port the store uses in production.
 */
export function createNodeFileSystem(): ModelFileSystem {
  return {
    async mkdir(directory) {
      await mkdir(directory, { recursive: true, mode: 0o700 })
    },
    async remove(path) {
      await rm(path, { recursive: true, force: true })
    },
    async size(path) {
      try {
        const info = await stat(path)
        return info.isFile() ? info.size : null
      } catch (error) {
        if (isMissing(error)) return null
        throw error
      }
    },
    async exists(path) {
      try {
        await stat(path)
        return true
      } catch (error) {
        if (isMissing(error)) return false
        throw error
      }
    },
    async write(path, mode) {
      const handle = await open(path, mode === 'append' ? 'a' : 'w')
      return {
        async write(chunk) {
          await handle.write(chunk)
        },
        async close() {
          await handle.close()
        },
      }
    },
    async rename(from, to) {
      await rename(from, to)
    },
    async hash(path) {
      const digest = createHash('sha256')
      const stream: AsyncIterable<Buffer> = createReadStream(path)
      for await (const chunk of stream) digest.update(chunk)
      return digest.digest('hex')
    },
  }
}
