---
description: "把语音面板的双面配置行加入基于 dsh-base 的 profile。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-voice-alive-bundle

[English](README.md) | 中文

## 概述

把语音面板配置行加入基于 `dsh-base` 的 profile。该层插入一条双面配置行：Host 的 `voiceAlive` 服务命名空间，以及仅在面板文档内渲染的浏览器客户端。随包的 `web` profile 模板会在 `@deepseek-ai/dsh-web-app` 之后选择该层，Desktop 也从该模板初始化其 profile。插入是增量的，因此可与任何基于 base 的配置树组合。面板文档本身随插件包发布在 `dist/panel/` 下。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

在 profile 的 `dsh.profile.bundles` 列表中将该包放在 `@deepseek-ai/dsh-base` 之后；启动器会通过 `dsh.bundle.patch` 解析 `cordis.patch.yml`。

### 安装到 profile

profile 通过在其有序 Bundle 列表中点名该包来组合此层。随包的 `web` 模板已将其放在 `@deepseek-ai/dsh-web-app` 之后，因此全新的 Web 或 Desktop profile 会挂载该配置行；显式组合的 profile 也以同样方式加入它。

```yaml
dsh:
  profile:
    bundles:
      - '@deepseek-ai/dsh-base'
      - '@deepseek-ai/dsh-voice-alive-bundle'
```

### 你将获得

唯一的 `voice-alive` 配置行把 `VoiceAliveService` 挂载为 `ctx.voiceAlive`，并提供面板文档所启动的客户端配置行。[插件包](../../interaction/voice-alive/README.zh.md)拥有这两半以及面板构建。

该层还按 id 禁用 `otel`、`session-telemetry-otel`、`desktop-product-telemetry` 与 `product-analytics` 配置行。本分支不包含遥测，因此即使 `dsh-base` 与 `dsh-web-app` 插入了这些行，它们也不会启动 fiber。后续层仍可定位相同 id：与所有配置行一样，最后一次写入生效。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

该层就是 `cordis.patch.yml` 中的一个 insert 列表。配置行 id 必须保持稳定：后续层按 id 覆盖该行，而客户端名册是从声明 `dsh.client` 的包扫描而来，并非来自第二份列表。该行之所以是双面的，是因为包同时声明 Host 入口与 `./client` 导出；客户端插件只在面板文档中激活，因此挂载同一行的主聊天界面不受影响。

| 源码 | 职责 |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | 插入的 `voice-alive` 配置行和已禁用的遥测配置行 |
| [`src/index.ts`](src/index.ts) | 模块占位；该层由 patch 文档承载 |
| [`package.json`](package.json) | `dsh.bundle.patch` 声明与插件依赖 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Bundle 组](../README.zh.md) — 可安装的 patch 层及其组合顺序。
- [Base 层](../base/README.zh.md) — 该层所组合的共享核心。
- [Web 应用层](../web-app/README.zh.md) — 提供主客户端名册的界面。
- [语音插件包](../../interaction/voice-alive/README.zh.md) — Host 服务、客户端入口与面板文档。
- [应用启动](../../boot/app-boot/README.zh.md) — `dsh.profile.bundles` 各层如何变成条目。

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过挂载 voice-alive 配置行——它注册四个 conductor 工具。

#### KV Cache effect

加载该 Bundle 会加载那条配置行，因此模型可见的工具块及其缓存边界随该行的定义变化。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **仅含 conductor** — `VoiceAliveService` 携带四个 conductor 工具并把最后一次绑定保存在内存中；持久化绑定存储、音频状态与语音引擎不属于该层。
- **面板路由不在该层** — Desktop 协议处理器拥有 `/voice/*`，必须提供插件包的 `dist/panel/`；Web 服务器不暴露面板。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文 — 点击展开</summary>

该层保持仅 patch，以便 profile 可以在不改动插件包的情况下移除它。保持单行配置可让后续面板 profile patch 维持按 id 覆盖的语义。

</details>
