---
description: "Add the voice panel's dual-face row to a dsh-base-backed profile."
kind: "package-bundle"
---

# @deepseek-ai/dsh-voice-alive-bundle

English | [中文](README.zh.md)

## Summary

Add the voice panel row to a profile built on `dsh-base`. The layer inserts one dual-face row: a Host `voiceAlive` service namespace and a browser client that renders only inside the panel document. The shipped `web` profile template selects the layer after `@deepseek-ai/dsh-web-app`, and Desktop initialises its profile from that template. The insert is additive, so it composes with any base-backed tree. The panel document itself ships in the plugin package under `dist/panel/`.

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

A profile composes the layer by naming the package in its ordered bundle list. The shipped `web` template already includes it after `@deepseek-ai/dsh-web-app`, so a fresh Web or Desktop profile mounts the row; an explicitly composed profile adds it the same way.

```yaml
dsh:
  profile:
    bundles:
      - '@deepseek-ai/dsh-base'
      - '@deepseek-ai/dsh-voice-alive-bundle'
```

### What you get

The single `voice-alive` row mounts `VoiceAliveService` as `ctx.voiceAlive` and contributes the client row that the panel document boots. The [plugin package](../../interaction/voice-alive/README.md) owns both halves and the panel build.

The layer also disables the `otel`, `session-telemetry-otel`, `desktop-product-telemetry`, and `product-analytics` rows by id. This fork carries no telemetry, so those rows never start a fiber even though `dsh-base` and `dsh-web-app` insert them. A later layer can still target the same ids, because the last write wins as for every row.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The layer is one insert list in `cordis.patch.yml`. Row ids must stay stable: a later layer overrides the row by id, and the client roster is scanned from packages that declare `dsh.client`, not from a second list. The row is dual-face because the package declares both a Host entry and a `./client` export; the client plugin activates only in the panel document, so the main chat surface that mounts the same row stays unaffected.

| Source | Responsibility |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | The inserted `voice-alive` row and the disabled telemetry rows |
| [`src/index.ts`](src/index.ts) | Module placeholder; the patch document carries the layer |
| [`package.json`](package.json) | `dsh.bundle.patch` declaration and the plugin dependency |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Bundle group](../README.md) — the installable patch layers and their composition order.
- [Base layer](../base/README.md) — the shared core this layer composes over.
- [Web application layer](../web-app/README.md) — the surface that serves the main client roster.
- [Voice plugin package](../../interaction/voice-alive/README.md) — the Host service, client entry, and panel document.
- [Application boot](../../boot/app-boot/README.md) — how `dsh.profile.bundles` layers become entries.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the voice-alive row, which registers the four conductor tools.

#### KV Cache effect

Loading the bundle loads that row, so the model-visible tool block and its cache boundary follow the row's definitions.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Conductor only** — `VoiceAliveService` carries the four conductor tools and keeps the last binding in memory; the durable binding store, audio state, and speech engines are not part of this layer.
- **Panel route is outside this layer** — the Desktop protocol handler owns `/voice/*` and must serve the plugin package's `dist/panel/`; the Web server does not expose the panel.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The layer stays patch-only so a profile can remove it without touching the plugin package. Keeping one row preserves override-by-id semantics for a later panel profile patch.

</details>
