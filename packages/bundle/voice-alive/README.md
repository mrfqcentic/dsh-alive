---
description: "Add the voice panel's dual-face row to a dsh-base-backed profile."
kind: "package-bundle"
---

# @deepseek-ai/dsh-voice-alive-bundle

English | [中文](README.zh.md)

## Summary

Add the voice panel row to a profile built on `dsh-base`. The layer inserts one dual-face row: a Host `voiceAlive` service namespace and a browser client that renders only inside the panel document. No shipped profile selects the layer yet; the Desktop fork adds it in its own profile patch. The insert is additive, so it composes with any base-backed tree. The panel document itself ships in the plugin package under `dist/panel/`.

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

Add the package after `@deepseek-ai/dsh-base` in a profile's `dsh.profile.bundles` list; the launcher resolves `cordis.patch.yml` through `dsh.bundle.patch`.

### Install into a profile

A profile composes the layer by naming the package in its ordered bundle list. The shipped templates do not include it, so the fork's profile patch is what selects it for the Desktop application; until that patch lands, only an explicitly composed profile mounts the row.

```yaml
dsh:
  profile:
    bundles:
      - '@deepseek-ai/dsh-base'
      - '@deepseek-ai/dsh-voice-alive-bundle'
```

### What you get

The single `voice-alive` row mounts `VoiceAliveService` as `ctx.voiceAlive` and contributes the client row that the panel document boots. The [plugin package](../../experimental/voice-alive/README.md) owns both halves and the panel build.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The layer is one insert list in `cordis.patch.yml`. Row ids must stay stable: a later layer overrides the row by id, and the client roster is scanned from packages that declare `dsh.client`, not from a second list. The row is dual-face because the package declares both a Host entry and a `./client` export; the client plugin activates only in the panel document, so the main chat surface that mounts the same row stays unaffected.

| Source | Responsibility |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | The one inserted `voice-alive` row |
| [`src/index.ts`](src/index.ts) | Module placeholder; the patch document carries the layer |
| [`package.json`](package.json) | `dsh.bundle.patch` declaration and the plugin dependency |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Bundle group](../README.md) — the installable patch layers and their composition order.
- [Base layer](../base/README.md) — the shared core this layer composes over.
- [Web application layer](../web-app/README.md) — the surface that serves the main client roster.
- [Voice plugin package](../../experimental/voice-alive/README.md) — the Host service, client entry, and panel document.
- [Application boot](../../boot/app-boot/README.md) — how `dsh.profile.bundles` layers become entries.

-----

<a id="model-experience"></a>
## Model Experience

None, as the layer mounts a Host service namespace and a panel-only browser client without adding model tools or prompt text.

#### KV Cache effect

The layer contributes no prompt text; the row it mounts owns any future model-facing behavior.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Not selected by a shipped profile** — `dsh-base`, `dsh-web-app`, and the other templates leave the layer out. The Desktop fork adds it in its profile patch.
- **Host row is a namespace only** — conductor tools, binding, and engines arrive in later tickets; the bundle mounts no voice capability yet.
- **Panel route is outside this layer** — the Desktop protocol handler owns `/voice/*` and must serve the plugin package's `dist/panel/`; the Web server does not expose the panel.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The layer stays patch-only so a profile can remove it without touching the plugin package. Keeping one row preserves override-by-id semantics for a later panel profile patch.

</details>
