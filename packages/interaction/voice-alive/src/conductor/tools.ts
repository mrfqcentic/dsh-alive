/**
 * Conductor tools: bind the voice panel to one workspace session and report the
 * registry facts the model speaks about.
 *
 * The four tools are registered on `ctx.tools` by the panel's host row. They
 * read workspaces from `ctx.workspaceRegistry` and sessions from the Host
 * Session controller, so every returned id, title, path, activity instant, and
 * archive flag is a registry fact rather than a guess. A partial or ambiguous
 * workspace name returns candidates; a call that fails before binding reports
 * a typed error and leaves the binding untouched.
 *
 * The durable binding store installs itself with {@link VoiceConductor.setBinding};
 * until then the conductor keeps the last binding in memory.
 *
 * @module @deepseek-ai/dsh-voice-alive/conductor
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-session-title'
import type { JsonSchemaNode, ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { z } from 'zod'

/** Stable failure codes a conductor tool returns. */
export const CONDUCTOR_ERROR_CODES = [
  'WORKSPACE_NOT_FOUND',
  'SESSION_NOT_FOUND',
  'SESSION_ARCHIVED',
  'PERMISSION_DENIED',
] as const

/** One stable conductor failure code. */
export type ConductorErrorCode = typeof CONDUCTOR_ERROR_CODES[number]

/** One registered workspace, as the model receives it. */
export interface ConductorWorkspaceFact {
  /** Stable Workspace id. */
  readonly workspaceId: string
  /** Workspace display title. */
  readonly title: string
  /** Canonical workspace directory. */
  readonly path: string
  /** Sessions the registry accounts to this workspace. */
  readonly sessionCount: number
}

/** One session the panel can bind. */
export interface ConductorSessionFact {
  /** Session id the next utterance routes to. */
  readonly sessionId: string
  /** Latest logged title, or null before the first title lands. */
  readonly title: string | null
  /** Workspace that accounts this session. */
  readonly workspaceId: string
  /** ISO-8601 instant of the last recorded activity, or null while a new session is still unlisted. */
  readonly lastActivityAt: string | null
  /** Whether the registry archive set hides this session from grouping surfaces. */
  readonly archived: boolean
}

/** The panel is bound to one session. */
export interface ConductorBoundResult {
  readonly status: 'bound'
  /** One model-facing sentence naming the binding and its facts. */
  readonly message: string
  readonly session: ConductorSessionFact
  readonly workspace: ConductorWorkspaceFact
  /** True only when this call created the session. */
  readonly created: boolean
}

/** The workspace name needs one more decision; nothing was bound. */
export interface ConductorCandidatesResult {
  readonly status: 'candidates'
  /** One model-facing sentence asking which candidate to use. */
  readonly message: string
  readonly candidates: ConductorWorkspaceFact[]
}

/** The call failed; nothing was bound or created. */
export interface ConductorErrorResult {
  readonly status: 'error'
  readonly code: ConductorErrorCode
  /** One model-facing sentence explaining the failure. */
  readonly message: string
  /** Close workspace matches for `WORKSPACE_NOT_FOUND`; empty for every other code. */
  readonly candidates: ConductorWorkspaceFact[]
}

/** Every result a binding tool returns. */
export type ConductorBindingResult = ConductorBoundResult | ConductorCandidatesResult | ConductorErrorResult

/** Read-only workspace listing. */
export interface ConductorWorkspaceList {
  /** One model-facing block listing every registered workspace. */
  readonly message: string
  readonly workspaces: ConductorWorkspaceFact[]
}

/**
 * The panel's binding sink. The durable storage plugin implements this and
 * installs itself with {@link VoiceConductor.setBinding}.
 */
export interface VoiceBindingTarget {
  /**
   * Record the panel's binding.
   * @param sessionId - Session the panel follows.
   * @param workspaceId - Workspace that accounts the session.
   * @returns resolution after the binding is durable or held in memory.
   */
  bind(sessionId: string, workspaceId: string): Promise<void>
}

/** Maximum candidates named in one result; the message reports the remainder. */
const MAX_CANDIDATES = 8

