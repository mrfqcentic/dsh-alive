/**
 * ASR worker process. It loads exactly one sherpa-onnx recognizer on demand and
 * answers one JSON-line command at a time.
 *
 * Commands arrive on standard input; responses leave on the dedicated protocol
 * descriptor (fd 3) so worker diagnostics can never corrupt the data channel.
 * The module also exports its protocol loop and backend loader so tests drive
 * them without a native binary or a child process.
 * @module @deepseek-ai/dsh-voice-alive/engine/asr-worker
 */

import { createWriteStream, readdirSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Readable } from 'node:stream'
import { z } from 'zod'

import {
  ASR_PROTOCOL_VERSION,
  type AsrBackend,
  type AsrBackendLoader,
  type AsrModelId,
  type AsrWorkerFailureCode,
  type AsrWorkerResponse,
} from './types.ts'

/** Largest accepted command line; a longer frame is a protocol failure, not a truncated read. */
const MAX_FRAME_BYTES = 8 * 1024 * 1024

/** Language hint passed to Whisper when the request omits one. */
const AUTO_LANGUAGE = 'auto'

const modelSchema = z.enum(['whisper', 'parakeet'])

const commandSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('load'),
    id: z.string().min(1),
    model: modelSchema,
    modelDirectory: z.string().min(1),
  }).strict(),
  z.object({
    type: z.literal('transcribe'),
    id: z.string().min(1),
    sampleRate: z.literal(16000),
    language: z.string().min(1).optional(),
    pcm: z.string().min(4).regex(/^[A-Za-z0-9+/]+={0,2}$/u).refine(value => value.length % 4 === 0, {
      message: 'base64 payload length is not a multiple of four',
    }),
  }).strict(),
  z.object({ type: z.literal('shutdown'), id: z.string().min(1) }).strict(),
])

/** Minimal sherpa-onnx stream surface used by this worker. */
export interface SherpaStream {
  /**
   * Queue samples for decoding.
   * @param waveform - float samples in [-1, 1] and their rate.
   */
  acceptWaveform(waveform: { samples: Float32Array; sampleRate: number }): void
}

/** Minimal sherpa-onnx offline recognizer surface used by this worker. */
export interface SherpaRecognizer {
  /** @returns a fresh decode stream. */
  createStream(): SherpaStream
  /** @param stream - stream to decode. */
  decode(stream: SherpaStream): void
  /** @param stream - decoded stream. @returns its recognized text and optional token log probabilities. */
  getResult(stream: SherpaStream): { text: string; ys_log_probs?: readonly number[] }
  /** @param config - replacement recognizer configuration; undefined when the binding cannot reconfigure. */
  setConfig: ((config: object) => void) | undefined
}

/** Minimal surface of the `sherpa-onnx-node` CommonJS package. */
export interface SherpaModule {
  OfflineRecognizer: new (config: object) => SherpaRecognizer
  /** Native binding version, when the installed platform package reports one. */
  readonly version?: string
}

/** A worker failure that carries the code the engine maps to a typed error. */
export class AsrWorkerFailure extends Error {
  /**
   * @param code - failure category reported to the engine.
   * @param message - actionable description.
   * @param options - optional cause.
   */
  constructor(readonly code: AsrWorkerFailureCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'AsrWorkerFailure'
  }
}

/**
 * Load the native binding lazily, only when a model is requested.
 * @returns the CommonJS module exports.
 */
export function loadSherpaModule(): SherpaModule {
  // sherpa-onnx-node is CommonJS; a local createRequire keeps the dependency visible to the
  // workspace analysers as an ordinary runtime require.
  const require = createRequire(import.meta.url)
  return require('sherpa-onnx-node') as SherpaModule
}

/** Channels and backend a worker instance owns. */
export interface AsrWorkerOptions {
  /** Newline-delimited command stream, normally standard input. */
  readonly commands: Readable
  /** Sink for response frames, normally fd 3. */
  readonly write: (frame: AsrWorkerResponse) => void
  /** Backend loader invoked by each `load` command. */
  readonly loadBackend: AsrBackendLoader
}

