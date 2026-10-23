---
description: "挂载语音面板的 Host 服务命名空间及其专用的浏览器面板客户端。"
kind: "package-reference"
---

# @deepseek-ai/dsh-voice-alive

[English](README.md) | 中文

## 概述

为随附的 Web 与 Desktop profile 提供语音面板的 Host 服务与专用浏览器面板。面板以来自自身 `dist/panel/` 的语音专用名册启动客户端内核，渲染单色 Orb 与窗口控件，并把 settings 与 history 作为由 `?surface=` 选择的界面打开。Host 在 `ELECTRON_RUN_AS_NODE` worker 中运行两个语音引擎：`createAsrEngine` 用 Whisper 或 Parakeet 转写，`createTtsEngine` 流式输出 Kokoro 分块，`createEngineSupervisor` 为每类引擎持有恰好一个模型并报告健康状态。Host 配置行注册四个 conductor 工具，用于绑定新建或恢复的会话，并在重启后恢复该绑定。Bundle 层把这条配置行组合到 `dsh-base` 之上。

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

### Conductor 工具

Host 配置行在 `ctx.tools` 上注册四个普通工具。`voice_list_workspaces` 报告每个工作区的 id、标题、路径与会话数。`voice_open_workspace` 把面板绑定到工作区中最近一个未归档会话，或新建一个；`voice_new_session` 新建并绑定一个全新会话；`voice_resume_session` 绑定指定会话或最近的会话。每个绑定工具按精确标题、目录路径或路径末段解析工作区；名称只部分匹配或对应多个工作区时返回候选，而不是自行选择。失败是类型化且明确的：未知工作区、缺少会话、已归档会话与 subagent 会话各自返回一个错误码，且不改变绑定。

conductor 通过 `VoiceBindingTarget` 接收端写入每一次完成的绑定；最后一次被接受的绑定可从 `ctx.voiceConductor.currentBinding` 读取。

### 会话绑定

`ctx.voiceAlive.binding` 拥有面板跟随的唯一会话。Host 启动时，`ensure()` 会在工作区注册与日志仍然存在时恢复已存储的会话；否则它会在 `~/.dsh/voice/workspace` 创建名为 `Voice` 的 Audio 工作区并在其中创建一个会话，然后记录这次切换。conductor 通过 `bind()` 更换所跟随的会话；`unbind()` 丢弃绑定，`restore()` 只报告已存储的配对，不创建也不写入。

该记录位于 `voice_binding` 存储域（`$DSH_HOME/storages/voice_binding/binding/current.json`），保存 `sessionId`、`workspaceId` 与 `updatedAt`。损坏、不可读或不符合 schema 的记录会按不存在读取；启动期间的存储失败会让内存中的绑定继续可用，而不会让激活失败。所有写入都在同一条链上执行，因此并发的 `bind()` 与 `ensure()` 调用不会让记录交错。

### ASR 引擎

包根还导出守护进程将要驱动的串行本地识别器。它启动一个 `ELECTRON_RUN_AS_NODE` 子进程，从调用方提供的目录加载且只加载一个 Whisper 或 Parakeet 模型，绝不会回退到另一个模型。

```ts
import { createAsrEngine } from '@deepseek-ai/dsh-voice-alive'

const engine = createAsrEngine()
await engine.load('whisper', '/path/to/verified/whisper-onnx')
const result = await engine.transcribe({ id: 'turn-1', pcm: new Int16Array(16000), sampleRate: 16000 })
```

该目录必须已包含 ONNX 权重与 `tokens.txt`；此包从不下载它们，缺失或不兼容的目录会以 `AsrEngineError` 拒绝，而不是启动另一个模型。

### TTS 引擎

包根还导出本地 Kokoro 合成器。它把回复切分成按句的任务，每句就绪即刻返回一个 24 kHz 单声道 16 位 WAV，并保持分块顺序。

```ts
import { createTtsEngine } from '@deepseek-ai/dsh-voice-alive'

const engine = createTtsEngine()
await engine.load('/path/to/verified/kokoro-onnx', { voice: 'af_heart' })
await engine.speak({ id: 'turn-1', text: 'Hello there. How are you?' }, chunk => {
  // chunk.wav is a complete WAV; playback can start before the reply finishes.
})
```

