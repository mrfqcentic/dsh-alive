/**
 * Durable storage for the voice binding: the `voice_binding` domain on the
 * storage hub, one `binding` table record keyed `current`. The unit uses the
 * `per-record` layout so a malformed or stale binding document reads as
 * absent instead of refusing the whole unit, and schema-invalid records are
 * backed up and skipped — a lost binding only costs a new session, and
 * startup must not fail on it. Writes stay in the domain's single chain.
 * @module @deepseek-ai/dsh-voice-alive/binding/storage
 */

import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import type { Domain, DomainSpec, DomainTableSpec, KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { BindingRecord, BindingStorage } from './types.ts'

/** Key of the single record inside the `binding` table. */
const BINDING_KEY = 'current'

/** Durable record schema; validated at the storage boundary. */
export const bindingRecordSchema = z.object({
  sessionId: z.string().min(1),
  workspaceId: z.string().min(1),
  updatedAt: z.iso.datetime({ precision: 3 }),
}).strict()

/** The one table declaration, key-typed by its single record key. */
const bindingTable: DomainTableSpec<typeof BINDING_KEY, BindingRecord> = { valueSchema: bindingRecordSchema }

/**
 * The binding domain: identity, version, layout, and record schema in one
 * declaration. The shipped composition routes it to the json backend, so the
 * record lands at `<storage root>/voice_binding/binding/current.json`.
 *
 * Declared as a spec object because this Client/Host package may not import
 * `defineDomain`: the dependency policy requires a Host runtime export to be
 * duplicate-install-safe, and storage-domain's constructors are not classified.
 */
export const voiceBindingDomain = {
  name: 'voice_binding',
  version: 1,
  layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  tables: {
    binding: bindingTable,
  },
} satisfies DomainSpec

/**
 * Mount the binding storage over `ctx.storageDomain`.
 *
 * The domain opens lazily on the first read or write, so a medium failure
 * surfaces where the binding already treats storage as recoverable. A
 * rejected open is retried by the next operation instead of staying cached
 * as a permanent failure.
 * @param ctx - Host context that owns the domain lifetime.
 * @returns the durable binding record port.
 */
export function createVoiceBindingStorage(ctx: Context): BindingStorage {
  let domain: Domain<typeof voiceBindingDomain> | undefined
  let opening: Promise<Domain<typeof voiceBindingDomain>> | undefined
  let disposed = false

  ctx.effect(() => () => {
    disposed = true
    return domain?.close()
  }, 'voiceBinding.storageClose')

  const open = async (): Promise<Domain<typeof voiceBindingDomain>> => {
    if (domain !== undefined) return domain
    opening ??= ctx.storageDomain.open(voiceBindingDomain).then(
      (opened) => {
        domain = opened
        return opened
      },
      (error: unknown) => {
        opening = undefined
        throw error
      },
    )
    const opened = await opening
    if (disposed) {
      await opened.close()
      domain = undefined
      throw new Error('voice binding storage is closed')
    }
    return opened
  }

  const table = async (): Promise<KvTable<typeof BINDING_KEY, BindingRecord>> =>
    (await open()).table('binding')

  return {
    async read() {
      return (await table()).get(BINDING_KEY) ?? null
    },
    async write(record) {
      await (await table()).put(BINDING_KEY, record)
    },
    async clear() {
      await (await table()).delete(BINDING_KEY)
    },
  }
}