/** Model-facing schema of one workspace fact. */
const WORKSPACE_FACT_SCHEMA: JsonSchemaNode = {
  type: 'object',
  additionalProperties: false,
  properties: {
    workspaceId: { type: 'string' },
    title: { type: 'string' },
    path: { type: 'string' },
    sessionCount: { type: 'integer' },
  },
  required: ['workspaceId', 'title', 'path', 'sessionCount'],
}

/** Model-facing schema of one bound session fact. */
const SESSION_FACT_SCHEMA: JsonSchemaNode = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sessionId: { type: 'string' },
    title: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    workspaceId: { type: 'string' },
    lastActivityAt: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    archived: { type: 'boolean' },
  },
  required: ['sessionId', 'title', 'workspaceId', 'lastActivityAt', 'archived'],
}

/** Model-facing schema of a completed binding. */
const BOUND_RESULT_SCHEMA: JsonSchemaNode = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', const: 'bound' },
    message: { type: 'string' },
    session: SESSION_FACT_SCHEMA,
    workspace: WORKSPACE_FACT_SCHEMA,
    created: { type: 'boolean' },
  },
  required: ['status', 'message', 'session', 'workspace', 'created'],
}

/** Model-facing schema of an unresolved workspace name. */
const CANDIDATES_RESULT_SCHEMA: JsonSchemaNode = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', const: 'candidates' },
    message: { type: 'string' },
    candidates: { type: 'array', items: WORKSPACE_FACT_SCHEMA },
  },
  required: ['status', 'message', 'candidates'],
}

/** Model-facing schema of a typed conductor failure. */
const ERROR_RESULT_SCHEMA: JsonSchemaNode = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', const: 'error' },
    code: { type: 'string', enum: [...CONDUCTOR_ERROR_CODES] },
    message: { type: 'string' },
    candidates: { type: 'array', items: WORKSPACE_FACT_SCHEMA },
  },
  required: ['status', 'code', 'message', 'candidates'],
}

/** Every result a binding tool returns. */
const BINDING_RESULT_SCHEMA: JsonSchemaNode = {
  oneOf: [BOUND_RESULT_SCHEMA, CANDIDATES_RESULT_SCHEMA, ERROR_RESULT_SCHEMA],
}

/** Model-facing schema of the workspace listing. */
const WORKSPACE_LIST_SCHEMA: JsonSchemaNode = {
  type: 'object',
  additionalProperties: false,
  properties: {
    message: { type: 'string' },
    workspaces: { type: 'array', items: WORKSPACE_FACT_SCHEMA },
  },
  required: ['message', 'workspaces'],
}

/** Model-facing parameters of `voice_open_workspace`. */
const OPEN_WORKSPACE_PARAMETERS = {
  type: 'object',
  properties: {
    name: {
      type: 'string',
      description: 'Workspace title or directory path. A partial name returns candidates instead of binding.',
    },
    mode: {
      type: 'string',
      enum: ['resume', 'new'],
      description: '`resume` continues the workspace\'s most recent session; `new` starts a fresh one.',
    },
  },
  required: ['name', 'mode'],
}

/** Model-facing parameters of `voice_new_session`. */
const NEW_SESSION_PARAMETERS = {
  type: 'object',
  properties: {
    workspace: {
      type: 'string',
      description: 'Workspace title or directory path to create the session in.',
    },
  },
  required: ['workspace'],
}

/** Model-facing parameters of `voice_resume_session`. */
const RESUME_SESSION_PARAMETERS = {
  type: 'object',
  properties: {
    workspace: {
      type: 'string',
      description: 'Workspace title or directory path that accounts the session.',
    },
    session_id: {
      type: 'string',
      description: 'Existing session id. Omit to bind the most recent unarchived session in the workspace.',
    },
  },
  required: ['workspace'],
}

/** Model-facing parameters of `voice_list_workspaces`. */
const LIST_WORKSPACES_PARAMETERS = {
  type: 'object',
  properties: {},
}

const OPEN_WORKSPACE_ARGUMENTS = z.object({
  name: z.string(),
  mode: z.enum(['resume', 'new']),
})

const NEW_SESSION_ARGUMENTS = z.object({ workspace: z.string() })