interface BaseFiles {
  readonly encoder: string
  readonly decoder: string
  readonly tokens: string
}

interface WhisperFiles extends BaseFiles {
  readonly model: 'whisper'
}

interface ParakeetFiles extends BaseFiles {
  readonly model: 'parakeet'
  readonly joiner: string
}

interface WhisperConfig {
  readonly featConfig: { readonly sampleRate: number; readonly featureDim: number }
  readonly modelConfig: {
    readonly whisper: {
      readonly encoder: string
      readonly decoder: string
      language: string
      readonly task: string
      readonly tailPaddings: number
    }
    readonly tokens: string
    readonly numThreads: number
    readonly provider: string
    readonly debug: number
  }
}

interface ParakeetConfig {
  readonly featConfig: { readonly sampleRate: number; readonly featureDim: number }
  readonly modelConfig: {
    readonly transducer: { readonly encoder: string; readonly decoder: string; readonly joiner: string }
    readonly tokens: string
    readonly modelType: string
    readonly numThreads: number
    readonly provider: string
    readonly debug: number
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

/**
 * Locate the required weight files inside a model directory.
 * @param model - recognizer family whose file set is required.
 * @param directory - directory the engine validated.
 * @returns absolute paths to every required file.
 * @throws {AsrWorkerFailure} when the directory is absent or a required file is missing.
 */
function discoverFiles(model: AsrModelId, directory: string): WhisperFiles | ParakeetFiles {
  let entries: string[]
  try {
    entries = readdirSync(directory)
  } catch (error) {
    if (isMissing(error)) {
      throw new AsrWorkerFailure('model-not-found', `ASR model directory does not exist: ${directory}`, { cause: error })
    }
    throw new AsrWorkerFailure('model-incompatible', `ASR model directory cannot be read: ${directory}`, { cause: error })
  }
  const pick = (candidates: readonly string[], label: string): string => {
    const found = candidates.find(candidate => entries.includes(candidate))
    if (found === undefined) {
      throw new AsrWorkerFailure('model-incompatible',
        `ASR ${model} model directory is missing ${label} (expected ${candidates.join(' or ')})`)
    }
    const path = join(directory, found)
    // The native loader aborts the whole process on an empty ONNX file instead of raising.
    if (statSync(path).size === 0) {
      throw new AsrWorkerFailure('model-incompatible', `ASR ${model} model file is empty: ${path}`)
    }
    return path
  }
  const tokens = pick(['tokens.txt'], 'tokens.txt')
  const encoder = pick(['encoder.int8.onnx', 'encoder.onnx'], 'encoder.onnx')
  const decoder = pick(['decoder.int8.onnx', 'decoder.onnx'], 'decoder.onnx')
  if (model === 'whisper') return { model, encoder, decoder, tokens }
  return {
    model,
    encoder,
    decoder,
    tokens,
    joiner: pick(['joiner.int8.onnx', 'joiner.onnx'], 'joiner.onnx'),
  }
}

function whisperConfig(files: WhisperFiles): WhisperConfig {
  return {
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      whisper: {
        encoder: files.encoder,
        decoder: files.decoder,
        language: AUTO_LANGUAGE,
        task: 'transcribe',
        tailPaddings: -1,
      },
      tokens: files.tokens,
      numThreads: 2,
      provider: 'cpu',
      debug: 0,
    },
  }
}

function parakeetConfig(files: ParakeetFiles): ParakeetConfig {
  return {
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: files.encoder, decoder: files.decoder, joiner: files.joiner },
      tokens: files.tokens,
      modelType: 'nemo_transducer',
      numThreads: 2,
      provider: 'cpu',
      debug: 0,
    },
  }
}

/**
 * Mean token probability, or undefined when the backend reported no usable scores.
 * @param logProbabilities - per-token natural log probabilities.
 * @returns probability in [0, 1].
 */
function confidenceOf(logProbabilities: readonly number[] | undefined): number | undefined {
  if (logProbabilities === undefined || logProbabilities.length === 0) return undefined
  let total = 0
  for (const value of logProbabilities) {
    if (!Number.isFinite(value)) return undefined
    total += value
  }
  return Math.min(1, Math.max(0, Math.exp(total / logProbabilities.length)))
}

