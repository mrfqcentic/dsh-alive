/**
 * Browser stand-in for `node:module` in the panel build. The client kernel's
 * Loader initialization is the only path that could reach it; a real reach
 * fails loudly instead of silently loading the wrong module system.
 */

/** Fail if the panel runtime reaches Node's module loader. */
export const createRequire = (): never => {
  throw new Error('node:module is not available in the voice panel')
}

/** Type-only peer for the vendored Loader. */
export type LoadHookContext = never
