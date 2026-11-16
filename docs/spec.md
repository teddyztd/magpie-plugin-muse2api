# Spec：muse2api Magpie 插件

> 来源：`/to-spec`（Step 6）。上游需求来自 Step 3–5 的访谈收敛（Round 1 / Round 2）。
> 规范依据：<https://usemagpie.ai/docs/zh/plugins>；源项目：<https://github.com/czg86389-hub/muse2api>。

## Problem Statement

`muse2api` 把 muse.ai 逆向封装成 OpenAI 兼容 API，提供文本（`muse-spark`）、图片（`muse-image`）、
视频（`muse-video`）三类能力，但：

1. 用户要在 Magpie 里用它，必须手工记 baseURL 与 `MUSE2API_KEY`，没有登录流程。
2. Magpie 供应商插件只能转发 **chat 协议**（chat completions / Responses / Anthropic Messages /
   Gemini），规范里**没有**图片或视频生成钩子；页面又跑在 `connect-src 'none'` 的 sandbox 里，
   不能自己发请求。因此图片与视频在 Magpie 侧没有入口。
3. 用户当前装的是 `github:JohnWangggg/magpie-muse-web`（走浏览器登录、只做文本），与本插件
   provider 会同时暴露 `muse-spark`，造成模型列表重复。

需要一个 Magpie 插件：一次登录配好 muse2api 作为文本 provider，并用**工具插件**补齐图片/视频
的提交与查询能力；安装与更新全程走 GitHub 路线（`magpie plugin add github:owner/repo`），
不改动 muse2api 的任何功能语义。

## Solution

单个 npm 包 `magpie-plugin-muse2api`（仓库 `teddyztd/magpie-plugin-muse2api`，公开，topic
`magpie-plugin`），同时承担两种角色：

- **供应商插件**：provider id `muse2api`，`npm: "@ai-sdk/openai-compatible"`，模型 `muse-spark`；
  登录方式为 API key + 手填 baseURL，`authorize` 内调 `GET /v1/models` 校验；baseURL 存进
  auth metadata，`loader` 据此拼 `baseURL = <baseUrl>/v1`。
- **工具插件**：4 个工具，覆盖图片/视频的提交与查询：
  - `generate_image` / `image_status`
  - `generate_video` / `video_status`

图片**一律异步**：`generate_image` 提交即返回 `task_id`；`image_status` 查询任务，完成时返回
`/v1/media/{name}` 直链（该路由无鉴权，可直接预览/下载）。工具内部在 40 秒预算内做短轮询，
能赶上的直接给 URL，赶不上的返回 `task_id` 让 agent 再查。

```text
Magpie GUI ──登录──> authorize(baseUrl, apiKey) ──GET /v1/models──> muse2api
    │                                                              │
    ├──对话──> provider muse2api (muse-spark) ──/v1/chat/completions──┘
    │
    └──工具──> generate_image ──POST /v1/images/tasks──> {task_id}
               image_status   ──GET  /v1/images/tasks/{id}──> {url, …}
               generate_video ──POST /v1/videos/generations──> {task_id}
               video_status   ──GET  /v1/videos/{id}──> {url, …}
```

## User Stories

1. 作为 Magpie 用户，我在设置里安装 `github:teddyztd/magpie-plugin-muse2api`，登录时填 muse2api
   地址与 API key，能通过校验并在模型列表里看到 `muse-spark`。
2. 作为用户，我选 `muse-spark` 对话，回答正常流式返回（Magpie 网关转 SSE）。
3. 作为用户，我对 agent 说“画一只在雨里的猫”，agent 调 `generate_image`，拿到 `task_id` 后调
   `image_status` 取回图片直链，并在对话里看到 URL。
4. 作为用户，我说“把这张图改成水彩风格”并给出参考图 URL，agent 调 `generate_image` 带
   `reference_images`，走 muse2api 的参考图链路。
5. 作为用户，我说“生成一段 5 秒的海浪视频”，agent 调 `generate_video` 拿 `task_id`，随后调
   `video_status` 取回视频直链。
