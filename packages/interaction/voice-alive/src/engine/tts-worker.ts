/**
 * Private Kokoro worker entry. The Host spawns this module with `ELECTRON_RUN_AS_NODE`, passes the
 * model configuration as JSON in `argv[2]`, and speaks JSON lines over stdin/stdout. The first stdout
 * line is the readiness handshake; every later line is a chunk or an error. Nothing else is written to
 * stdout, and the worker never reaches the network.
 */
import { stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import type { Readable, Writable } from 'node:stream'
import type {
  TtsChunkMessage,
  TtsErrorMessage,
  TtsReadyMessage,
  TtsSynthesizeMessage,
  TtsWorkerConfig,
} from './tts-types.ts'

/** Kokoro-82M emits 24 kHz mono audio. */
const KOKORO_SAMPLE_RATE = 24_000

/**
 * Route console output from third-party libraries to stderr so stdout carries protocol frames only.
 */
export function redirectConsole(): void {
  const toStderr = (...args: readonly unknown[]): void => {
    process.stderr.write(`${args.map(value => typeof value === 'string' ? value : String(value)).join(' ')}\n`)
  }
  console.log = toStderr
  console.info = toStderr
  console.warn = toStderr
  console.error = toStderr
  console.debug = toStderr
}

/** PCM returned by one synthesis call. */
export interface SynthesizedAudio {
  /** Mono samples in [-1, 1]. */
  readonly samples: Float32Array
  /** Samples per second. */
  readonly sampleRate: number
}

/** Model backend the protocol loop drives; tests replace it with a fake. */
export interface WorkerBackend {
  /** Sample rate of every buffer this backend returns. */
  readonly sampleRate: number
  /**
   * Synthesize one sentence.
   * @param text - Sentence text.
   * @param voice - Kokoro voice id.
   * @returns Mono PCM and its sample rate.
   */
  synthesize(text: string, voice: string): Promise<SynthesizedAudio>
}

/** Load a model backend from a validated configuration. */
export type BackendLoader = (config: TtsWorkerConfig) => Promise<WorkerBackend>

/**
 * Parse and validate the launch configuration carried in `argv[2]`.
 * @param raw - Raw JSON argument, absent when the Host launched the worker incorrectly.
 * @returns Validated model directory and default voice.
 */
export function parseWorkerConfig(raw: string | undefined): TtsWorkerConfig {
  if (raw === undefined) throw new Error('TTS worker configuration is missing')
  const value: unknown = JSON.parse(raw)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('TTS worker configuration must be an object')
  }
  const record = value as Record<string, unknown>
  if (typeof record.modelDirectory !== 'string' || record.modelDirectory === '') {
    throw new Error('TTS worker modelDirectory must be a non-empty string')
  }
  if (typeof record.voice !== 'string' || record.voice === '') {
    throw new Error('TTS worker voice must be a non-empty string')
  }
  return { modelDirectory: record.modelDirectory, voice: record.voice }
}

/**
 * Choose the ONNX precision matching the files in a model directory.
 * @param modelDirectory - Existing Kokoro model directory.
 * @returns `q8` for `onnx/model_quantized.onnx`, otherwise `fp32` for `onnx/model.onnx`.
 */
export async function resolveKokoroDtype(modelDirectory: string): Promise<'q8' | 'fp32'> {
  const quantized = join(modelDirectory, 'onnx', 'model_quantized.onnx')
  const full = join(modelDirectory, 'onnx', 'model.onnx')
  if (await exists(quantized)) return 'q8'
  if (await exists(full)) return 'fp32'
  throw new Error(`Kokoro model is missing: expected ${quantized} or ${full}`)
}

/**
 * Test whether a path exists as a regular file.
 * @param path - Candidate file.
 * @returns true for an existing file.
 */
async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/**
 * Encode mono float PCM as a complete 16-bit PCM WAV.
 * @param samples - Mono samples in [-1, 1]; values outside that range are clamped.
 * @param sampleRate - Samples per second.
 * @returns Self-contained RIFF/WAVE bytes with correct sizes.
 */
export function encodeWav(samples: Float32Array, sampleRate: number = KOKORO_SAMPLE_RATE): ArrayBuffer {
  const dataBytes = samples.length * 2
  const buffer = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(buffer)
  writeString(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeString(view, 8, 'WAVE')
  writeString(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeString(view, 36, 'data')
  view.setUint32(40, dataBytes, true)
  let offset = 44
  for (const value of samples) {
    const sample = Math.max(-1, Math.min(1, value))
    view.setInt16(offset, sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff), true)
    offset += 2
  }
  return buffer
}

/**
 * Write an ASCII chunk identifier into a WAV header.
 * @param view - Destination view.
 * @param offset - Byte offset.
 * @param value - Four-character identifier.
 */
function writeString(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index++) view.setUint8(offset + index, value.charCodeAt(index))
}

/**
 * Drive the protocol loop until stdin closes.
 * @param backend - Model backend.
 * @param input - Request line stream.
 * @param output - Response line stream.
 */
