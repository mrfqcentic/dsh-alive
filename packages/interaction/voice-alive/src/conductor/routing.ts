/**
 * Conductor routing: the one workspace-and-session flow behind every binding
 * tool. A route resolves a workspace from the registry, chooses between a new
 * session and the newest live one, recovers an archived request, and writes the
 * resulting pair through the durable binding before reporting it.
 *
 * The durable write is the commit point. A successful route reports the pair it
 * wrote, so the ids the model sees are the ids the history surfaces read; a
 * rejected write leaves the caller's binding unchanged.
 * @module @deepseek-ai/dsh-voice-alive/conductor/routing
 */

import type { SessionId } from '@deepseek-ai/dsh-session'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'

/** Stable failure codes a conductor tool returns. */
export const CONDUCTOR_ERROR_CODES = [
  'WORKSPACE_NOT_FOUND',
  'SESSION_NOT_FOUND',
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

/** One routing request, shared by the three binding tools. */
export type ConductorRouteRequest =
  | {
    /** Workspace title, directory path, or final path segment supplied by the model. */
    readonly workspace: string
    /** Always create a session in the workspace. */
    readonly mode: 'new'
  }
  | {
    /** Workspace title, directory path, or final path segment supplied by the model. */
    readonly workspace: string
    /** Continue a session that already exists. */
    readonly mode: 'resume'
    /** Existing session to resume instead of the newest live one in the workspace. */
    readonly sessionId?: string
    /**
     * Whether to create a session when the workspace has none live.
     * `voice_open_workspace` opens the workspace and creates; `voice_resume_session`
     * names an earlier session and reports `SESSION_NOT_FOUND` instead.
     */
    readonly createWhenEmpty: boolean
  }

/** One workspace registration a route resolves against. */
export interface RoutingWorkspace {
  /** Stable Workspace id. */
  readonly id: WorkspaceId
  /** Display title. */
  readonly title: string
  /** Canonical workspace directory. */
  readonly path: string
  /** Accounted session ids in registry order. */
  readonly sessionIds: readonly SessionId[]
}

/** One Host session summary a route reads. */
export interface RoutingSessionSummary {
  /** Session id. */
  readonly sessionId: SessionId
  /** Epoch milliseconds of the last recorded activity. */
  readonly updatedAt: number
  /** Set when the session belongs to a subagent. */
  readonly origin?: 'subagent'
  /** Latest logged projections; `values.title` is the display title once set. */
  readonly projections?: { readonly values: { readonly title?: unknown } }
}

/** Host services one route reads and the write path it commits through. */
export interface ConductorRoutingDeps {
  /** Registered workspaces in display order. */
  readonly workspaces: readonly RoutingWorkspace[]
  /** Session ids the registry archive set hides. */
  readonly archivedSessionIds: readonly SessionId[]
  /**
   * List the Host session summaries.
   * @param signal - cancellation for the listing call.
   * @returns every summary the Host can report.
   */
  listSessions(signal: AbortSignal): Promise<readonly RoutingSessionSummary[]>
  /**
   * Create a session inside a workspace.
   * @param workspace - workspace that receives and accounts the session.
   * @returns the created session id.
   */
  createSession(workspace: RoutingWorkspace): Promise<string>
  /**
   * Persist the route's binding.
   * @param sessionId - session the panel follows.
   * @param workspaceId - workspace that accounts the session.
   * @returns resolution after the durable write.
   */
  bind(sessionId: string, workspaceId: string): Promise<void>
}

/** One workspace resolution: a decision, candidates to ask about, or a miss. */
type WorkspaceResolution =
  | { readonly kind: 'resolved'; readonly workspace: RoutingWorkspace }
  | { readonly kind: 'candidates'; readonly workspaces: RoutingWorkspace[] }
  | { readonly kind: 'missing'; readonly matches: RoutingWorkspace[] }

/** One accounted session joined with its Host summary. */
interface AccountedSession {
  readonly fact: ConductorSessionFact
  readonly updatedAt: number
  readonly summary: RoutingSessionSummary
}

/** Maximum candidates named in one result; the message reports the remainder. */
const MAX_CANDIDATES = 8

/** One exact score marks a name the tool may bind without asking. */
const EXACT_SCORE = 4

/**
 * Score one workspace against a lowercased name: exact title, path, or final
 * path segment wins; prefixes and substrings are partial matches.
 * @param workspace - candidate workspace.
 * @param needle - lowercased search text.
 * @returns 4 for an exact match, 3 for a prefix, 2 for a substring, 0 otherwise.
 */
function workspaceScore(workspace: RoutingWorkspace, needle: string): number {
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
function resolveWorkspace(workspaces: readonly RoutingWorkspace[], name: string): WorkspaceResolution {
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

/**
 * Project one registry workspace for the model.
 * @param workspace - the workspace to project.
 * @returns the model-facing facts.
 */
export function workspaceFact(workspace: RoutingWorkspace): ConductorWorkspaceFact {
  return {
    workspaceId: String(workspace.id),
    title: workspace.title,
    path: workspace.path,
    sessionCount: workspace.sessionIds.length,
  }
}

/** Project one accounted session for the model. */
function sessionFact(summary: RoutingSessionSummary, workspaceId: string, archived: boolean): ConductorSessionFact {
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
function candidateList(workspaces: readonly RoutingWorkspace[]): string {
  const shown = workspaces.slice(0, MAX_CANDIDATES)
  const omitted = workspaces.length - shown.length
  return `${shown.map(workspace => `"${workspace.title}"`).join(', ')}${omitted === 0 ? '' : ` (+${omitted} more)`}`
}

/** One model-facing phrase naming whatever session the result carries. */
function sessionLabel(session: ConductorSessionFact): string {
  return session.title === null ? `session ${session.sessionId}` : `"${session.title}" (${session.sessionId})`
}

/** One model-facing sentence for a completed binding. */
function boundMessage(
  workspace: RoutingWorkspace,
  session: ConductorSessionFact,
  created: boolean,
  recoveredFrom?: ConductorSessionFact,
): string {
  const verb = created ? 'Created and bound' : 'Bound'
  const recovery = recoveredFrom === undefined ? '' : ` because ${sessionLabel(recoveredFrom)} is archived`
  const activity = session.lastActivityAt === null ? '' : ` Last activity ${session.lastActivityAt}.`
  return `${verb} ${sessionLabel(session)} in workspace "${workspace.title}" (${workspace.path})${recovery}.${activity}`
}

/** One model-facing sentence asking which candidate to use. */
function candidatesMessage(name: string, workspaces: readonly RoutingWorkspace[]): string {
  if (workspaces.length === 0) return 'A workspace name is required, and no workspaces are registered.'
  const introduction = name.trim() === ''
    ? 'A workspace name is required.'
    : `No exact workspace is named "${name.trim()}".`
  return `${introduction} Candidates: ${candidateList(workspaces)}. Ask which one.`
}

/** One model-facing sentence for an unknown workspace and its close matches. */
function workspaceMissingMessage(name: string, matches: readonly RoutingWorkspace[]): string {
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

/** Join the workspace's accounted session ids with their Host summaries. */
async function accountedSessions(
  workspace: RoutingWorkspace,
  deps: ConductorRoutingDeps,
  signal: AbortSignal,
): Promise<AccountedSession[]> {
  const archived = new Set(deps.archivedSessionIds.map(id => String(id)))
  const summaries = await deps.listSessions(signal)
  const byId = new Map(summaries.map(summary => [String(summary.sessionId), summary]))
  const workspaceId = String(workspace.id)
  const sessions: AccountedSession[] = []
  for (const id of workspace.sessionIds) {
    const sessionId = String(id)
    const summary = byId.get(sessionId)
    if (summary === undefined) continue
    sessions.push({
      fact: sessionFact(summary, workspaceId, archived.has(sessionId)),
      updatedAt: summary.updatedAt,
      summary,
    })
  }
  return sessions
}

/** Create a session in the workspace, bind it, and report its facts. */
async function createAndBind(
  workspace: RoutingWorkspace,
  deps: ConductorRoutingDeps,
  signal: AbortSignal,
  recoveredFrom?: ConductorSessionFact,
): Promise<ConductorBoundResult> {
  const created = await deps.createSession(workspace)
  const sessions = await accountedSessions(workspace, deps, signal)
  const session = sessions.find(entry => entry.fact.sessionId === created)
  const fact = session?.fact ?? {
    sessionId: created,
    title: null,
    workspaceId: String(workspace.id),
    lastActivityAt: null,
    archived: false,
  }
  await deps.bind(fact.sessionId, fact.workspaceId)
  return {
    status: 'bound',
    message: boundMessage(workspace, fact, true, recoveredFrom),
    session: fact,
    workspace: workspaceFact(workspace),
    created: true,
  }
}

/** Validate one accounted session, bind it, and report its facts. */
async function bindSession(
  workspace: RoutingWorkspace,
  session: AccountedSession,
  deps: ConductorRoutingDeps,
  recoveredFrom?: ConductorSessionFact,
): Promise<ConductorBindingResult> {
  if (session.summary.origin === 'subagent') {
    return errorResult(
      'PERMISSION_DENIED',
      `${sessionLabel(session.fact)} belongs to a subagent and cannot be the voice session.`,
      [],
    )
  }
  await deps.bind(session.fact.sessionId, session.fact.workspaceId)
  return {
    status: 'bound',
    message: boundMessage(workspace, session.fact, false, recoveredFrom),
    session: session.fact,
    workspace: workspaceFact(workspace),
    created: false,
  }
}

/**
 * Recover a requested archived session: bind the newest live session in the
 * same workspace, or create one when none is live. The result names the
 * archived session it replaced.
 * @param workspace - workspace that accounted the archived session.
 * @param archived - the archived session the request named.
 * @param sessions - every accounted session in the workspace.
 * @param deps - registries and binding sink.
 * @param signal - cancellation for the session listing.
 * @returns the bound result naming the archived session.
 */
async function recoverArchived(
  workspace: RoutingWorkspace,
  archived: AccountedSession,
  sessions: readonly AccountedSession[],
  deps: ConductorRoutingDeps,
  signal: AbortSignal,
): Promise<ConductorBindingResult> {
  const live = newestUnarchived(sessions.filter(entry => entry.summary.origin !== 'subagent'))
  return live === undefined
    ? await createAndBind(workspace, deps, signal, archived.fact)
    : await bindSession(workspace, live, deps, archived.fact)
}

/**
 * Route one conductor request and commit its binding.
 *
 * Resolution order: an unknown or ambiguous workspace reports before any
 * session lookup; `new` always creates; a named session must be accounted in
 * the workspace; an archived request recovers to a live session; `resume`
 * without a name continues the newest live session or creates one.
 * @param request - workspace name, mode, and optional session id.
 * @param deps - registries and the durable binding sink.
 * @param signal - cancellation for the session listing.
 * @returns the bound result, candidates to ask about, or a typed error.
 * @throws when the binding write rejects; the caller's state stays unchanged.
 */
export async function routeConductor(
  request: ConductorRouteRequest,
  deps: ConductorRoutingDeps,
  signal: AbortSignal,
): Promise<ConductorBindingResult> {
  const resolution = resolveWorkspace(deps.workspaces, request.workspace)
  if (resolution.kind === 'candidates') {
    return {
      status: 'candidates',
      message: candidatesMessage(request.workspace, resolution.workspaces),
      candidates: resolution.workspaces.map(workspaceFact),
    }
  }
  if (resolution.kind === 'missing') {
    return errorResult(
      'WORKSPACE_NOT_FOUND',
      workspaceMissingMessage(request.workspace, resolution.matches),
      resolution.matches.map(workspaceFact),
    )
  }
  const workspace = resolution.workspace
  if (request.mode === 'new') return await createAndBind(workspace, deps, signal)
  const sessions = await accountedSessions(workspace, deps, signal)
  const named = request.sessionId === undefined
    ? undefined
    : sessions.find(entry => entry.fact.sessionId === request.sessionId)
  if (request.sessionId !== undefined && named === undefined) {
    return errorResult(
      'SESSION_NOT_FOUND',
      `Session "${request.sessionId}" is not available in workspace "${workspace.title}".`,
      [],
    )
  }
  if (named !== undefined && named.fact.archived) {
    return await recoverArchived(workspace, named, sessions, deps, signal)
  }
  const session = named ?? newestUnarchived(sessions)
  if (session === undefined) {
    return request.createWhenEmpty
      ? await createAndBind(workspace, deps, signal)
      : errorResult('SESSION_NOT_FOUND', `Workspace "${workspace.title}" has no session to resume.`, [])
  }
  return await bindSession(workspace, session, deps)
}