const RESUME_SESSION_ARGUMENTS = z.object({
  workspace: z.string(),
  session_id: z.string().optional(),
})

/**
 * Build one conductor tool. Tool arguments arrive as untrusted model JSON, so
 * each tool validates them against its zod schema before resolving anything;
 * the output schema is the raw JSON Schema subset the registry enforces.
 * @param options - tool identity, model schemas, argument schema, and body.
 * @returns a registry-ready definition.
 */
function conductorTool<Schema extends z.ZodType>(options: {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly arguments: Schema
  readonly output: JsonSchemaNode
  readonly execute: (args: z.output<Schema>, exec: ToolRunContext) => Promise<unknown>
}): ToolDefinition {
  return {
    name: options.name,
    description: options.description,
    parameters: options.parameters,
    output: {
      schema: options.output,
      render: (_args, value) => renderMessage(value as { message: string }),
    },
    async execute(args, exec) {
      const parsed = options.arguments.safeParse(args)
      if (!parsed.success) {
        const violations = parsed.error.issues.map(issue =>
          `${issue.path.length === 0 ? '(root)' : issue.path.join('.')}: ${issue.message}`)
        throw new Error(`invalid arguments: ${violations.join('; ')}`)
      }
      return await options.execute(parsed.data, exec)
    },
  }
}

/** One workspace resolution: a decision, candidates to ask about, or a miss. */
type WorkspaceResolution =
  | { readonly kind: 'resolved'; readonly workspace: Workspace }
  | { readonly kind: 'candidates'; readonly workspaces: Workspace[] }
  | { readonly kind: 'missing'; readonly matches: Workspace[] }

/** One accounted session joined with its Host summary. */
interface AccountedSession {
  readonly fact: ConductorSessionFact
  readonly updatedAt: number
  readonly summary: SessionSummary
}

/** One exact score marks a name the tool may bind without asking. */
const EXACT_SCORE = 4

/**
 * Score one workspace against a lowercased name: exact title, path, or final
 * path segment wins; prefixes and substrings are partial matches.
 * @param workspace - candidate workspace.
 * @param needle - lowercased search text.
 * @returns 4 for an exact match, 3 for a prefix, 2 for a substring, 0 otherwise.
 */
function workspaceScore(workspace: Workspace, needle: string): number {
  const title = workspace.title.toLowerCase()
  const path = workspace.path.toLowerCase()
  if (title === needle || path === needle || path.slice(path.lastIndexOf('/') + 1) === needle) return EXACT_SCORE
  if (title.startsWith(needle) || path.startsWith(needle)) return 3
  if (title.includes(needle) || path.includes(needle)) return 2
  return 0
}

/**
 * Resolve a workspace name: bind only one exact match, return partial and
 * ambiguous matches as candidates, and report a miss with known workspaces.
 * @param workspaces - registry order.
 * @param name - model-supplied title or path.
 * @returns the resolution to act on.
 */
