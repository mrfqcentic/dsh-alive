# 语音面板

[English](voice-alive.md) | 中文

语音面板是这个 fork 的产品界面：一个无边框、始终置顶的窗口，用 Option+Space（macOS 之外为 Alt+Space）唤起，为绑定的会话提供本地语音输入与输出。[`@deepseek-ai/dsh-voice-alive`](../../packages/interaction/voice-alive/README.zh.md) 配置行是双面的——它在 Host 进程中注册 `ctx.voiceAlive`，并提供仅在面板文档内渲染的浏览器客户端；[`@deepseek-ai/dsh-voice-alive-bundle`](../../packages/bundle/voice-alive/README.zh.md) 层把这条配置行插入 `dsh-base` 之上。随包的 `web` profile 模板会在 `@deepseek-ai/dsh-web-app` 之后选择该层，Desktop 也从同一模板初始化 profile，因此全新安装就会挂载这条配置行。

Shell 在 [`apps/desktop/src/voice-panel.ts`](../../apps/desktop/src/voice-panel.ts) 中拥有窗口与唤起快捷键；它在 `dsh-app://shell/voice/` 路由下提供包内构建出的 `dist/panel/` 文档。面板文档以语音专用名册启动常规客户端内核，因此客户端半边只在文档用 `data-dsh-voice-panel` 标记自身时激活，并在主聊天界面保持惰性。`VoiceAliveService` 是一个没有配置或状态的 Host 命名空间；其组合状态与后续工作由[包 README](../../packages/interaction/voice-alive/README.zh.md)负责，当前没有任何模型可见输入依赖它。

Sources: [`packages/interaction/voice-alive/src/index.ts`](../../packages/interaction/voice-alive/src/index.ts), [`packages/bundle/voice-alive/cordis.patch.yml`](../../packages/bundle/voice-alive/cordis.patch.yml)

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxvoicealive--voicealiveservice"></a>

### `ctx.voiceAlive` — `VoiceAliveService`

Host service owned by the voice bundle row.

It owns no state. The bound session, the audio state machine, and the conductor belong on this service so other host plugins read one namespace per panel rather than process-global state.

Source: [`packages/interaction/voice-alive/src/index.ts`](../../packages/interaction/voice-alive/src/index.ts)
<!-- END GENERATED cordis-surface -->
