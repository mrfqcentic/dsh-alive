---
description: "Mount the voice panel's Host service namespace and its panel-only browser client."
kind: "package-reference"
---

# @deepseek-ai/dsh-voice-alive

English | [中文](README.zh.md)

## Summary

Give the shipped Web and Desktop profiles a voice panel Host service and a dedicated browser panel. The panel boots the client kernel with a voice-only roster from its `dist/panel/`, renders the monochrome orb and window controls, and opens settings and history as `?surface=` surfaces. The Host runs both speech engines in `ELECTRON_RUN_AS_NODE` workers: `createAsrEngine` transcribes with Whisper or Parakeet, `createTtsEngine` streams Kokoro chunks, and `createEngineSupervisor` holds one model per engine and reports health. The Host row registers four conductor tools that bind a new or resumed session and restore it on restart, and installs the voice policy that keeps replies spoken-shaped and every switch tied to a tool result. The bundle composes the row over `dsh-base`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the row through the [voice bundle layer](../../bundle/voice-alive/README.md), or insert it directly in a composition that already carries `dsh-base`.

### When to choose it

Choose this package when a profile hosts the voice panel: it owns the daemon namespace and the panel client together. For dictation that inserts a reviewed transcript into the conversation draft, use the existing voice-input bundle instead; this package never touches the composer.

### Minimal configuration

The row takes no configuration; model, audio-device, and binding settings attach through the service.

```yaml
- id: voice-alive
  name: '@deepseek-ai/dsh-voice-alive'
```

The Host half registers `ctx.voiceAlive`. The browser half activates only when the document carries `data-dsh-voice-panel` on `<html>`, which is exactly the panel document.

### Conductor tools

The Host row registers four ordinary tools on `ctx.tools`. `voice_list_workspaces` reports each workspace's id, title, path, and session count. `voice_open_workspace` binds the panel to the most recent unarchived session in a workspace or creates one, `voice_new_session` creates and binds a fresh session, and `voice_resume_session` binds a named or the most recent session. Each binding tool resolves a workspace by exact title, directory path, or final path segment and returns candidates for a partial or shared name instead of choosing one. Failures are typed and explicit: an unknown workspace, a missing session, an archived session, and a subagent session each report their own code without changing the binding.

The conductor writes each completed binding through the `VoiceBindingTarget` sink; the last accepted binding is readable as `ctx.voiceConductor.currentBinding`.

### Voice instructions

[`instructions.md`](instructions.md) is the policy the Host row installs as the `voice:policy` prompt section. It states that the panel is a remote control for one Session, requires one or two spoken sentences with no lists, code, or Markdown, and names the four conductor tools with the arguments each one takes: list workspaces before guessing one, pass an explicit `mode` to `voice_open_workspace`, start a fresh Session with `voice_new_session`, and continue one with `voice_resume_session`. Ambiguous names are answered by asking which candidate; a failed tool is reported instead of a claimed switch. Session ids, titles, and paths come from tool results, and the Audio workspace is the default home.

The section renders only while the assembled Agent is the bound Session, so a deployment that also serves the chat surface keeps its ordinary prompt. A missing or empty `instructions.md` fails the row's activation instead of serving a voice panel with no policy.

### Session binding

`ctx.voiceAlive.binding` owns the one Session the panel follows. On host start, `ensure()` restores the stored Session when its workspace registration and its log still exist; otherwise it creates the Audio workspace at `~/.dsh/voice/workspace` (titled `Voice`) and a Session in it, then records the switch. The conductor changes the followed Session with `bind()`; `unbind()` drops it and `restore()` reports the stored pair without creating or writing anything.

The record lives in the `voice_binding` storage domain (`$DSH_HOME/storages/voice_binding/binding/current.json`). It stores `sessionId`, `workspaceId`, and `updatedAt`. A corrupt, unreadable, or schema-invalid record reads as absent, and a storage failure during startup leaves the in-memory binding usable instead of failing activation. All writes run on one chain, so concurrent `bind()` and `ensure()` calls cannot interleave the record.

### ASR engine

The package root also exports the serial local recognizer the daemon will drive. It spawns one `ELECTRON_RUN_AS_NODE` child, loads exactly one Whisper or Parakeet model from a caller-supplied directory, and never falls back to another model.

```ts
import { createAsrEngine } from '@deepseek-ai/dsh-voice-alive'

const engine = createAsrEngine()
await engine.load('whisper', '/path/to/verified/whisper-onnx')
const result = await engine.transcribe({ id: 'turn-1', pcm: new Int16Array(16000), sampleRate: 16000 })
```

The directory must already contain the ONNX weights and `tokens.txt`; this package never downloads them, and a missing or incompatible directory rejects with an `AsrEngineError` instead of starting another model.

### TTS engine

The package root also exports the local Kokoro synthesizer. It splits a reply into sentence-sized jobs, returns each 24 kHz mono 16-bit WAV as soon as it is ready, and keeps the chunks in sentence order.