/**
 * Bind a sherpa-onnx recognizer to one validated model directory.
 * @param sherpa - loaded native module.
 * @param model - recognizer family.
 * @param directory - directory holding weights and tokens.
 * @returns a backend that decodes PCM and drops its native recognizer on close.
 * @throws {AsrWorkerFailure} when files are missing or the native loader rejects the configuration.
 */
function createSherpaBackend(sherpa: SherpaModule, model: AsrModelId, directory: string): AsrBackend {
  const files = discoverFiles(model, directory)
  let config: WhisperConfig | ParakeetConfig
  let whisper: WhisperConfig | undefined
  if (files.model === 'whisper') {
    whisper = whisperConfig(files)
    config = whisper
  } else {
    config = parakeetConfig(files)
  }
  let recognizer: SherpaRecognizer
  try {
    recognizer = new sherpa.OfflineRecognizer(config)
  } catch (error) {
    throw new AsrWorkerFailure('model-incompatible',
      `sherpa-onnx rejected the ${model} model in ${directory}: ${describe(error)}`, { cause: error })
  }
  return {
    transcribe(input) {
      if (whisper !== undefined && input.language !== undefined && recognizer.setConfig !== undefined) {
        whisper.modelConfig.whisper.language = input.language
        recognizer.setConfig(config)
      }
      const stream = recognizer.createStream()
      stream.acceptWaveform({ samples: Float32Array.from(input.pcm, value => value / 32768), sampleRate: input.sampleRate })
      recognizer.decode(stream)
      const result = recognizer.getResult(stream)
      const confidence = confidenceOf(result.ys_log_probs)
      return Promise.resolve({ text: result.text.trim(), ...confidence === undefined ? {} : { confidence } })
    },
    async close() {
      // The native recognizer has no explicit destructor; dropping the binding releases its model.
    },
  }
}

/**
 * Build a backend loader around a sherpa-onnx module supplier.
 * @param loadSherpa - returns the native module; the default loads `sherpa-onnx-node` on first use.
 * @returns a loader the worker invokes for each `load` command.
 */
export function createSherpaBackendLoader(
  loadSherpa: () => SherpaModule | Promise<SherpaModule> = loadSherpaModule,
): AsrBackendLoader {
  return async (model, modelDirectory) => createSherpaBackend(await loadSherpa(), model, modelDirectory)
}

/**
 * Decode a base64 PCM payload into samples.
 * @param encoded - base64 text validated by the command schema.
 * @returns little-endian 16-bit samples.
 * @throws {AsrWorkerFailure} when the payload is empty or not a whole number of 16-bit samples.
 */
function decodePcm(encoded: string): Int16Array {
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.byteLength === 0 || bytes.byteLength % 2 !== 0) {
    throw new AsrWorkerFailure('invalid-input', 'ASR audio payload is empty or not 16-bit PCM')
  }
  // Copy into a fresh buffer so the Int16Array view never depends on Buffer pool alignment.
  const copy = new Uint8Array(bytes)
  return new Int16Array(copy.buffer, copy.byteOffset, copy.byteLength / 2)
}

function backendInput(pcm: Int16Array, sampleRate: number, language: string | undefined): {
  pcm: Int16Array
  sampleRate: number
  language?: string
} {
  return language === undefined ? { pcm, sampleRate } : { pcm, sampleRate, language }
}

function errorFrame(error: unknown, id: string): AsrWorkerResponse {
  const code = error instanceof AsrWorkerFailure ? error.code : 'internal'
  return { type: 'error', id, code, message: describe(error) }
}

/**
 * Serve protocol commands until shutdown or command-stream end.
 * @param options - command stream, response sink, and backend loader.
 */
