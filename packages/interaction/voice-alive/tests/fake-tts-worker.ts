/** In-memory protocol peer standing in for the spawned Kokoro worker. */
import { PassThrough } from 'node:stream'
import { createInterface } from 'node:readline'
import type {
  TtsSpawnFn,
  TtsSpawnOptions,
  TtsSynthesizeMessage,
  TtsWorkerProcess,
} from '../src/engine/tts-types.ts'
import { encodeWav } from '../src/engine/tts-worker.ts'

/** One canned WAV shared by fake chunk frames. */
export const FIXTURE_WAV = encodeWav(new Float32Array([0, 0.25, -0.25, 1, -1]), 24_000)

/** Behaviour of one fake worker instance. */
export interface FakeWorkerScript {
  /** Readiness sample rate, or `never` to leave the handshake pending. */
  readonly ready?: number | 'never'
  /** Optional synthesis handler; the default answers one chunk immediately. */
  readonly respond?: (request: TtsSynthesizeMessage, worker: FakeTtsWorker) => Promise<void> | void
  /** Leave stdout open after termination so a stale frame can still be written. */
  readonly keepStreamsOnKill?: boolean
}

/** Spawn call recorded by the fake launcher. */
export interface FakeSpawnCall {
  readonly command: string
  readonly args: readonly string[]
  readonly options: TtsSpawnOptions
}

/** In-memory child process that speaks the worker protocol. */
export class FakeTtsWorker implements TtsWorkerProcess {
  /** Protocol requests received from the engine. */
  readonly requests: TtsSynthesizeMessage[] = []
  /** Request stream. */
  readonly stdin = new PassThrough()
  /** Response stream. */
  readonly stdout = new PassThrough()
  /** Diagnostic stream. */
  readonly stderr = new PassThrough()
  /** Resolves with the exit code when the fake child closes. */
  readonly done: Promise<number | null>
  /** Whether the engine terminated this child. */
  killed = false
  private settle: (code: number | null) => void = () => {}

  /**
   * Start a fake child and schedule its readiness handshake.
   * @param script - Behaviour for this child.
   */
  constructor(private readonly script: FakeWorkerScript = {}) {
    this.done = new Promise((resolve) => { this.settle = resolve })
    const lines = createInterface({ input: this.stdin, crlfDelay: Infinity })
    lines.on('error', () => {
      // The engine owns process failure reporting; keep the fake peer's error path inert.
    })
    lines.on('line', (line) => { this.receive(line) })
    const readyAt = script.ready
    if (readyAt !== 'never') queueMicrotask(() => { this.ready(readyAt ?? 24_000) })
  }

  /**
   * Publish the readiness frame.
   * @param sampleRate - Advertised sample rate.
   */
  ready(sampleRate = 24_000): void {
    if (this.killed) return
    this.stdout.write(`${JSON.stringify({ type: 'ready', sampleRate })}\n`)
  }

  /**
   * Send one chunk frame.
   * @param request - Request being answered.
   * @param overrides - Replacement identity or payload fields.
   */
  chunk(request: TtsSynthesizeMessage, overrides: {
    id?: string
    index?: number
    wav?: ArrayBuffer
    durationMs?: number
  } = {}): void {
    if (this.killed) return
    this.stdout.write(`${JSON.stringify({
      type: 'chunk',
      id: overrides.id ?? request.id,
      index: overrides.index ?? request.index,
      wav: Buffer.from(overrides.wav ?? FIXTURE_WAV).toString('base64'),
      durationMs: overrides.durationMs ?? 5,
    })}\n`)
  }

  /**
   * Send one error frame.
   * @param message - Failure text.
   * @param id - Optional request identity.
   */
  error(message: string, id?: string): void {
    if (this.killed) return
    this.stdout.write(`${JSON.stringify({ type: 'error', message, ...id === undefined ? {} : { id } })}\n`)
  }

  /**
   * Write an arbitrary protocol line.
   * @param line - Raw line without the newline.
   */
  write(line: string): void {
    if (this.killed) return
    this.stdout.write(`${line}\n`)
  }

  /**
   * Exit as a crashed child would.
   * @param detail - Diagnostic text written before exit.
   * @param code - Exit code.
   */
  crash(detail = '', code: number | null = 1): void {
    this.stderr.write(detail)
    this.stdout.end()
    this.stdin.end()
    this.settle(code)
  }

  /** Terminate the child as the engine would. */
  kill(): void {
    if (this.killed) return
    this.killed = true
    if (this.script.keepStreamsOnKill !== true) {
      this.stdout.end()
      this.stdin.end()
    }
    this.settle(null)
  }

  /**
   * Write a frame even after termination.
   * @param line - Raw line without the newline.
   */
  forceWrite(line: string): void {
    this.stdout.write(`${line}\n`)
  }

  private receive(line: string): void {
    if (line.trim() === '') return
    const request = JSON.parse(line) as TtsSynthesizeMessage
    this.requests.push(request)
    if (this.script.respond !== undefined) {
      void Promise.resolve(this.script.respond(request, this))
      return
    }
    this.chunk(request)
  }
}

/** Injectable launcher that records children and applies per-spawn scripts. */
export class FakeSpawner {
  /** Children created so far. */
  readonly workers: FakeTtsWorker[] = []
  /** Arguments each child was launched with. */
  readonly calls: FakeSpawnCall[] = []
  private readonly scripts: FakeWorkerScript[]

  /**
   * Create a launcher.
   * @param scripts - Per-spawn behaviour; missing entries use the default responder.
   */
  constructor(...scripts: FakeWorkerScript[]) {
    this.scripts = scripts
  }

  /** Launcher passed to the engine. */
  readonly spawn: TtsSpawnFn = (command, args, options) => {
    this.calls.push({ command, args, options })
    const worker = new FakeTtsWorker(this.scripts[this.workers.length] ?? {})
    this.workers.push(worker)
    return worker
  }
}
