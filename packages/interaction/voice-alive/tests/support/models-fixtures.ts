/** Small pinned catalog shared by the model store and gate suites. */
import type { ModelRecord } from '../../src/models/types.ts'
import { payload, sha256, type ServedBody } from './models-fakes.ts'

/** Model store root used by the model suites. */
export const ROOT = '/models'

/** @param id - catalog id. @param value - pinned bytes. @param url - pinned source. */
function file(id: string, value: Uint8Array, url: string): ModelRecord['files'][number] {
  return { path: `${id}.bin`, url, bytes: value.byteLength, sha256: sha256(value) }
}

export const WHISPER_BYTES = payload(4)
export const PARAKEET_BYTES = payload(6)
export const KOKORO_BYTES = payload(8)

export const WHISPER: ModelRecord = {
  id: 'whisper-base',
  kind: 'asr',
  engine: 'whisper',
  name: 'Whisper test',
  summary: 'Required recognizer fixture.',
  languages: ['English'],
  required: true,
  license: 'MIT',
  attribution: 'test fixture',
  files: [file('whisper-base', WHISPER_BYTES, 'https://models.test/whisper')],
}

export const PARAKEET: ModelRecord = {
  id: 'parakeet-v3',
  kind: 'asr',
  engine: 'parakeet',
  name: 'Parakeet test',
  summary: 'Alternative recognizer fixture.',
  languages: ['English'],
  required: false,
  license: 'CC-BY-4.0',
  attribution: 'test fixture',
  files: [file('parakeet-v3', PARAKEET_BYTES, 'https://models.test/parakeet')],
}

export const KOKORO: ModelRecord = {
  id: 'kokoro',
  kind: 'tts',
  engine: 'kokoro',
  name: 'Kokoro test',
  summary: 'Required voice fixture.',
  languages: ['English'],
  required: true,
  license: 'Apache-2.0',
  attribution: 'test fixture',
  files: [file('kokoro', KOKORO_BYTES, 'https://models.test/kokoro')],
}

/** Catalog shared by the store and gate fixtures. */
export const CATALOG: readonly ModelRecord[] = [WHISPER, PARAKEET, KOKORO]

/** Pinned bytes by source URL. */
const PINNED = new Map<string, Uint8Array>([
  ['https://models.test/whisper', WHISPER_BYTES],
  ['https://models.test/parakeet', PARAKEET_BYTES],
  ['https://models.test/kokoro', KOKORO_BYTES],
])

/**
 * Serve the pinned bytes of one fixture file.
 * @param url - pinned source.
 * @param offset - resume offset.
 * @returns the remaining bytes with the status that matches the offset.
 */
export function servePinned(url: string, offset: number): ServedBody {
  const value = PINNED.get(url) ?? new Uint8Array()
  return { status: offset === 0 ? 200 : 206, chunks: [value.slice(offset)] }
}

/**
 * Files of one fixture as if it were already installed.
 * @param record - fixture to install.
 * @returns file contents keyed by absolute path.
 */
export function installed(record: ModelRecord): Record<string, Uint8Array> {
  const seeded: Record<string, Uint8Array> = {}
  for (const entry of record.files) {
    seeded[`${ROOT}/${record.id}/${entry.path}`] = PINNED.get(entry.url) ?? new Uint8Array()
  }
  return seeded
}
