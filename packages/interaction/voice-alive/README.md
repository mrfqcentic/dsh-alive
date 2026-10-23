---
description: "Mount the voice panel's Host service namespace and its panel-only browser client."
kind: "package-reference"
---

# @deepseek-ai/dsh-voice-alive

English | [中文](README.zh.md)

## Summary

Give the shipped Web and Desktop profiles a voice panel Host service and a dedicated browser panel. The same dual-face row mounts `ctx.voiceAlive` in the Host and a client entry that renders only inside the panel document. The client stays inert in the main chat surface. The panel document boots the ordinary client kernel with a voice-only roster served from the package's own `dist/panel/`. The bundle layer composes the row over `dsh-base`.

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

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The panel is served as a static document on the shell origin, so no Host request can inject `window.__DSH_BOOT__` into it. The panel build therefore runs the Web shell's own boot protocol at build time: it composes the roster from the voice bundle patch with `composeEntries`, copies each package's client artifact under `plugins/`, and renders `bootInjections` through `renderIndexInjections`. At runtime `AppWebEntry` runs the unchanged client kernel, and the client row mounts one React root under `#root`.

| Source | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Host `VoiceAliveService` registered as `ctx.voiceAlive` |
| [`src/client/index.ts`](src/client/index.ts) | Panel-document activation gate |
| [`src/client/mount.tsx`](src/client/mount.tsx) | React root mount and disposal |
| [`src/client/PanelPlaceholder.tsx`](src/client/PanelPlaceholder.tsx) | Temporary panel root |
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

- **Empty Host namespace** — `VoiceAliveService` has no conductor tools, session binding, audio state, or engines.
- **Placeholder panel** — the client mounts a single monochrome circle, not the orb or the panel chrome. It shows no state, settings, or history.
- **Placeholder surface in a shipped layer** — the `web` profile template selects the bundle, so a fresh Web or Desktop install mounts the row; the panel itself is still the placeholder above.
- **Panel route is shell-owned** — this package emits `dist/panel/` with document-relative URLs, but the Desktop protocol handler must map `/voice/*` onto it. The Web server does not serve the panel.
- **Shell-sized lazy assets** — the panel build carries the client kernel's code-split grammar and font assets, so `dist/panel/` is roughly 20 MB on disk. The panel never loads those chunks; they exist because the shell's static module table reaches them.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The panel boot table is generated at build time only because the panel document is served statically. Reusing the Web boot rows keeps one client kernel: the panel has no fork of React mounting, module loading, or plugin activation. The client guard keeps the same dual-face row safe when the chat surface also mounts the bundle.

</details>