```ts
import { createTtsEngine } from '@deepseek-ai/dsh-voice-alive'

const engine = createTtsEngine()
await engine.load('/path/to/verified/kokoro-onnx', { voice: 'af_heart' })
await engine.speak({ id: 'turn-1', text: 'Hello there. How are you?' }, chunk => {
  // chunk.wav is a complete WAV; playback can start before the reply finishes.
})
```

The directory must already contain the ONNX model and tokenizer files; remote model loading stays disabled, and a missing directory rejects with a `TtsError` instead of falling back to another model.

### Engine supervisor

The package root also exports the supervisor the daemon will drive. It owns one recognizer and one synthesizer together with their selected models, serializes each engine's model swaps and jobs on that engine's own lane, and reports health for both.

```ts
import { createEngineSupervisor } from '@deepseek-ai/dsh-voice-alive'

const supervisor = createEngineSupervisor()
await supervisor.configure({
  asr: { id: 'whisper', directory: '/path/to/verified/whisper-onnx' },
  tts: { directory: '/path/to/verified/kokoro-onnx', voice: 'af_heart' },
})
const transcript = await supervisor.transcribe({ id: 'turn-1', pcm: new Int16Array(16000), sampleRate: 16000 })
await supervisor.speak({ id: 'reply-1', text: 'Hello there.' }, chunk => { /* play chunk.wav */ })
supervisor.cancelSpeech()
const { asr, tts } = supervisor.health
await supervisor.shutdown()
```

`configure` swaps model by model: an engine that fails to load ends explicitly unloaded with status `error` instead of keeping the previous model, while the other engine keeps serving. Each engine has its own bounded waiting queue, so a full transcription queue never delays speech. `health` reports `status`, `lastErrorCode`, `lastSuccessAt`, and `restarts`; `restart('asr' | 'tts')` reloads one engine from its applied selection. A crashed worker is contained to its engine and respawns on the next job, and `shutdown` is idempotent.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The panel is served as a static document on the shell origin, so no Host request can inject `window.__DSH_BOOT__` into it. The panel build therefore runs the Web shell's own boot protocol at build time: it composes the roster from the voice bundle patch with `composeEntries`, copies each package's client artifact under `plugins/`, and renders `bootInjections` through `renderIndexInjections`. At runtime `AppWebEntry` runs the unchanged client kernel, and the client row mounts one React root under `#root`.

| Source | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Host `VoiceAliveService` registered as `ctx.voiceAlive`, plus the exported ASR, TTS, supervisor, and binding entry points |
| [`instructions.md`](instructions.md) | Voice policy text the row installs as the `voice:policy` prompt section |
| [`src/instructions.ts`](src/instructions.ts) | Instruction asset read and the bound-Session prompt section |
| [`src/conductor/tools.ts`](src/conductor/tools.ts) | Host conductor service: the four workspace and session tools, their typed results, and the binding sink |
| [`src/binding/`](src/binding/) | Durable Session binding, startup restore, and the Audio workspace fallback |
| [`src/engine/asr.ts`](src/engine/asr.ts) | Host ASR engine: spawn, handshake, serial queue, idle shutdown, typed failures |
| [`src/engine/asr-worker.ts`](src/engine/asr-worker.ts) | ASR worker: JSON-line protocol over stdin and fd 3, sherpa-onnx Whisper/Parakeet |
| [`src/engine/types.ts`](src/engine/types.ts) | ASR request/result/engine contract and the worker frames |
| [`src/engine/tts.ts`](src/engine/tts.ts) | Host TTS engine: sentence splitting, ordered streaming, cancellation, idle shutdown |
| [`src/engine/tts-types.ts`](src/engine/tts-types.ts) | TTS request/chunk/engine contract and the worker frames |
| [`src/engine/tts-worker.ts`](src/engine/tts-worker.ts) | TTS worker: Kokoro synthesis and WAV framing over stdout |
| [`src/engine/supervisor.ts`](src/engine/supervisor.ts) | Engine supervisor: model selection, per-engine lanes and queues, health, restart, crash isolation, shutdown |
| [`src/engine/worker.ts`](src/engine/worker.ts) | Single `./worker` dispatcher that validates the role and loads the ASR or TTS worker |
| [`src/client/index.ts`](src/client/index.ts) | Panel-document activation gate |
| [`src/client/mount.tsx`](src/client/mount.tsx) | React root mount, URL-selected surface, and disposal |
| [`src/client/surfaces.ts`](src/client/surfaces.ts) | Surface registry parsed from `?surface=panel\|settings\|history` |
| [`src/client/surfaces/`](src/client/surfaces/) | One component per surface: panel, settings, history |
| [`src/client/orb/`](src/client/orb/) | Monochrome orb canvas, palette, and motion math |
| [`src/client/panel/`](src/client/panel/) | Panel orb state store, shell bridge, and window controls |
| [`src/client/audio/`](src/client/audio/) | 16 kHz microphone capture, VAD segmentation, word gate, and input device enumeration; ordered WAV playback, output-device routing, output level, and the echo-reference node; the echo guard that cancels the playback reference, holds the half-duplex tail, and rejects self-transcription; the audio state machine that ties capture, playback, and mute together |
| [`src/client/settings/`](src/client/settings/) | Five-tab settings frame and its pane placeholders |
| [`src/client/history/`](src/client/history/) | History list, search, delete flow, and the `HistorySource` seam |
| [`src/client/styles/`](src/client/styles/) | Design-system stylesheets copied from `voice-plugin/design/` |
| [`panel/main.ts`](panel/main.ts) | Panel document entry that runs `AppWebEntry` |
| [`panel/vite.config.ts`](panel/vite.config.ts) | Relative-base panel build with the shell's browser defines |
| [`scripts/assemble-panel.ts`](scripts/assemble-panel.ts) | Voice-only boot table and copied client bundles |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Voice bundle layer](../../bundle/voice-alive/README.md) — the profile patch that inserts this row.
- [Client kernel](../../client/web/README.md) — the boot entry and static module table the panel runs.
- [Client module system](../../client/modules/README.md) — the `__DSH_BOOT__` protocol the panel build renders.
- [Application boot](../../boot/app-boot/README.md) — profile composition and bundle patch resolution.
- [Web application layer](../../bundle/web-app/README.md) — the surface whose boot mechanism the panel reuses.
- [Interaction packages](../README.md) — the human-collaboration group this package lives in.