6. 作为用户，我卸载 `magpie-muse-web` 后，模型列表里 `muse-spark` 只出现一次（本插件）。
7. 作为维护者，`bun test` 在 mock muse2api 上覆盖登录、模型拉取、四个工具的提交与查询、缺配置
   报错，不依赖真实实例。
8. 作为维护者，我 push 到 main 后，Magpie 能在 ≤10 分钟内通过 GitHub 发现更新（topic
   `magpie-plugin`）。

## Implementation Decisions

### 包与入口

- `package.json`：`"type": "module"`；`"exports": { "./server": "./server/index.mjs" }`；
  `"magpie": { "name": "muse2api", "summary": "…", "icon": "…" }`；`"license": "MIT"`；
  `"files": ["server", "README.md", "LICENSE"]`；`"scripts": { "test": "bun test" }`。
- 入口 `server/index.mjs` 导出 `export const Muse2ApiPlugin = async (input, options) => ({ config, auth, provider, tool })`。
  第二参数 `options` 与已装 `magpie-muse-web` 的写法一致（Magpie 传入插件选项对象）。
- 不导出 `export default`，避免被当成 `{id, server}` 形态误解析。

### 供应商

- `config` 钩子写 `cfg.provider["muse2api"]`：
  - `name: "muse2api"`，`npm: "@ai-sdk/openai-compatible"`，`api: "http://127.0.0.1:18610/v1"`（占位，
    loader 会用登录时的 baseURL 覆盖）。
  - `models["muse-spark"] = { name: "Muse Spark", reasoning: false, attachment: false,
    tool_call: false, modalities: { input: ["text"], output: ["text"] },
    limit: { context: 128000, output: 16000 }, cost: { input: 0, output: 0 } }`。
  - `tool_call: false` 的依据：muse2api `CFG.tool_protocol` 默认关闭，注入 tools 会被上游拒绝，
    声明支持只会诱导 agent 发 tools。
- `auth`：
  - `provider: "muse2api"`，`icon`（data URL 或内置静态图标）。
  - `methods: [{ type: "api", label: "muse2api API key", placeholder: "m2a_…", prompts: [
    { type: "text", key: "baseUrl", message: "muse2api 地址", placeholder: "http://127.0.0.1:18610",
      validate: 必须是 http(s) URL；另外拒绝带 /v1 的地址（插件会自动补） },
    { type: "password", key: "apiKey", message: "MUSE2API_KEY" } ] }]`。
  - `authorize(inputs)`：`GET ${baseUrl}/v1/models`，带 `Authorization: Bearer <key>`；
    2xx → `{ type: "success", key: inputs.apiKey, metadata: { baseUrl } }`；
    401/403 → `{ type: "failed", error: "API key 无效（muse2api 返回 401）" }`；
    网络错误 → `{ type: "failed", error: "无法连接 <baseUrl>/v1/models：…" }`。
- `loader(getAuth)`：读 `auth.metadata.baseUrl`（缺失时回退 `api` 默认值），返回
  `{ baseURL: `${baseUrl}/v1`, apiKey: auth.key }`。
- `provider.models(provider, { auth })`：`GET ${baseUrl}/v1/models`，把返回的 `muse-*` 映射成模型
  定义（`muse-spark` 文本；`muse-image` / `muse-video` 不作为对话模型暴露，避免用户在聊天里选到
  不支持 chat 的模型）；失败时返回原列表（回退静态 `muse-spark`）。
- 401 处理交给 Magpie 默认（标记账号）；不实现 `X-Magpie-Sign-In`。
- `maxConcurrency: 1` 的依据：muse2api 背后是单个 Chromium 会话在驱动 muse.ai 网页助手，
  同一账号上的并发请求会互相抢占同一个浏览器上下文；把插件侧并发压到 1，让 muse2api 自己的
  任务队列（`CONCURRENCY`）成为唯一并发源。图片/视频工具本身是异步任务，不依赖并发换吞吐。

### 工具

统一约定：