该目录必须已包含 ONNX 模型与分词器文件；远程模型加载保持禁用，缺失的目录会以 `TtsError` 拒绝，而不是回退到另一个模型。

### 引擎监督器

包根还导出守护进程将要驱动的监督器。它把识别器与合成器连同各自选定的模型一起持有，在该引擎自身的串行通道上执行模型切换与任务，并报告两者的健康状态。

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

`configure` 逐引擎切换模型：加载失败的引擎会以 `error` 状态显式卸载，而不是保留之前的模型，同时另一个引擎继续服务。每个引擎有各自有界的等待队列，因此转写队列满不会延误语音输出。`health` 报告 `status`、`lastErrorCode`、`lastSuccessAt` 与 `restarts`；`restart('asr' | 'tts')` 用已应用的模型选择重载其中一个引擎。崩溃的 worker 被限制在所属引擎内，并在下一次任务时重新启动；`shutdown` 是幂等的。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

面板作为静态文档由 shell 源提供，因此任何 Host 请求都无法向其中注入 `window.__DSH_BOOT__`。面板构建于是在构建期运行 Web shell 自身的启动协议：用 `composeEntries` 从语音 Bundle patch 组合名册，把各包的客户端产物复制到 `plugins/`，并通过 `renderIndexInjections` 渲染 `bootInjections`。运行时 `AppWebEntry` 运行未改动的客户端内核，客户端配置行则在 `#root` 下挂载一个 React 根。

| 源码 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 注册为 `ctx.voiceAlive` 的 Host `VoiceAliveService`，以及导出的 ASR、TTS、监督器与绑定入口 |
| [`src/conductor/tools.ts`](src/conductor/tools.ts) | Host conductor 服务：四个工作区与会话工具、它们的类型化结果，以及绑定接收端 |
| [`src/binding/`](src/binding/) | 持久化的会话绑定、启动恢复与 Audio 工作区回退 |
| [`src/engine/asr.ts`](src/engine/asr.ts) | Host ASR 引擎：启动、握手、串行队列、空闲关闭与类型化失败 |
| [`src/engine/asr-worker.ts`](src/engine/asr-worker.ts) | ASR Worker：stdin 与 fd 3 上的 JSON 行协议、sherpa-onnx Whisper/Parakeet |
| [`src/engine/types.ts`](src/engine/types.ts) | ASR 请求/结果/引擎契约与 worker 帧 |
| [`src/engine/tts.ts`](src/engine/tts.ts) | Host TTS 引擎：句子切分、有序流式输出、取消与空闲关闭 |
| [`src/engine/tts-types.ts`](src/engine/tts-types.ts) | TTS 请求/分块/引擎契约与 worker 帧 |
| [`src/engine/tts-worker.ts`](src/engine/tts-worker.ts) | TTS Worker：Kokoro 合成与 stdout 上的 WAV 帧 |
| [`src/engine/supervisor.ts`](src/engine/supervisor.ts) | 引擎监督器：模型选择、按引擎的串行通道与队列、健康、重启、崩溃隔离与关闭 |
| [`src/engine/worker.ts`](src/engine/worker.ts) | 单一 `./worker` 分发器：校验角色并加载 ASR 或 TTS worker |
| [`src/client/index.ts`](src/client/index.ts) | 面板文档激活判定 |
| [`src/client/mount.tsx`](src/client/mount.tsx) | React 根挂载、按 URL 选择界面与释放 |
| [`src/client/surfaces.ts`](src/client/surfaces.ts) | 从 `?surface=panel\|settings\|history` 解析的界面注册表 |
| [`src/client/surfaces/`](src/client/surfaces/) | 每个界面一个组件：panel、settings、history |
| [`src/client/orb/`](src/client/orb/) | 单色 Orb 画布、其调色板与运动数学 |
| [`src/client/panel/`](src/client/panel/) | 面板 Orb 状态存储、shell 桥接与窗口控件 |
| [`src/client/audio/`](src/client/audio/) | 16 kHz 麦克风采集、VAD 分段、词门禁与输入设备枚举；按序 WAV 播放、输出设备路由、输出电平与回声参考节点；消除播放参考、保持半双工尾部并拒绝自我转写的回声防护；串联采集、播放与静音的五态音频状态机 |
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

