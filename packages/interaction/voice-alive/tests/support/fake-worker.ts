/** Protocol-speaking child double used by the ASR engine tests; never starts a real process. */
import { PassThrough, Writable } from 'node:stream'
import type {
  AsrChildProcess,
  AsrWorkerCommand,
  AsrWorkerResponse,
  SpawnAsrOptions,
  SpawnFn,
} from '../../src/engine/types.ts'

/** One recorded spawn with the fake it returned. */
export interface SpawnCall {
  readonly command: string
  readonly args: readonly string[]
  readonly options: SpawnAsrOptions
  readonly worker: FakeWorker
}

interface FakeWorkerOptions {
  /** Whether to announce readiness; `false` models a worker that hangs before the handshake. */
  readonly hello?: boolean
  /** Protocol version carried by the readiness frame. */
  readonly protocol?: number
  /** Whether the child exposes a stderr channel. */
  readonly stderr?: boolean
  /** Handler invoked for every parsed command; the default answers load, transcribe, and shutdown. */
  readonly onCommand?: (command: AsrWorkerCommand, worker: FakeWorker) => void
}

/**
 * In-memory worker: commands arrive through a Writable, frames leave through a
 * PassThrough, and lifecycle events are delivered directly to the engine.
 */
export class FakeWorker implements AsrChildProcess {
  stdin: NodeJS.WritableStream | null
  protocol: NodeJS.ReadableStream | null
  stderr: NodeJS.ReadableStream | null
  readonly commands: AsrWorkerCommand[] = []
  readonly killSignals: Array<NodeJS.Signals | undefined> = []
  /** Emit `false` to keep the child alive after a shutdown command. */
  autoExitOnShutdown = true
  /** Overrides the default answer for one command. */
  onCommand: ((command: AsrWorkerCommand, worker: FakeWorker) => void) | undefined
  private readonly protocolStream = new PassThrough()
  private readonly stderrStream = new PassThrough()
  private readonly stdinStream: Writable
  private readonly exitListeners = new Set<(code: number | null, signal: NodeJS.Signals | null) => void>()
  private readonly errorListeners = new Set<(error: Error) => void>()
  private exited = false

  constructor(options: FakeWorkerOptions = {}) {
    this.protocol = this.protocolStream
    this.stderr = options.stderr === false ? null : this.stderrStream
    this.onCommand = options.onCommand
    this.stdinStream = new Writable({
      write: (chunk, _encoding, done) => {
        this.receive(String(chunk))
        done()
      },
    })
    this.stdin = this.stdinStream
    if (options.hello !== false) this.send({ type: 'hello', protocol: options.protocol ?? 1 })
  }

  /** @returns the last command received, or undefined before the first one. */
  get lastCommand(): AsrWorkerCommand | undefined {
    return this.commands[this.commands.length - 1]
  }

  /** @param frame - response frame written to the protocol descriptor. */
  send(frame: AsrWorkerResponse): void {
    this.protocolStream.write(`${JSON.stringify(frame)}\n`)
  }

  /** @param text - arbitrary bytes for the protocol descriptor, for framing-failure tests. */
  sendRaw(text: string): void {
    this.protocolStream.write(text)
  }

  /** @param text - diagnostic bytes the engine may include in crash messages. */
  writeStderr(text: string): void {
    this.stderrStream.write(text)
  }

  /** @param error - protocol pipe failure delivered as a stream error event. */
  emitProtocolError(error: Error): void {
    this.protocolStream.emit('error', error)
  }

  /** @param error - command pipe failure delivered as a stream error event. */
  emitStdinError(error: Error): void {
    this.stdinStream.emit('error', error)
  }

  /** Answer a previously captured command with the fake's default reply. */
  respond(command: AsrWorkerCommand): void {
    this.answer(command)
  }

  /** @param code - exit code. @param signal - terminating signal, when one was used. */
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exited) return
    this.exited = true
    for (const listener of [...this.exitListeners]) listener(code, signal)
  }

  /** @param error - startup failure delivered as an `error` event instead of an exit. */
  fail(error: Error): void {
    for (const listener of [...this.errorListeners]) listener(error)
    this.exit(null)
  }

  /** Terminate the child with exit code 1, optionally preceded by stderr output. */
  crash(stderr = ''): void {
    if (stderr !== '') this.writeStderr(stderr)
    this.exit(1)
  }

  /** @param signal - termination signal. @returns true; the fake always terminates. */
  kill(signal?: NodeJS.Signals): boolean {
    this.killSignals.push(signal)
    this.exit(null, signal ?? 'SIGKILL')
    return true
  }

  /** @param listener - exit listener. */
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.exitListeners.add(listener)
  }

  /** @param listener - exit listener to remove. */
  offExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.exitListeners.delete(listener)
  }

  /** @param listener - error listener. */
  onError(listener: (error: Error) => void): void {
    this.errorListeners.add(listener)
  }

  /** @param listener - error listener to remove. */
  offError(listener: (error: Error) => void): void {
    this.errorListeners.delete(listener)
  }

  private receive(text: string): void {
    for (const line of text.split('\n')) {
      if (line === '') continue
      const command = JSON.parse(line) as AsrWorkerCommand
      this.commands.push(command)
      if (this.onCommand !== undefined) {
        this.onCommand(command, this)
        continue
      }
      this.answer(command)
    }
  }

  private answer(command: AsrWorkerCommand): void {
    if (command.type === 'load') {
      this.send({ type: 'loaded', id: command.id, model: command.model })
      return
    }
    if (command.type === 'transcribe') {
      this.send({ type: 'result', id: command.id, text: `heard ${command.id}`, durationMs: 5 })
      return
    }
    this.send({ type: 'closed', id: command.id })
    if (this.autoExitOnShutdown) this.exit(0)
  }
}

/** Spawner that returns the queued fakes in order and records every call. */
export interface FakeSpawner {
  readonly spawn: SpawnFn
  readonly calls: SpawnCall[]
}

/**
 * Build a spawn function over prepared fake workers.
 * @param workers - fakes returned in order; later spawns create fresh fakes.
 * @returns the factory plus its call log.
 */
export function createFakeSpawn(...workers: FakeWorker[]): FakeSpawner {
  const calls: SpawnCall[] = []
  const pending = [...workers]
  const spawn: SpawnFn = (command, args, options) => {
    const worker = pending.shift() ?? new FakeWorker()
    calls.push({ command, args, options, worker })
    return worker
  }
  return { spawn, calls }
}