- 用 `import { tool } from "@opencode-ai/plugin"`；`args` 用 zod 字段表，每项带 `.describe()`。
- 工具名：`generate_image`、`image_status`、`generate_video`、`video_status`。Magpie 侧会加
  `<插件短名>_` 前缀（展示为 `muse2api_generate_image`）。
- 配置读取顺序：`options.baseUrl` / `options.apiKey` → `input.magpie.option?.("baseUrl")` /
  `("apiKey")` → `process.env.MUSE2API_BASE_URL` / `MUSE2API_KEY`。全缺时返回**可 `JSON.parse` 的
  错误对象**（`ok:false` / `status` / `error`），文案指向「插件 → 已安装 → muse2api → 选项」，
  并提示 `baseUrl` 不要带 `/v1`。
- 单次请求超时按剩余预算截断：默认 50s；`image_status` 轮询时每次请求 ≤10s，且整体受
  `wait_seconds`（上限 40s）约束，不会把一次调用拖过宿主的 55s 上限。
- 返回契约：**任何一次调用都返回可 `JSON.parse` 的字符串**（Magpie 把对象以 JSON 发回，这里显式
  `JSON.stringify` 保证可读）。成功为 `{ ok: true, … }`；失败统一为
  `{ ok: false, status, error, … }`，按需带 `baseUrl` / `task_id` / `http_status` / `field` / `hint`。
  不存在「错误返回中文纯文本」这一路。

`generate_image`：

- 参数：`prompt`（必填）、`size?`、`aspect_ratio?`、`reference_images?`（`string[]`，本地路径或 URL；
  本地路径转 `data:` URL 后放 `images`）、`model?`（默认 `muse-image`）、`extra?`。
- 参考图在本地先拦：最多 8 张，单张 ≤40 MiB、合计 ≤100 MiB（与 muse2api 上游 `engine.py` 的
  `MAX_REFERENCE_IMAGE_BYTES` / `MAX_REFERENCE_TOTAL_BYTES` 同量级，base64 按解码后字节算）；
  超限时请求不发出，直接返回可操作的 JSON 错误。
- 请求：`POST ${base}/v1/images/tasks`，body 至少 `{ prompt, model, async: true }`，参考图放
  `images` / `reference_image`（依据 `ImageRequest` 字段）。
- 返回：`{ ok: true, task_id, status, progress, hint: "调用 image_status 取结果" }`。

`image_status`：

- 参数：`task_id`（必填）、`wait_seconds?`（默认 40，上限 40）。
- 请求：`GET ${base}/v1/images/tasks/{task_id}`，每 1.5s 一次，直到 `status === "completed"` 或
  预算耗尽。
- 完成：返回 `{ ok: true, status: "completed", task_id, url: data[0].url, size, kind, bytes,
  revised_prompt }`；未完成：`{ ok: true, status, progress, task_id, hint }`；失败：
  `{ ok: false, status, error, task_id?, http_status? }`。

`generate_video`：

- 参数：`prompt`（必填）、`duration?`、`aspect_ratio?`、`size?`、`reference_images?`、`model?`
  （默认 `muse-video`）。
- 请求：`POST ${base}/v1/videos/generations`，body `{ prompt, model, duration?, aspect_ratio?,
  size?, images? }`。
- 返回：`{ ok: true, task_id, status, progress, hint: "调用 video_status 取结果（视频通常数分钟，
  隔一会儿再查）" }`（不在工具内轮询）。

`video_status`：

- 参数：只有 `task_id`（必填）；**单次查询，不在工具内 sleep / 循环**。
- 请求：`GET ${base}/v1/videos/{task_id}`，一次。
- 完成：`{ ok: true, status: "completed", task_id, url: task.url || task.video?.url || task.result?.url }`；
  否则 `{ ok: true, status, progress, task_id, hint }`；失败：`{ ok: false, status, error, task_id }`。

### 与 muse-web 的关系

README 明确：本插件**替代** `github:JohnWangggg/magpie-muse-web`（两者都提供 `muse-spark`，同时
启用会在模型列表出现重复）；安装本插件后请卸载/停用 muse-web。provider id 用 `muse2api`，
不与 `muse-web` 冲突，卸载前也能共存而不报错。