export async function runWorker(backend: WorkerBackend, input: Readable, output: Writable): Promise<void> {
  const lines = createInterface({ input, crlfDelay: Infinity })
  for await (const line of lines) {
    if (line.trim() === '') continue
    let request: TtsSynthesizeMessage
    try {
      request = parseSynthesize(line)
    } catch (error) {
      writeFrame(output, { type: 'error', message: messageOf(error) })
      continue
    }
    try {
      const audio = await backend.synthesize(request.text, request.voice)
      const wav = encodeWav(audio.samples, audio.sampleRate)
      writeFrame(output, {
        type: 'chunk',
        id: request.id,
        index: request.index,
        wav: Buffer.from(wav).toString('base64'),
        durationMs: Math.round(audio.samples.length / audio.sampleRate * 1000),
      } satisfies TtsChunkMessage)
    } catch (error) {
      writeFrame(output, { type: 'error', id: request.id, message: messageOf(error) } satisfies TtsErrorMessage)
    }
  }
}

/**
 * Validate one request line at the process boundary.
 * @param line - Raw JSON line from the Host.
 * @returns Validated synthesis job.
 */
function parseSynthesize(line: string): TtsSynthesizeMessage {
  const value: unknown = JSON.parse(line)
  if (typeof value !== 'object' || value === null) throw new Error('TTS worker request must be an object')
  const record = value as Record<string, unknown>
  if (record.type !== 'synthesize') throw new Error('TTS worker request has an unknown type')
  if (typeof record.id !== 'string' || record.id === '') throw new Error('TTS worker request id must be a non-empty string')
  if (typeof record.index !== 'number' || !Number.isInteger(record.index) || record.index < 0) {
    throw new Error('TTS worker request index must be a non-negative integer')
  }
  if (typeof record.text !== 'string' || record.text === '') throw new Error('TTS worker request text must be a non-empty string')
  if (typeof record.voice !== 'string' || record.voice === '') throw new Error('TTS worker request voice must be a non-empty string')
  return {
    type: 'synthesize', id: record.id, index: record.index, text: record.text, voice: record.voice,
  }
}

/**
 * Write one protocol frame.
 * @param output - Worker stdout.
 * @param frame - Frame to serialize.
 */
function writeFrame(output: Writable, frame: TtsChunkMessage | TtsErrorMessage | TtsReadyMessage): void {
  output.write(`${JSON.stringify(frame)}\n`)
}

/**
 * Extract a human-readable failure message.
 * @param error - Thrown value.
 * @returns Message used in the protocol error frame.
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Load the real Kokoro backend. Imported lazily so a rejected model directory never touches the
 * native runtime, and remote model access is disabled before the model and tokenizer are opened.
 * @param config - Validated worker configuration.
 * @returns Kokoro backend.
 */
/* v8 ignore next -- Kokoro inference requires downloaded weights; the model-present smoke test covers this function. */
async function createKokoroBackend(config: TtsWorkerConfig): Promise<WorkerBackend> {
  /* v8 ignore start -- Kokoro inference requires downloaded weights; the model-present smoke test covers this path. */
  const dtype = await resolveKokoroDtype(config.modelDirectory)
  // Load the package's pinned ONNX runtime before transformers selects a backend.
  await import('onnxruntime-node')
  const [{ KokoroTTS }, { env }] = await Promise.all([
    import('kokoro-js'),
    import('@huggingface/transformers'),
  ])
  env.allowRemoteModels = false
  env.allowLocalModels = true
  const tts = await KokoroTTS.from_pretrained(config.modelDirectory, { dtype, device: 'cpu' })
  return {
    sampleRate: KOKORO_SAMPLE_RATE,
    synthesize: async (text, voice) => {
      if (!Object.hasOwn(tts.voices, voice)) throw new Error(`Kokoro voice is unavailable: ${voice}`)
      const audio = await tts.generate(text, {
        voice: voice as Exclude<NonNullable<Parameters<typeof tts.generate>[1]>['voice'], undefined>,
      })
      return { samples: audio.audio, sampleRate: audio.sampling_rate }
    },
  }
  /* v8 ignore stop */
}

/**
 * Load the backend, publish readiness, then serve synthesis jobs.
 * @param argv - Process argv; `argv[2]` carries the configuration JSON.
 * @param input - Request stream.
 * @param output - Response stream.
 * @param load - Backend factory; the entry uses {@link createKokoroBackend}.
 */
export async function main(
  argv: readonly string[],
  input: Readable,
  output: Writable,
  load: BackendLoader,
): Promise<void> {
  const config = parseWorkerConfig(argv[2])
  const backend = await load(config)
  writeFrame(output, { type: 'ready', sampleRate: backend.sampleRate } satisfies TtsReadyMessage)
  await runWorker(backend, input, output)
}

/* v8 ignore start -- self-invocation runs only inside the spawned child, which V8 coverage does not observe. */
const invoked = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invoked) {
  // Native libraries log during model loading; keep those lines off the protocol stream.
  redirectConsole()
  void main(process.argv, process.stdin, process.stdout, createKokoroBackend).catch((error: unknown) => {
    // Exit once the message flushes: a loaded native runtime would otherwise keep the process alive.
    process.stderr.write(`${messageOf(error)}\n`, () => { process.exit(1) })
  })
}
/* v8 ignore stop */