### Conductor 工具

#### What the model sees

只要该配置行已加载，模型就会看到 `voice_list_workspaces`、`voice_open_workspace`、`voice_new_session` 与 `voice_resume_session` 的 schema。每个绑定结果携带工作区的 id、标题、路径与会话数，以及会话的 id、标题、最后活动时间与归档标记，全部来自注册表。工作区名称只部分匹配或对应多个工作区时返回候选，而不是执行绑定。

#### Token effect

对于加载了该配置行的部署，每个请求都承担固定的 schema 成本。绑定结果会留在调用会话的历史中，直到压缩。

#### KV Cache effect

在工具定义不变时前缀稳定。加载或卸载该配置行会改变工具块，并可能从第一个变化的 schema token 起使复用失效。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **监督器尚未接入守护进程** — `VoiceAliveService` 仍无音频状态；`createEngineSupervisor` 已拥有两个导出的引擎，音频界面将在后续工单中接入。
- **conductor 绑定尚未持久化** — conductor 通过 `VoiceBindingTarget` 记录绑定，但配置行尚未把自己的持久化绑定存储安装到该接收端，因此 `ctx.voiceConductor.currentBinding` 会在重启后丢失。
- **不捆绑权重** — 两个引擎都读取调用方提供的模型目录；下载并校验 Whisper、Parakeet 或 Kokoro 权重属于工单 19 的职责，因此在该目录存在之前 `load` 会拒绝。
- **占位 settings 面板** — 五个标签页可以切换，但每个面板都是如实的占位实现；音频、快捷键、模型、工作区与隐私控件在后续波次中接入，其中模型、工作区与隐私属于工单 19–21。
- **Fixture 历史** — 历史窗口通过 `createHistorySource` 列出一份固定的内存 Fixture；持久化存储将在工单 22 中替换该工厂。
- **本地面板状态** — Orb 读取一个客户端存储（[`src/client/panel/state.ts`](src/client/panel/state.ts)），由音频状态机驱动。
- **回声防护尚未接入面板** — `createEchoGuard` 已导出，供面板界面拥有。采集通过 `CaptureOptions.frameGate` 接受帧级抽头，音频状态机在拿到防护时应用分段级兜底；面板目前两者都不构造。
- **基于能量的词门禁** — 默认词门禁只按分段时长与电平判断，因此音乐、稳态音调或持续轰鸣可能通过。它衡量的是闭合分段而非单个词：560 ms 分段中的 300 ms 词可以通过，而 150 ms 的词低于 450 ms 的下限，会被丢弃。工单 11 将通过同一个注入的 `WordGate` 换成基于转写的词门禁。
- **未验证真实麦克风** — 采集、Worklet 加载、重采样、热插拔、参考消除与打断都在伪 Web Audio 图与合成 PCM 上测试。真实扬声器、真实麦克风、浏览器权限提示与 macOS TCC 路径仍需人工测试；工单 24 负责验收矩阵。
- **面板路由由 shell 拥有** — 此包输出带文档相对 URL 的 `dist/panel/`，但 Desktop 协议处理器必须把 `/voice/*` 映射到它。Web 服务器不提供面板。
- **与 shell 同等规模的惰性资源** — 面板构建携带客户端内核按需拆分的语法与字体资源，因此 `dist/panel/` 在磁盘上约 20 MB。面板从不加载这些分块；它们存在是因为 shell 的静态模块表会触及它们。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文 — 点击展开</summary>

面板启动表只在构建期生成，因为面板文档是静态提供的。复用 Web 启动配置行保证了单一客户端内核：面板没有另起一套 React 挂载、模块加载或插件激活。客户端判定让同一条双面配置行在聊天界面也挂载该 Bundle 时仍然安全。

</details>
