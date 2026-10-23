/**
 * Private worker dispatcher for the single published `./worker` slot.
 *
 * The package exports exactly one `./worker` target, so both engines launch
 * `lib/worker.js` through `ELECTRON_RUN_AS_NODE`. The Host names the engine it
 * wants as the first worker argument (`asr` or `tts`); this entry validates that
 * role, then hands the process to the selected role module. The role modules
 * keep their own self-invocation guards, so a role module launched directly from
 * TypeScript still works without the dispatcher.
 * @module @deepseek-ai/dsh-voice-alive/engine/worker
 */
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Worker roles the dispatcher accepts. */
export type WorkerRole = 'asr' | 'tts'

/** Every accepted role, in diagnostic order. */
export const WORKER_ROLES: readonly WorkerRole[] = ['asr', 'tts']

/**
 * Validate the role argument a Host passed after the worker module.
 * @param value - first argument after the worker module.
 * @returns the role, or undefined when the argument is missing or unknown.
 */
export function workerRole(value: string | undefined): WorkerRole | undefined {
  return value === 'asr' || value === 'tts' ? value : undefined
}

/**
 * Rewrite one worker invocation for a selected role module.
 *
 * The role argument is removed and `argv[1]` becomes the role module, which is
 * what each role module's self-invocation guard compares against its own
 * `import.meta.url`. Arguments after the role (the TTS configuration JSON) keep
 * their position relative to the role module.
 * @param role - validated role.
 * @param dispatcherUrl - the dispatcher's `import.meta.url`.
 * @param argv - the dispatcher's process arguments.
 * @returns the role module URL and the arguments the role module must observe.
 */
export function roleInvocation(
  role: WorkerRole,
  dispatcherUrl: string,
  argv: readonly string[],
): { readonly moduleUrl: URL; readonly argv: string[] } {
  const moduleUrl = new URL(`./${role}-worker.js`, dispatcherUrl)
  return {
    moduleUrl,
    argv: [argv[0] ?? process.execPath, fileURLToPath(moduleUrl), ...argv.slice(3)],
  }
}

/**
 * Whether this module is the process entry rather than an import.
 * @param argv - process arguments, whose second element is the entry path.
 * @param moduleUrl - this module's `import.meta.url`.
 * @returns true when both resolve to the same file.
 */
export function isDispatcherInvocation(argv: readonly string[], moduleUrl: string): boolean {
  const entry = argv[1]
  if (entry === undefined) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl))
  } catch {
    return false
  }
}

/* v8 ignore start -- the spawned entry is not observed by V8 coverage; tests exercise the helpers above */
if (isDispatcherInvocation(process.argv, import.meta.url)) {
  const role = workerRole(process.argv[2])
  if (role === undefined) {
    process.stderr.write(
      `voice worker: expected a role argument (${WORKER_ROLES.join(' or ')}), received ${JSON.stringify(process.argv[2])}\n`,
    )
    process.exitCode = 2
  } else {
    const invocation = roleInvocation(role, import.meta.url, process.argv)
    process.argv.splice(0, process.argv.length, ...invocation.argv)
    // The role module owns the process from here: it installs its own protocol
    // listeners and keeps the event loop alive while it serves the Host.
    void import(invocation.moduleUrl.href).catch((error: unknown) => {
      process.stderr.write(`voice worker: the ${role} module failed to load: ${String(error)}\n`)
      process.exitCode = 1
    })
  }
}
/* v8 ignore stop */
