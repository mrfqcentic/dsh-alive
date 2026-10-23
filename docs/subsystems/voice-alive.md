# Voice panel

English | [中文](voice-alive.zh.md)

The voice panel is this fork's product surface: a frameless always-on-top window summoned with Option+Space (Alt+Space outside macOS) that carries local speech in and out of one bound session. The [`@deepseek-ai/dsh-voice-alive`](../../packages/interaction/voice-alive/README.md) row is dual-face — it registers `ctx.voiceAlive` in the Host process and a browser client that renders only in the panel document — and the [`@deepseek-ai/dsh-voice-alive-bundle`](../../packages/bundle/voice-alive/README.md) layer inserts that row over `dsh-base`. The shipped `web` profile template selects the layer after `@deepseek-ai/dsh-web-app`, and Desktop initialises its profile from the same template, so a fresh installation mounts the row.

The shell owns the window and the summon chord in [`apps/desktop/src/voice-panel.ts`](../../apps/desktop/src/voice-panel.ts); it serves the package's built `dist/panel/` document under the `dsh-app://shell/voice/` route. The panel document boots the ordinary client kernel with a voice-only roster, so the client half activates only when the document marks itself with `data-dsh-voice-panel` and stays inert in the main chat surface. `VoiceAliveService` is a Host namespace with no configuration or state; the [package README](../../packages/interaction/voice-alive/README.md) owns its composition status and deferred work, and no model-visible input depends on it.

Sources: [`packages/interaction/voice-alive/src/index.ts`](../../packages/interaction/voice-alive/src/index.ts), [`packages/bundle/voice-alive/cordis.patch.yml`](../../packages/bundle/voice-alive/cordis.patch.yml)

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxvoicealive--voicealiveservice"></a>

### `ctx.voiceAlive` — `VoiceAliveService`

Host service owned by the voice bundle row.

It owns no state. The bound session, the audio state machine, and the conductor belong on this service so other host plugins read one namespace per panel rather than process-global state.

Source: [`packages/interaction/voice-alive/src/index.ts`](../../packages/interaction/voice-alive/src/index.ts)
<!-- END GENERATED cordis-surface -->
