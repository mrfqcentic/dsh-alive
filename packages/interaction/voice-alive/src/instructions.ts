/**
 * Voice policy instructions: the prompt section that tells the bound Session it
 * is behind the voice panel.
 *
 * The text is the packaged `instructions.md`, read once when the section is
 * installed. The section renders only for the Session the panel is bound to, so
 * a deployment that also serves an ordinary chat surface keeps its prompt.
 *
 * @module @deepseek-ai/dsh-voice-alive/instructions
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Registered name of the voice policy prompt section. */
export const VOICE_INSTRUCTIONS_SECTION = 'voice:policy'

/**
 * Section placement: with the other deployment policies, after plan and team
 * policy and before the tool guidance that starts at `PTC_ONLY`.
 */
const VOICE_INSTRUCTIONS_ORDER = 700

/** The packaged policy text, beside the package root that holds `src/` or `lib/`. */
const INSTRUCTIONS_URL = new URL('../instructions.md', import.meta.url)

/** What one section installation reads from the host row. */
export interface VoiceInstructionsOptions {
  /** The policy text read from the packaged asset. */
  readonly instructions: string
  /** Session the panel follows, or `null` while the row is unbound. */
  readonly boundSessionId: () => string | null
}

/**
 * Read the packaged voice policy.
 * @returns the policy text, verbatim.
 * @throws when the asset is absent, unreadable, or empty, because the panel would otherwise speak with no policy.
 */
export async function loadVoiceInstructions(): Promise<string> {
  const path = fileURLToPath(INSTRUCTIONS_URL)
  let text: string
  try {
    text = await readFile(INSTRUCTIONS_URL, 'utf8')
  } catch (error) {
    throw new Error(`voice instructions are unreadable at ${path}`, { cause: error })
  }
  if (text.trim() === '') {
    throw new Error(`voice instructions are empty at ${path}`)
  }
  return text
}

/**
 * Contribute the voice policy section for the lifetime of the calling plugin.
 *
 * The text renders only while the assembled Agent is the Session the panel is
 * bound to; every other Agent assembles an empty section, which the prompt
 * renderer drops. The fixed section name makes a second installation in one
 * scope a loud duplicate-registration failure rather than doubled policy.
 * @param ctx - context of the plugin that owns the section; its `systemPrompt` must be active.
 * @param options - the policy text and the binding to match against.
 * @returns the section disposer.
 */
export function installVoiceInstructions(ctx: Context, options: VoiceInstructionsOptions): () => void {
  return ctx.systemPrompt.section({
    name: VOICE_INSTRUCTIONS_SECTION,
    order: VOICE_INSTRUCTIONS_ORDER,
    interpolate: false,
    text: ({ agent }) => {
      const boundSessionId = options.boundSessionId()
      if (agent === undefined || boundSessionId === null) return ''
      return String(agent.session.id) === boundSessionId ? options.instructions : ''
    },
  })
}