function resolveWorkspace(workspaces: readonly Workspace[], name: string): WorkspaceResolution {
  const query = name.trim()
  if (query === '') return { kind: 'candidates', workspaces: [...workspaces] }
  const needle = query.toLowerCase()
  const scored = workspaces.map((workspace, index) => ({
    workspace,
    index,
    score: workspaceScore(workspace, needle),
  }))
  const exact = scored.filter(entry => entry.score === EXACT_SCORE)
  if (exact.length > 1) return { kind: 'candidates', workspaces: exact.map(entry => entry.workspace) }
  const only = exact[0]
  if (only !== undefined) return { kind: 'resolved', workspace: only.workspace }
  const partial = scored
    .filter(entry => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
  if (partial.length > 0) return { kind: 'candidates', workspaces: partial.map(entry => entry.workspace) }
  return { kind: 'missing', matches: workspaces.slice(0, MAX_CANDIDATES) }
}

/** Project one registry workspace for the model. */
function workspaceFact(workspace: Workspace): ConductorWorkspaceFact {
  return {
    workspaceId: String(workspace.id),
    title: workspace.title,
    path: workspace.path,
    sessionCount: workspace.sessionIds.length,
  }
}

/** Project one accounted session for the model. */
function sessionFact(summary: SessionSummary, workspaceId: string, archived: boolean): ConductorSessionFact {
  const title = summary.projections?.values.title
  return {
    sessionId: String(summary.sessionId),
    title: typeof title === 'string' && title !== '' ? title : null,
    workspaceId,
    lastActivityAt: new Date(summary.updatedAt).toISOString(),
    archived,
  }
}

/** The newest unarchived accounted session, or undefined when none is available. */
function newestUnarchived(sessions: readonly AccountedSession[]): AccountedSession | undefined {
  let newest: AccountedSession | undefined
  for (const session of sessions) {
    if (session.fact.archived) continue
    if (newest === undefined || session.updatedAt > newest.updatedAt) newest = session
  }
  return newest
}

/** A short quoted candidate list, with the omitted remainder noted. */
function candidateList(workspaces: readonly Workspace[]): string {
  const shown = workspaces.slice(0, MAX_CANDIDATES)
  const omitted = workspaces.length - shown.length
  return `${shown.map(workspace => `"${workspace.title}"`).join(', ')}${omitted === 0 ? '' : ` (+${omitted} more)`}`
}

/** One model-facing sentence naming whatever session the result carries. */
function sessionLabel(session: ConductorSessionFact): string {
  return session.title === null ? `session ${session.sessionId}` : `"${session.title}" (${session.sessionId})`
}

/** One model-facing sentence for a completed binding. */
function boundMessage(workspace: Workspace, session: ConductorSessionFact, created: boolean): string {
  const verb = created ? 'Created and bound' : 'Bound'
  const activity = session.lastActivityAt === null ? '' : ` Last activity ${session.lastActivityAt}.`
  return `${verb} ${sessionLabel(session)} in workspace "${workspace.title}" (${workspace.path}).${activity}`
}

/** One model-facing sentence asking which candidate to use. */
function candidatesMessage(name: string, workspaces: readonly Workspace[]): string {
  if (workspaces.length === 0) return 'A workspace name is required, and no workspaces are registered.'
  const introduction = name.trim() === ''
    ? 'A workspace name is required.'
    : `No exact workspace is named "${name.trim()}".`
  return `${introduction} Candidates: ${candidateList(workspaces)}. Ask which one.`
}

/** One model-facing sentence for an unknown workspace and its close matches. */
function workspaceMissingMessage(name: string, matches: readonly Workspace[]): string {
  const base = `No workspace matches "${name.trim()}".`
  return matches.length === 0 ? base : `${base} Known workspaces: ${candidateList(matches)}.`
}

/** Build one typed failure result. */
function errorResult(
  code: ConductorErrorCode,
  message: string,
  candidates: ConductorWorkspaceFact[],
): ConductorErrorResult {
  return { status: 'error', code, message, candidates }
}

/** Render the result's own prompt-bound sentence. */
function renderMessage(value: { message: string }): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: value.message }]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Conductor tools that bind the voice panel to a workspace session. */
    voiceConductor: VoiceConductor
  }
}

/**
 * `ctx.voiceConductor`: the four workspace/session tools the voice panel's model
 * sees. Each binding tool resolves a workspace and its sessions from the Host
 * registries, records the binding, and reports the facts it acted on.
 */
export class VoiceConductor extends Service {
  static inject = ['tools', 'workspaceRegistry', 'sessionController']

  /** Where bindings are recorded; the durable store replaces the in-memory sink. */
  private target: VoiceBindingTarget = { bind: () => Promise.resolve() }
  private bound: { sessionId: string; workspaceId: string } | null = null

  /**
   * Register the conductor service as `ctx.voiceConductor`.
   * @param ctx - Host plugin context that owns the tools' lifetime.
   */
  constructor(ctx: Context) {
    super(ctx, 'voiceConductor')
  }

