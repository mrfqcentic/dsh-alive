---
description: "Mount the voice panel's Host service namespace and its panel-only browser client."
kind: "package-reference"
---

# @deepseek-ai/dsh-voice-alive

English | [中文](README.zh.md)

## Summary

Give the shipped Web and Desktop profiles a voice panel Host service and a dedicated browser panel. The same dual-face row mounts `ctx.voiceAlive` in the Host and a client entry that renders only inside the panel document. The client stays inert in the main chat surface. The panel document boots the ordinary client kernel with a voice-only roster served from the package's own `dist/panel/`. The panel renders the monochrome orb and its two window controls; settings and history open as separate surfaces of the same document, which `?surface=` selects. The bundle layer composes the row over `dsh-base`.

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

### ASR engine

The package root also exports the serial local recognizer the daemon will drive. It spawns one `ELECTRON_RUN_AS_NODE` child, loads exactly one Whisper or Parakeet model from a caller-supplied directory, and never falls back to another model.

```ts
import { createAsrEngine } from '@deepseek-ai/dsh-voice-alive'

const engine = createAsrEngine()
await engine.load('whisper', '/path/to/verified/whisper-onnx')
const result = await engine.transcribe({ id: 'turn-1', pcm: samples, sampleRate: 16000 })
```

The directory must already contain the ONNX weights and `tokens.txt`; this package never downloads them, and a missing or incompatible directory rejects with an `AsrEngineError` instead of starting another model.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The panel is served as a static document on the shell origin, so no Host request can inject `window.__DSH_BOOT__` into it. The panel build therefore runs the Web shell's own boot protocol at build time: it composes the roster from the voice bundle patch with `composeEntries`, copies each package's client artifact under `plugins/`, and renders `bootInjections` through `renderIndexInjections`. At runtime `AppWebEntry` runs the unchanged client kernel, and the client row mounts one React root under `#root`.

| Source | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Host `VoiceAliveService` registered as `ctx.voiceAlive`, and the exported ASR seam |
| [`src/engine/asr.ts`](src/engine/asr.ts) | Host engine: spawn, handshake, serial queue, idle shutdown, typed failures |
| [`src/engine/asr-worker.ts`](src/engine/asr-worker.ts) | Worker process: JSON-line protocol over stdin and fd 3, sherpa-onnx Whisper/Parakeet |
| [`src/engine/types.ts`](src/engine/types.ts) | ASR request/result/engine contract and the worker frames |
| [`src/client/index.ts`](src/client/index.ts) | Panel-document activation gate |
| [`src/client/mount.tsx`](src/client/mount.tsx) | React root mount, URL-selected surface, and disposal |
| [`src/client/surfaces.ts`](src/client/surfaces.ts) | Surface registry parsed from `?surface=panel\|settings\|history` |
| [`src/client/surfaces/`](src/client/surfaces/) | One component per surface: panel, settings, history |
| [`src/client/orb/`](src/client/orb/) | Monochrome orb canvas, palette, and motion math |
| [`src/client/panel/`](src/client/panel/) | Panel orb state store, shell bridge, and window controls |
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

None, as the row registers a Host service namespace and a browser panel mount without adding tools, prompt sections, or Session events.

#### KV Cache effect

The row changes no request assembly, so no prompt segment or cache boundary depends on it.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Engine not wired to the daemon** — `VoiceAliveService` still has no conductor tools, session binding, or audio state; `createAsrEngine` is exported for the supervisor in ticket 13 to own.
- **No bundled weights** — the ASR engine reads a model directory supplied by its caller; downloading and verifying Whisper or Parakeet weights is ticket 19's job, so `load` rejects until that directory exists.
- **Placeholder settings panes** — the five tabs switch, but each pane is an honest placeholder; the audio, shortcut, model, workspace, and privacy controls attach in later waves, with models, workspaces, and privacy in tickets 19–21.
- **Fixture history** — the history window lists a fixed in-memory fixture through `createHistorySource`; the durable store replaces that factory in ticket 22.
- **Local panel state** — the orb reads one client store ([`src/client/panel/state.ts`](src/client/panel/state.ts)) that the audio state machine drives from ticket 10.
- **Panel route is shell-owned** — this package emits `dist/panel/` with document-relative URLs, but the Desktop protocol handler must map `/voice/*` onto it. The Web server does not serve the panel.
- **Shell-sized lazy assets** — the panel build carries the client kernel's code-split grammar and font assets, so `dist/panel/` is roughly 20 MB on disk. The panel never loads those chunks; they exist because the shell's static module table reaches them.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The panel boot table is generated at build time only because the panel document is served statically. Reusing the Web boot rows keeps one client kernel: the panel has no fork of React mounting, module loading, or plugin activation. The client guard keeps the same dual-face row safe when the chat surface also mounts the bundle.

</details>
