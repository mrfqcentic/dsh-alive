/**
 * Conductor tools: bind the voice panel to one workspace session and report the
 * registry facts the model speaks about.
 *
 * The four tools are registered on `ctx.tools` by the panel's host row. They
 * read workspaces from `ctx.workspaceRegistry` and sessions from the Host
 * Session controller, and hand every binding decision to `./routing.ts`, so the
 * three binding tools share one resolution and one durable write.
 *
 * The host row installs `ctx.voiceAlive.binding` on {@link VoiceConductor.setBinding},
 * so a completed route and the stored record are the same pair.
 * @module @deepseek-ai/dsh-voice-alive/conductor
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { JsonSchemaNode, ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import {
  CONDUCTOR_ERROR_CODES,
  routeConductor,
  workspaceFact,
  type ConductorBindingResult,
  type ConductorRouteRequest,
  type ConductorWorkspaceFact,
} from './routing.ts'

export { CONDUCTOR_ERROR_CODES } from './routing.ts'
export type {
  ConductorBindingResult,
  ConductorBoundResult,
  ConductorCandidatesResult,
  ConductorErrorCode,
  ConductorErrorResult,
  ConductorRouteRequest,
  ConductorSessionFact,
  ConductorWorkspaceFact,
} from './routing.ts'

/** Read-only workspace listing. */
export interface ConductorWorkspaceList {
  /** One model-facing block listing every registered workspace. */
  readonly message: string
  readonly workspaces: ConductorWorkspaceFact[]
}

/**
 * The panel's binding sink. The host row installs `ctx.voiceAlive.binding` here
 * with {@link VoiceConductor.setBinding}.
 */
export interface VoiceBindingTarget {
  /**
   * Record the panel's binding.
   * @param sessionId - Session the panel follows.
   * @param workspaceId - Workspace that accounts the session.
   * @returns resolution after the binding is durable.
   */
  bind(sessionId: string, workspaceId: string): Promise<void>
}

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
 * sees. Each binding tool routes through {@link routeConductor}, which writes the
 * accepted pair to the durable binding before reporting it.
 */
export class VoiceConductor extends Service {
  static inject = ['tools', 'workspaceRegistry', 'sessionController']

  /** Where bindings are recorded; the host row installs `ctx.voiceAlive.binding`. */
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
      execute: (args, exec) => this.route({ workspace: args.name, mode: args.mode, createWhenEmpty: true }, exec.signal),
    }))

    ctx.tools.register(conductorTool({
      name: 'voice_new_session',
      description:
        'Create a fresh session in one workspace and bind the voice panel to it. Returns the new session '
        + 'id and its workspace. A partial or ambiguous `workspace` returns candidates instead of creating anything.',
      parameters: NEW_SESSION_PARAMETERS,
      arguments: NEW_SESSION_ARGUMENTS,
      output: BINDING_RESULT_SCHEMA,
      execute: (args, exec) => this.route({ workspace: args.workspace, mode: 'new' }, exec.signal),
    }))

    ctx.tools.register(conductorTool({
      name: 'voice_resume_session',
      description:
        'Bind the voice panel to an existing session in one workspace. Without `session_id`, binds the most '
        + 'recent unarchived session there. An archived session is replaced by the newest live session in the '
        + 'same workspace, or a new one, and the result says so; a missing or subagent session is reported.',
      parameters: RESUME_SESSION_PARAMETERS,
      arguments: RESUME_SESSION_ARGUMENTS,
      output: BINDING_RESULT_SCHEMA,
      execute: (args, exec) => this.route({
        workspace: args.workspace,
        mode: 'resume',
        createWhenEmpty: false,
        ...args.session_id === undefined ? {} : { sessionId: args.session_id },
      }, exec.signal),
    }))
  }

  /**
   * Replace the binding sink. The host row installs `ctx.voiceAlive.binding`.
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

  /** Route one binding request through the shared flow and its durable write. */
  private route(request: ConductorRouteRequest, signal: AbortSignal): Promise<ConductorBindingResult> {
    const ctx = this.ctx
    return routeConductor(request, {
      workspaces: ctx.workspaceRegistry.list(),
      archivedSessionIds: ctx.workspaceRegistry.archivedSessionIds,
      listSessions: async sessionSignal => (await ctx.sessionController.list({}, sessionSignal)).items,
      createSession: async workspace =>
        String((await ctx.sessionController.create({ workspaceId: workspace.id })).sessionId),
      bind: (sessionId, workspaceId) => this.writeBinding(sessionId, workspaceId),
    }, signal)
  }

  /** Publish the pair only after the durable write settles. */
  private async writeBinding(sessionId: string, workspaceId: string): Promise<void> {
    await this.target.bind(sessionId, workspaceId)
    this.bound = { sessionId, workspaceId }
  }
}

export default VoiceConductor