export async function runAsrWorker(options: AsrWorkerOptions): Promise<void> {
  let backend: AsrBackend | undefined
  let buffer = ''
  const write = options.write

  const load = async (command: { id: string; model: AsrModelId; modelDirectory: string }): Promise<void> => {
    const previous = backend
    backend = undefined
    try {
      if (previous !== undefined) await previous.close()
      backend = await options.loadBackend(command.model, command.modelDirectory)
      write({ type: 'loaded', id: command.id, model: command.model })
    } catch (error) {
      write(errorFrame(error, command.id))
    }
  }

  const transcribe = async (command: { id: string; pcm: string; sampleRate: number; language: string | undefined }): Promise<void> => {
    if (backend === undefined) {
      write({ type: 'error', id: command.id, code: 'internal', message: 'ASR worker has no loaded model' })
      return
    }
    try {
      const pcm = decodePcm(command.pcm)
      const started = performance.now()
      const result = await backend.transcribe(backendInput(pcm, command.sampleRate, command.language))
      const durationMs = Math.round(performance.now() - started)
      write({
        type: 'result',
        id: command.id,
        text: result.text,
        ...result.confidence === undefined ? {} : { confidence: result.confidence },
        durationMs,
      })
    } catch (error) {
      write(errorFrame(error, command.id))
    }
  }

  /** @param line - one complete command frame. @returns whether the worker must stop. */
  const handle = async (line: string): Promise<boolean> => {
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      write({ type: 'error', code: 'protocol', message: 'ASR worker received a frame that is not JSON' })
      return false
    }
    const parsed = commandSchema.safeParse(raw)
    if (!parsed.success) {
      write({ type: 'error', code: 'protocol', message: 'ASR worker received an invalid command frame' })
      return false
    }
    const command = parsed.data
    if (command.type === 'load') {
      await load(command)
      return false
    }
    if (command.type === 'transcribe') {
      await transcribe({
        id: command.id,
        pcm: command.pcm,
        sampleRate: command.sampleRate,
        language: command.language,
      })
      return false
    }
    write({ type: 'closed', id: command.id })
    return true
  }

  try {
    write({ type: 'hello', protocol: ASR_PROTOCOL_VERSION })
    for await (const chunk of options.commands) {
      buffer += typeof chunk === 'string' ? chunk : String(chunk)
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        if (line.length > MAX_FRAME_BYTES) {
          write({ type: 'error', code: 'protocol', message: 'ASR worker command frame exceeded its byte limit' })
          return
        }
        if (line.trim() !== '' && await handle(line)) return
      }
      if (buffer.length > MAX_FRAME_BYTES) {
        write({ type: 'error', code: 'protocol', message: 'ASR worker command frame exceeded its byte limit' })
        return
      }
    }
    if (buffer.trim() !== '') {
      write({ type: 'error', code: 'protocol', message: 'ASR worker command frame was not terminated' })
    }
  } finally {
    const current = backend
    backend = undefined
    if (current !== undefined) await current.close()
  }
}

/**
 * Bind the protocol loop to a command stream and a frame sink.
 * @param commands - newline-delimited JSON commands.
 * @param write - frame sink.
 * @param loadBackend - backend loader for `load` commands.
 */
export async function main(commands: Readable, write: (frame: AsrWorkerResponse) => void,
  loadBackend: AsrBackendLoader): Promise<void> {
  await runAsrWorker({ commands, write, loadBackend })
}

/**
 * Whether this module was launched as the worker entry rather than imported.
 * @param argv - process arguments, whose second element is the entry path.
 * @param moduleUrl - this module's `import.meta.url`.
 * @returns true when both resolve to the same file.
 */
export function isWorkerInvocation(argv: readonly string[], moduleUrl: string): boolean {
  const entry = argv[1]
  if (entry === undefined) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl))
  } catch {
    return false
  }
}

/* v8 ignore start -- the spawned entry binds the real stdio descriptors; tests drive runAsrWorker and main directly */
const protocolOutput = createWriteStream('', { fd: 3 })

function writeFrame(frame: AsrWorkerResponse): void {
  protocolOutput.write(`${JSON.stringify(frame)}\n`)
}

if (isWorkerInvocation(process.argv, import.meta.url)) {
  void main(process.stdin, writeFrame, createSherpaBackendLoader()).catch(() => { process.exitCode = 1 })
}
/* v8 ignore stop */