-----

<a id="model-experience"></a>
## Model Experience

### Conductor tools

#### What the model sees

The `voice_list_workspaces`, `voice_open_workspace`, `voice_new_session`, and `voice_resume_session` schemas whenever the row is loaded. Each binding result carries the workspace id, title, path, and session count plus the session id, title, last activity, and archive flag from the registries. A partial or shared workspace name returns candidates instead of binding.

#### Token effect

A fixed schema cost on every request from a Session in a deployment that loads the row. Binding results stay in the calling Session's history until compaction.

#### KV Cache effect

Prefix-stable while the tool definitions are unchanged. Loading or unloading the row changes the tool block and can invalidate reuse from the first changed schema token.

### Voice instructions

#### What the model sees

The `voice:policy` section text only in the Session the panel is bound to, whether the startup restore or a completed conductor switch bound it. It names the four conductor tools with the arguments each takes and states the reply rules: one or two spoken sentences with no lists, code, or Markdown.

#### Token effect

A fixed block of roughly 340 words in the bound Session's system prompt on every request while that Session stays bound. Every other Session assembles an empty section, which renders to nothing.

#### KV Cache effect

Prefix-stable while the policy text and the binding are unchanged. Switching the panel to another Session adds the block to that Session's next request and removes it from the previous one.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Supervisor not wired to the daemon** — `VoiceAliveService` still has no audio state; `createEngineSupervisor` owns both exported engines, and the audio surfaces attach in later tickets.
- **Conductor binding is not durable yet** — the conductor records a binding through `VoiceBindingTarget`, but the row does not install its durable binding store on that sink, so `ctx.voiceConductor.currentBinding` is lost on restart.
- **No bundled weights** — both engines read a model directory supplied by their caller; downloading and verifying Whisper, Parakeet, or Kokoro weights is ticket 19's job, so `load` rejects until that directory exists.
- **Placeholder settings panes** — the five tabs switch, but each pane is an honest placeholder; the audio, shortcut, model, workspace, and privacy controls attach in later waves, with models, workspaces, and privacy in tickets 19–21.
- **Fixture history** — the history window lists a fixed in-memory fixture through `createHistorySource`; the durable store replaces that factory in ticket 22.
- **Local panel state** — the orb reads one client store ([`src/client/panel/state.ts`](src/client/panel/state.ts)) that the audio state machine drives.
- **Echo guard not wired into the panel** — `createEchoGuard` is exported for the panel surface to own. Capture accepts the frame-level tap through `CaptureOptions.frameGate`, and the audio machine applies the segment-level backstop when it is given the guard; the panel constructs neither yet.
- **Energy word gate** — the default gate decides from segment duration and level alone, so music, a steady tone, or sustained loud machinery can pass. It measures the closed segment, not the individual word: a 300 ms word inside a 560 ms segment passes, while a 150 ms word stays below the 450 ms minimum and is dropped. Ticket 11 replaces it with a transcript-based gate through the same injected `WordGate`.
- **No real-microphone verification** — capture, worklet loading, resampling, hot-plug, reference cancellation, and barge-in are exercised against a fake Web Audio graph and synthetic PCM. Real speakers, a real microphone, browser permission prompts, and the macOS TCC path still need a human test; ticket 24 owns the acceptance matrix.
- **Panel route is shell-owned** — this package emits `dist/panel/` with document-relative URLs, but the Desktop protocol handler must map `/voice/*` onto it. The Web server does not serve the panel.
- **Shell-sized lazy assets** — the panel build carries the client kernel's code-split grammar and font assets, so `dist/panel/` is roughly 20 MB on disk. The panel never loads those chunks; they exist because the shell's static module table reaches them.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The panel boot table is generated at build time only because the panel document is served statically. Reusing the Web boot rows keeps one client kernel: the panel has no fork of React mounting, module loading, or plugin activation. The client guard keeps the same dual-face row safe when the chat surface also mounts the bundle.

</details>