  /** Register the four tools when the conductor's dependencies are ready. */
  protected [Service.init](): void {
    const ctx = this.ctx
    ctx.tools.register(conductorTool({
      name: 'voice_list_workspaces',
      description:
        'List every registered workspace with its id, title, directory path, and session count. Read-only.',
      parameters: LIST_WORKSPACES_PARAMETERS,
      arguments: z.object({}),
      output: WORKSPACE_LIST_SCHEMA,
      execute: () => Promise.resolve(this.listWorkspaces()),
    }))

    ctx.tools.register(conductorTool({
      name: 'voice_open_workspace',
      description:
        'Bind the voice panel to a session in one workspace. `mode: "resume"` binds the most recent '
        + 'unarchived session there, creating one when the workspace has none; `mode: "new"` always creates '
        + 'a session. Returns the bound session id, title, workspace, and last activity. A partial or '
        + 'ambiguous `name` returns candidates to ask about instead of binding.',
      parameters: OPEN_WORKSPACE_PARAMETERS,
      arguments: OPEN_WORKSPACE_ARGUMENTS,
      output: BINDING_RESULT_SCHEMA,
      execute: async (args, exec) => this.openWorkspace(args.name, args.mode, exec.signal),
    }))

    ctx.tools.register(conductorTool({
      name: 'voice_new_session',
      description:
        'Create a fresh session in one workspace and bind the voice panel to it. Returns the new session '
        + 'id and its workspace. A partial or ambiguous `workspace` returns candidates instead of creating anything.',
      parameters: NEW_SESSION_PARAMETERS,
      arguments: NEW_SESSION_ARGUMENTS,
      output: BINDING_RESULT_SCHEMA,
      execute: async (args, exec) => this.newSession(args.workspace, exec.signal),
    }))

    ctx.tools.register(conductorTool({
      name: 'voice_resume_session',
      description:
        'Bind the voice panel to an existing session in one workspace. Without `session_id`, binds the most '
        + 'recent unarchived session there. Returns the bound session id, title, workspace, and last activity. '
        + 'A missing, archived, or subagent session is reported, never replaced silently.',
      parameters: RESUME_SESSION_PARAMETERS,
      arguments: RESUME_SESSION_ARGUMENTS,
      output: BINDING_RESULT_SCHEMA,
      execute: async (args, exec) => this.resumeSession(args.workspace, args.session_id, exec.signal),
    }))
  }

  /**
   * Replace the binding sink; the durable store installs itself here.
   * @param target - sink that records every completed binding.
   * @returns nothing.
   */
  setBinding(target: VoiceBindingTarget): void {
    this.target = target
  }

  /**
   * The last binding this process recorded.
   * @returns the bound session and workspace ids, or null before any bind.
   */
  get currentBinding(): { sessionId: string; workspaceId: string } | null {
    return this.bound
  }

  private listWorkspaces(): ConductorWorkspaceList {
    const workspaces = this.ctx.workspaceRegistry.list().map(workspaceFact)
    const message = workspaces.length === 0
      ? 'No workspaces are registered.'
      : [
        `Workspaces (${workspaces.length}):`,
        ...workspaces.map(workspace =>
          `- "${workspace.title}" (${workspace.workspaceId}) — ${workspace.path} — sessions: ${workspace.sessionCount}`),
      ].join('\n')
    return { message, workspaces }
  }

  private async openWorkspace(
    name: string,
    mode: 'resume' | 'new',
    signal: AbortSignal,
  ): Promise<ConductorBindingResult> {
    const resolution = this.resolve(name)
    if (resolution.kind !== 'resolved') return this.unresolved(name, resolution)
    const workspace = resolution.workspace
    if (mode === 'new') return await this.createAndBind(workspace, signal)
    const sessions = await this.accountedSessions(workspace, signal)
    const newest = newestUnarchived(sessions)
    return newest === undefined
      ? await this.createAndBind(workspace, signal)
      : await this.bindSession(workspace, newest)
  }

  private async newSession(name: string, signal: AbortSignal): Promise<ConductorBindingResult> {
    const resolution = this.resolve(name)
    if (resolution.kind !== 'resolved') return this.unresolved(name, resolution)
    return await this.createAndBind(resolution.workspace, signal)
  }

