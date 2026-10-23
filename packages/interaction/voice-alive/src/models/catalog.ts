/**
 * The pinned v1 model catalog.
 *
 * Every entry names revision-pinned https URLs, the exact byte count, and the
 * SHA-256 of each file, plus the directory layout its engine expects:
 * `load(model, directory)` for a recognizer and `load(directory, { voice })` for
 * Kokoro. Nothing here downloads, imports a runtime, or reads the disk, so both
 * the Host store and the Models pane can use it.
 * @module @deepseek-ai/dsh-voice-alive/models/catalog
 */
import type { ModelId, ModelRecord } from './types.ts'

/** Host serving every pinned file; the only network origin the catalog uses. */
const HUGGING_FACE = 'https://huggingface.co'

/**
 * Build one revision-pinned file URL.
 * @param repository - Hugging Face repository id.
 * @param revision - Immutable commit the catalog pins.
 * @param path - Path inside the repository.
 * @returns absolute https URL of the exact bytes.
 */
function pinned(repository: string, revision: string, path: string): string {
  return `${HUGGING_FACE}/${repository}/resolve/${revision}/${path}`
}

/** Whisper base, multilingual conversion for sherpa-onnx. */
const WHISPER_REPOSITORY = 'csukuangfj/sherpa-onnx-whisper-base'
const WHISPER_REVISION = 'bb53ee204431c90d314c1cc08d28d23e5b7927cc'

/** Parakeet TDT 0.6B v3, int8 conversion for sherpa-onnx. */
const PARAKEET_REPOSITORY = 'csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8'
const PARAKEET_REVISION = '2bda32ec70b097a55adaa07d9a7173915b43cc78'

/** Kokoro-82M ONNX weights and tokenizer used by kokoro-js. */
const KOKORO_REPOSITORY = 'onnx-community/Kokoro-82M-v1.0-ONNX'
const KOKORO_REVISION = '1939ad2a8e416c0acfeecc08a694d14ef25f2231'

/**
 * Every model v1 can install. Order is display order, and the first ready entry
 * of a kind is the default when the user has not chosen one.
 */
export const MODEL_CATALOG: readonly ModelRecord[] = [
  {
    id: 'whisper-base',
    kind: 'asr',
    engine: 'whisper',
    name: 'Whisper base',
    summary: 'Recommended multilingual recognizer, int8 weights.',
    languages: ['Multilingual, 99 languages'],
    required: true,
    license: 'MIT',
    attribution: 'OpenAI Whisper base, converted for sherpa-onnx by csukuangfj',
    files: [
      {
        path: 'encoder.int8.onnx',
        url: pinned(WHISPER_REPOSITORY, WHISPER_REVISION, 'base-encoder.int8.onnx'),
        bytes: 29120534,
        sha256: '0b8fb1304b6109976038efff5ace81720e00386f3ff6b54ee8c75291ca0a1e11',
      },
      {
        path: 'decoder.int8.onnx',
        url: pinned(WHISPER_REPOSITORY, WHISPER_REVISION, 'base-decoder.int8.onnx'),
        bytes: 130672026,
        sha256: '9759d217388a01b3a4c7c15533201067b48ae819c4daafc8624e64b9409dc02d',
      },
      {
        path: 'tokens.txt',
        url: pinned(WHISPER_REPOSITORY, WHISPER_REVISION, 'base-tokens.txt'),
        bytes: 816730,
        sha256: 'b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126',
      },
    ],
  },
  {
    id: 'parakeet-v3',
    kind: 'asr',
    engine: 'parakeet',
    name: 'Parakeet TDT 0.6B v3',
    summary: 'Alternative recognizer, int8 transducer weights.',
    languages: ['25 European languages'],
    required: false,
    license: 'CC-BY-4.0',
    attribution: 'NVIDIA Parakeet TDT 0.6B v3, converted for sherpa-onnx by csukuangfj',
    files: [
      {
        path: 'encoder.int8.onnx',
        url: pinned(PARAKEET_REPOSITORY, PARAKEET_REVISION, 'encoder.int8.onnx'),
        bytes: 652184281,
        sha256: 'acfc2b4456377e15d04f0243af540b7fe7c992f8d898d751cf134c3a55fd2247',
      },
      {
        path: 'decoder.int8.onnx',
        url: pinned(PARAKEET_REPOSITORY, PARAKEET_REVISION, 'decoder.int8.onnx'),
        bytes: 11845275,
        sha256: '179e50c43d1a9de79c8a24149a2f9bac6eb5981823f2a2ed88d655b24248db4e',
      },
      {
        path: 'joiner.int8.onnx',
        url: pinned(PARAKEET_REPOSITORY, PARAKEET_REVISION, 'joiner.int8.onnx'),
        bytes: 6355277,
        sha256: '3164c13fc2821009440d20fcb5fdc78bff28b4db2f8d0f0b329101719c0948b3',
      },
      {
        path: 'tokens.txt',
        url: pinned(PARAKEET_REPOSITORY, PARAKEET_REVISION, 'tokens.txt'),
        bytes: 93939,
        sha256: 'd58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d',
      },
    ],
  },
  {
    id: 'kokoro',
    kind: 'tts',
    engine: 'kokoro',
    name: 'Kokoro-82M',
    summary: 'Required voice synthesizer, quantized ONNX weights and tokenizer.',
    languages: ['English, US and UK voices'],
    required: true,
    license: 'Apache-2.0',
    attribution: 'hexgrad Kokoro-82M, ONNX export by onnx-community',
    files: [
      {
        path: 'onnx/model_quantized.onnx',
        url: pinned(KOKORO_REPOSITORY, KOKORO_REVISION, 'onnx/model_quantized.onnx'),
        bytes: 92361116,
        sha256: 'fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478',
      },
      {
        path: 'config.json',
        url: pinned(KOKORO_REPOSITORY, KOKORO_REVISION, 'config.json'),
        bytes: 44,
        sha256: 'df34b4f930b23447cd4dc410fabfb42eb3f24e803e6c3f97d618fb359380a36f',
      },
      {
        path: 'tokenizer.json',
        url: pinned(KOKORO_REPOSITORY, KOKORO_REVISION, 'tokenizer.json'),
        bytes: 3497,
        sha256: '77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34',
      },
      {
        path: 'tokenizer_config.json',
        url: pinned(KOKORO_REPOSITORY, KOKORO_REVISION, 'tokenizer_config.json'),
        bytes: 113,
        sha256: 'be1cb066d6ef6b074b3f15e6a6dd21ac88ff3cdaedf325f0aaed686c70f75d20',
      },
    ],
  },
]

/**
 * Look up one catalog entry.
 * @param id - model id to resolve.
 * @returns the entry, or undefined when no catalog row carries that id.
 */
export function catalogEntry(id: ModelId): ModelRecord | undefined {
  return MODEL_CATALOG.find(record => record.id === id)
}

/**
 * Total pinned byte count of one entry.
 * @param record - catalog entry.
 * @returns the sum of its files' expected sizes.
 */
export function modelBytes(record: ModelRecord): number {
  let total = 0
  for (const file of record.files) total += file.bytes
  return total
}