### 不改动上游

插件只调用 muse2api 既有 HTTP 路由（`/v1/models`、`/v1/images/tasks`、`/v1/images/tasks/{id}`、
`/v1/videos/generations`、`/v1/videos/{id}`、`/v1/media/{name}`），不修改其代码、配置或数据；
不新增 muse2api 侧能力。

## Testing Decisions

- `bun test`（无 TypeScript 编译步骤；纯 ESM JS）。
- 测试内起 `node:http` mock muse2api，覆盖：
  1. `authorize`：正确 key → success + metadata.baseUrl；错误 key → failed；不可达 → failed。
  2. `loader`：返回 `baseURL = <baseUrl>/v1` 与 `apiKey`。
  3. `provider.models`：mock `/v1/models` 返回三条 → 只暴露 `muse-spark`；mock 500 → 回退静态。
  4. `generate_image`：断言请求体含 `prompt` 与 `async: true`，返回 `task_id`。
  5. `image_status`：mock 先 `queued` 后 `completed` → 返回 `url`。
  6. `generate_video` / `video_status`：提交拿 `task_id`；`video_status` 每次只发一次请求（计数差 1），
     第一次 running、第二次 completed 并取 `url`；`url` / `video.url` / `result.url` 三种形状各测一次；
     上游 `failed` 任务 → `ok:false` + `error`。
  7. 返回契约：四个工具的成功与全部失败路径（缺配置、空 prompt、参考图类型/张数、连接失败、
     上游 401、任务 404、完成但无 URL）逐条 `JSON.parse` 成功，失败含 `ok:false` / `status` / `error`；
     参考图的体积超限在工具层另有一例（超限不发请求）。
  8. 参考图体积（单元层，注入小上限）：超张数、超单张、超合计、data URL 按解码字节、正常 8 张通过；
     另断言 schema 描述里的张数与体积文案来自 `config.mjs` 常量。
  9. `auth.icon` 存在且与 `package.json` 的 `magpie.icon` 不同。
  10. 缺配置：不设 options/env → 返回可操作的 JSON 错误，`error` 含「插件 → 已安装 → muse2api → 选项」
      与「不要带 /v1」。
- 只测插件导出的钩子与工具，不测 muse2api 内部（那是上游）。
- 真实验收（用户侧）：Magpie GUI 安装 → 登录填地址与 key → `provider test` 通过 → 对话 →
  让 agent 调 `generate_image` / `image_status`，确认返回 `/v1/media/...` 直链可打开。

## Out of Scope

- OAuth / 设备码登录（muse2api 只有 Bearer key）。
- chat 协议转换（Magpie 网关负责）。
- b64_json 落盘、缩略图生成、画廊。
- 面板 / 页面（sandbox 不允许页面自己发请求，且文档无插件 HTTP 服务注册机制）。
- muse2api 的账号池、admin API、队列管理、keepalive。
- 发布到 npm（gh 路线即可被发现与安装）。
- 自动启动/管理 muse2api 进程（用户自行运行 Docker 或 `python app.py`）。

## Further Notes

- 事实依据（muse2api `app.py`）：`MODELS` 在 276 行；`auth()` 约 340 行；`ImageRequest` 511 行；
  `VideoRequest` 529 行；`images_generations` 1399 行；`get_image_task` 约 1370 行；
  `videos_generations` 1520 行；`get_media` 1891 行（无 `Depends(auth)`）；`media_url` 1034 行。
- 工具 55 秒上限来自文档“每个工具最多运行 55 秒（到时 `ctx.abort`）”；图片轮询预算取 40 秒，
  留 10 秒给网络与序列化。
- Magpie 发现机制：仓库 topic `magpie-plugin`、`package.json` 在根、入口文件已提交（非 dist-only）；
  GitHub API 比对提交，≤10 分钟。
- 本机 Magpie 配置目录 `C:\Users\Teddy\.config\magpie`（`plugins.json`、`plugins/node_modules/`），
  用户将从 GUI 安装；排障看 `%LOCALAPPDATA%\Magpie\logs\app.log`。
