---
description: "挂载语音面板的 Host 服务命名空间及其专用的浏览器面板客户端。"
kind: "package-reference"
---

# @deepseek-ai/dsh-voice-alive

[English](README.md) | 中文

## 概述

为随附的 Web 与 Desktop profile 提供语音面板的 Host 服务与专用浏览器面板。同一条双面配置行在 Host 中挂载 `ctx.voiceAlive`，并提供仅在面板文档内渲染的客户端条目。该客户端在主聊天界面保持惰性。面板文档以语音专用名册启动常规客户端内核，名册由包自身的 `dist/panel/` 提供。面板渲染单色 Orb 与其两个窗口控件；settings 与 history 作为同一文档的独立界面打开，由 `?surface=` 选择。Bundle 层把这条配置行组合到 `dsh-base` 之上。

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

通过[语音 Bundle 层](../../bundle/voice-alive/README.zh.md)挂载该配置行，或在已包含 `dsh-base` 的组合中直接插入它。

### 何时选择它

当 profile 承载语音面板时选择此包：它同时拥有守护进程命名空间与面板客户端。若要将会话草稿中的听写文本插入输入框，请使用现有的 voice-input bundle；此包从不接触输入框。

### 最小配置

该配置行不接受配置；模型、音频设备与绑定相关的设置通过该服务挂载。

```yaml
- id: voice-alive
  name: '@deepseek-ai/dsh-voice-alive'
```

Host 半边注册 `ctx.voiceAlive`。浏览器半边仅在文档的 `<html>` 带有 `data-dsh-voice-panel` 时激活，而面板文档正是如此。

### ASR 引擎

包根还导出守护进程将要驱动的串行本地识别器。它启动一个 `ELECTRON_RUN_AS_NODE` 子进程，从调用方提供的目录加载且只加载一个 Whisper 或 Parakeet 模型，绝不会回退到另一个模型。

```ts
import { createAsrEngine } from '@deepseek-ai/dsh-voice-alive'

const engine = createAsrEngine()
await engine.load('whisper', '/path/to/verified/whisper-onnx')
const result = await engine.transcribe({ id: 'turn-1', pcm: samples, sampleRate: 16000 })
```

该目录必须已包含 ONNX 权重与 `tokens.txt`；此包从不下载它们，缺失或不兼容的目录会以 `AsrEngineError` 拒绝，而不是启动另一个模型。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

面板作为静态文档由 shell 源提供，因此任何 Host 请求都无法向其中注入 `window.__DSH_BOOT__`。面板构建于是在构建期运行 Web shell 自身的启动协议：用 `composeEntries` 从语音 Bundle patch 组合名册，把各包的客户端产物复制到 `plugins/`，并通过 `renderIndexInjections` 渲染 `bootInjections`。运行时 `AppWebEntry` 运行未改动的客户端内核，客户端配置行则在 `#root` 下挂载一个 React 根。

| 源码 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 注册为 `ctx.voiceAlive` 的 Host `VoiceAliveService`，以及导出的 ASR 接缝 |
| [`src/engine/asr.ts`](src/engine/asr.ts) | Host 引擎：启动、握手、串行队列、空闲关闭与类型化失败 |
| [`src/engine/asr-worker.ts`](src/engine/asr-worker.ts) | Worker 进程：stdin 与 fd 3 上的 JSON 行协议、sherpa-onnx Whisper/Parakeet |
| [`src/engine/types.ts`](src/engine/types.ts) | ASR 请求/结果/引擎契约与 worker 帧 |
| [`src/client/index.ts`](src/client/index.ts) | 面板文档激活判定 |
| [`src/client/mount.tsx`](src/client/mount.tsx) | React 根挂载、按 URL 选择界面与释放 |
| [`src/client/surfaces.ts`](src/client/surfaces.ts) | 从 `?surface=panel\|settings\|history` 解析的界面注册表 |
| [`src/client/surfaces/`](src/client/surfaces/) | 每个界面一个组件：panel、settings、history |
| [`src/client/orb/`](src/client/orb/) | 单色 Orb 画布、其调色板与运动数学 |
| [`src/client/panel/`](src/client/panel/) | 面板 Orb 状态存储、shell 桥接与窗口控件 |
| [`src/client/settings/`](src/client/settings/) | 五标签页 settings 框架及其占位面板 |
| [`src/client/history/`](src/client/history/) | 历史列表、搜索、删除流程与 `HistorySource` 接缝 |
| [`src/client/styles/`](src/client/styles/) | 从 `voice-plugin/design/` 复制的设计系统样式表 |
| [`panel/main.ts`](panel/main.ts) | 运行 `AppWebEntry` 的面板文档入口 |
| [`panel/vite.config.ts`](panel/vite.config.ts) | 使用 shell 浏览器 define 的相对基址面板构建 |
| [`scripts/assemble-panel.ts`](scripts/assemble-panel.ts) | 语音专用启动表与复制后的客户端 Bundle |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [语音 Bundle 层](../../bundle/voice-alive/README.zh.md) — 插入此配置行的 profile patch。
- [客户端内核](../../client/web/README.zh.md) — 面板运行的启动入口与静态模块表。
- [客户端模块系统](../../client/modules/README.zh.md) — 面板构建所渲染的 `__DSH_BOOT__` 协议。
- [应用启动](../../boot/app-boot/README.zh.md) — profile 组合与 Bundle patch 解析。
- [Web 应用层](../../bundle/web-app/README.zh.md) — 面板复用的启动机制所属界面。
- [交互包](../README.zh.md) — 此包所属的人机协作包组。

-----

<a id="model-experience"></a>
## 模型体验

无，因为该配置行只注册 Host 服务命名空间与浏览器面板挂载，不添加工具、提示词段落或 Session 事件。

#### KV Cache effect

该配置行不改变请求组装，因此没有任何提示词段落或缓存边界依赖它。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **引擎尚未接入守护进程** — `VoiceAliveService` 仍无 conductor 工具、会话绑定或音频状态；`createAsrEngine` 已导出，供工单 13 的监督器拥有。
- **不捆绑权重** — ASR 引擎读取调用方提供的模型目录；下载并校验 Whisper 或 Parakeet 权重属于工单 19 的职责，因此在该目录存在之前 `load` 会拒绝。
- **占位 settings 面板** — 五个标签页可以切换，但每个面板都是如实的占位实现；音频、快捷键、模型、工作区与隐私控件在后续波次中接入，其中模型、工作区与隐私属于工单 19–21。
- **Fixture 历史** — 历史窗口通过 `createHistorySource` 列出一份固定的内存 Fixture；持久化存储将在工单 22 中替换该工厂。
- **本地面板状态** — Orb 读取一个客户端存储（[`src/client/panel/state.ts`](src/client/panel/state.ts)），音频状态机从工单 10 起驱动它。
- **面板路由由 shell 拥有** — 此包输出带文档相对 URL 的 `dist/panel/`，但 Desktop 协议处理器必须把 `/voice/*` 映射到它。Web 服务器不提供面板。
- **与 shell 同等规模的惰性资源** — 面板构建携带客户端内核按需拆分的语法与字体资源，因此 `dist/panel/` 在磁盘上约 20 MB。面板从不加载这些分块；它们存在是因为 shell 的静态模块表会触及它们。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文 — 点击展开</summary>

面板启动表只在构建期生成，因为面板文档是静态提供的。复用 Web 启动配置行保证了单一客户端内核：面板没有另起一套 React 挂载、模块加载或插件激活。客户端判定让同一条双面配置行在聊天界面也挂载该 Bundle 时仍然安全。

</details>
