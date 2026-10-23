/**
 * Host wiring for the voice binding: the Audio workspace directory, the
 * workspace and session lookups, and the durable record adapter over the
 * composed harness services. Kept separate from the binding itself so its
 * behavior can be tested against fake registries.
 * @module @deepseek-ai/dsh-voice-alive/binding/harness
 */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-app-boot'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { createVoiceBindingStorage } from './storage.ts'
import type { BindingDeps } from './types.ts'

/** Display title of the Audio workspace, fixed by the product spec. */
export const VOICE_WORKSPACE_TITLE = 'Voice'

/**
 * Audio workspace directory under the profile's Harness home
 * (`~/.dsh/voice/workspace` by default), fixed by the product spec.
 * @param home - resolved Harness home of the launching profile.
 * @returns the absolute directory the Audio workspace owns.
 */
export function voiceWorkspaceDirectory(home: string): string {
  return join(home, 'voice', 'workspace')
}

/**
 * Build the binding dependencies from the composed host services. The caller
 * must inject `storageDomain`, `workspaceRegistry`, `sessions`,
 * `sessionPersistence`, and `sessionController`; creating the Audio workspace
 * additionally requires the launch profile's `profileContext` for its home.
 * @param ctx - Host context carrying those services.
 * @returns dependencies for {@link createVoiceBinding}.
 */
export function createVoiceBindingDeps(ctx: Context): BindingDeps {
  return {
    storage: createVoiceBindingStorage(ctx),
    workspaces: {
      get(workspaceId) {
        const workspace = ctx.workspaceRegistry.get(brandString<WorkspaceId>(workspaceId))
        return workspace === undefined ? undefined : { workspaceId: workspace.id, path: workspace.path }
      },
      async ensure() {
        const profile = ctx.get('profileContext')
        if (profile === undefined) {
          throw new Error('voice binding requires a dsh profile: profileContext is absent')
        }
        const path = voiceWorkspaceDirectory(profile.home)
        await mkdir(path, { recursive: true, mode: 0o700 })
        const workspace = await ctx.workspaceRegistry.create(path, VOICE_WORKSPACE_TITLE)
        return { workspaceId: workspace.id, path: workspace.path }
      },
    },
    sessions: {
      async status(sessionId) {
        const id = brandString<SessionId>(sessionId)
        if (ctx.workspaceRegistry.archivedSessionIds.includes(id)) return 'archived'
        if (ctx.sessions.get(id) !== undefined) return 'active'
        return (await ctx.sessionPersistence.stat(id)) === undefined ? 'missing' : 'active'
      },
      async create(workspace) {
        const created = await ctx.sessionController.create({
          workspaceId: brandString<WorkspaceId>(workspace.workspaceId),
        })
        return created.sessionId
      },
    },
    warn(message) {
      ctx.logger.warn(message)
    },
  }
}