  private async resumeSession(
    name: string,
    sessionId: string | undefined,
    signal: AbortSignal,
  ): Promise<ConductorBindingResult> {
    const resolution = this.resolve(name)
    if (resolution.kind !== 'resolved') return this.unresolved(name, resolution)
    const workspace = resolution.workspace
    const sessions = await this.accountedSessions(workspace, signal)
    const session = sessionId === undefined
      ? newestUnarchived(sessions)
      : sessions.find(entry => entry.fact.sessionId === sessionId)
    if (session === undefined) {
      const message = sessionId === undefined
        ? `Workspace "${workspace.title}" has no session to resume.`
        : `Session "${sessionId}" is not available in workspace "${workspace.title}".`
      return errorResult('SESSION_NOT_FOUND', message, [])
    }
    return await this.bindSession(workspace, session)
  }

  /** Resolve the name against the current registry order. */
  private resolve(name: string): WorkspaceResolution {
    return resolveWorkspace(this.ctx.workspaceRegistry.list(), name)
  }

  /** Translate a non-resolved workspace name into a model-facing result. */
  private unresolved(name: string, resolution: Exclude<WorkspaceResolution, { kind: 'resolved' }>): ConductorBindingResult {
    if (resolution.kind === 'candidates') {
      return {
        status: 'candidates',
        message: candidatesMessage(name, resolution.workspaces),
        candidates: resolution.workspaces.map(workspaceFact),
      }
    }
    return errorResult(
      'WORKSPACE_NOT_FOUND',
      workspaceMissingMessage(name, resolution.matches),
      resolution.matches.map(workspaceFact),
    )
  }

  /** Join the workspace's accounted session ids with their Host summaries. */
  private async accountedSessions(
    workspace: Workspace,
    signal: AbortSignal,
  ): Promise<AccountedSession[]> {
    const archived = new Set(this.ctx.workspaceRegistry.archivedSessionIds.map(id => String(id)))
    const { items } = await this.ctx.sessionController.list({}, signal)
    const summaries = new Map(items.map(item => [String(item.sessionId), item]))
    const workspaceId = String(workspace.id)
    const sessions: AccountedSession[] = []
    for (const id of workspace.sessionIds) {
      const sessionId = String(id)
      const summary = summaries.get(sessionId)
      if (summary === undefined) continue
      sessions.push({
        fact: sessionFact(summary, workspaceId, archived.has(sessionId)),
        updatedAt: summary.updatedAt,
        summary,
      })
    }
    return sessions
  }

  /** Create a session in the workspace, report its facts, and bind it. */
  private async createAndBind(
    workspace: Workspace,
    signal: AbortSignal,
  ): Promise<ConductorBindingResult> {
    const created = await this.ctx.sessionController.create({ workspaceId: workspace.id })
    const sessions = await this.accountedSessions(workspace, signal)
    const sessionId = String(created.sessionId)
    const session = sessions.find(entry => entry.fact.sessionId === sessionId)
    const fact = session?.fact ?? {
      sessionId,
      title: null,
      workspaceId: String(workspace.id),
      lastActivityAt: null,
      archived: false,
    }
    const message = await this.recordBinding(workspace, fact, true)
    return {
      status: 'bound',
      message,
      session: fact,
      workspace: workspaceFact(workspace),
      created: true,
    }
  }

  /** Validate one accounted session, bind it, and report its facts. */
  private async bindSession(
    workspace: Workspace,
    session: AccountedSession,
  ): Promise<ConductorBindingResult> {
    if (session.fact.archived) {
      return errorResult(
        'SESSION_ARCHIVED',
        `${sessionLabel(session.fact)} is archived; unarchive it or open another session.`,
        [],
      )
    }
    if (session.summary.origin === 'subagent') {
      return errorResult(
        'PERMISSION_DENIED',
        `${sessionLabel(session.fact)} belongs to a subagent and cannot be the voice session.`,
        [],
      )
    }
    const message = await this.recordBinding(workspace, session.fact, false)
    return {
      status: 'bound',
      message,
      session: session.fact,
      workspace: workspaceFact(workspace),
      created: false,
    }
  }

  /** Write the binding and report it; a rejected write propagates and leaves the state unchanged. */
  private async recordBinding(
    workspace: Workspace,
    session: ConductorSessionFact,
    created: boolean,
  ): Promise<string> {
    await this.target.bind(session.sessionId, session.workspaceId)
    this.bound = { sessionId: session.sessionId, workspaceId: session.workspaceId }
    return boundMessage(workspace, session, created)
  }
}

export default VoiceConductor
