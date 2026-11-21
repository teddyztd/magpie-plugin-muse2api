# DSH 侧接入 muse 生图 / 生视频（magpie mcp image，stdio MCP）

> 状态：验收完成。本文档记录从 DSH 会话里调用 muse2api 生图/生视频能力的完整链路、复现命令与证据。

## 背景

- Magpie 插件（本仓库）对外提供 provider（`muse-spark` 对话）+ 4 个工具（`generate_image` / `image_status` / `generate_video` / `video_status`），但此前 DSH 里那条 `mcp__magpie__`（streamable-http hub）始终未加载（详见 issue #17）。
- 可行替代入口：`F:\magpie-windows-amd64.exe mcp image` 是 Magpie 自带的 **stdio** MCP server，暴露 3 个工具：

| 工具 | 用途 |
| --- | --- |
| `generate_image` | 文生图；传 `reference_images` 可做编辑/合成 |
| `generate_video` | 文生视频；传首帧图可做图生视频 |
| `generation_result` | 按 id 等待仍在生成的图片/视频 |

- 生图模型在 Magpie「设置 › 模型 › 生图模型」里选择；候选来自各 provider 声明的 `modalities.output` 含 `image` 的模型。本仓库 0.1.2 起声明了 `muse-image` / `muse-video`，因此下拉里才有 Muse Image 可选（PR #18）。

## 链路

```
DSH 会话
  └─ mcp__magpie-image__*        ← stdio: F:\magpie-windows-amd64.exe mcp image（bundle @dsh-local/magpie-image-mcp）
       └─ Magpie Image           ← 生图模型固定为 muse2api/muse-image
            └─ magpie-plugin-muse2api 工具（magpie-plugin-muse2api_generate_image …）
                 └─ muse2api 网关 http://127.0.0.1:18610（MUSE2API_KEY）
                      └─ muse.ai
```

## 前置条件

1. muse2api 网关在跑（不会自启）：
   ```powershell
   # 正确启动方式；python app.py 会因缺少 __main__ 入口静默退出
   Set-Location E:\github\muse2api
   Start-Process -WindowStyle Hidden -FilePath .\.venv\Scripts\python.exe `
     -ArgumentList '-m','uvicorn','app:app','--host','127.0.0.1','--port','18610'
   # 自检
   curl.exe -s http://127.0.0.1:18610/v1/models -H "Authorization: Bearer $env:MUSE2API_KEY"
   ```
2. Magpie 在跑，且插件已装 0.1.2+（含 `muse-image` / `muse-video` 声明）。
3. Magpie「设置 › 模型 › 生图模型」固定为 `Muse Image · muse2api`；「生图超时」建议 ≥10 分钟。
4. DSH 已安装本地 bundle `@dsh-local/magpie-image-mcp`（`E:\github\magpie-image-mcp-dsh`，patch 把 stdio server `magpie-image` 注册进 profile），并重启过 DSH。

## DSH 侧验收证据

> 环境：DeepSeek Harness host `0.2.2-rc.3`（`@deepseek-ai/dsh-*` 均为 0.2.2-rc.3），profile `C:\Users\Teddy\.dsh\profiles\desktop`，平台时间 Asia/Shanghai。执行日期 2026-11-21。

### 1. 工具出现 ✅

- [x] 新会话工具表出现 `mcp__magpie-image__generate_image` / `_generate_video` / `_generation_result`

补充说明（重要，供后来者避坑）：在 host `0.2.2-rc.3` 上，本 bundle 原来用 `cordis.patch.yml` insert `@deepseek-ai/dsh-mcp-client` 行的旧注册方式**不再生效**——新版把 MCP 收口到 `@deepseek-ai/dsh-mcp-manager`（设置驱动的 mcp-client 舰队），所有独立 `dsh-mcp-client` 行（含本 bundle 的 `mcp-magpie-image`，以及 ouroboros/aoci/windows/playwright/midas/wma 等）在 `plugin_manager list_plugins` 里都是 `enabled:false, fiberPhase:null`；`set_plugin` 手工启用返回 `application:"overridden"`（更高层覆盖）。

正确做法：把 server 登记进 mcp-manager 的 Settings（`~/.dsh/settings.yaml` 顶层，key = Loader row id `mcp-manager`）：

```yaml
mcp-manager:
  servers:
    magpie-image:
      transport: stdio
      command: 'F:\magpie-windows-amd64.exe'
      args: [mcp, image]
      toolCallTimeoutMs: 660000
```

重启 DSH 后 `mcp__magpie-image__*` 三工具即出现在会话工具表（本次已实测通过）。

### 2. 文生图 ✅

- [x] `generate_image` 出图，文件头 `RIFF....WEBP`

- 调用：`mcp__magpie-image__generate_image({ prompt: "a blue cat on a table, studio light", path: "E:\\ZzTmp\\mcp\\verify-out" })`（未指定 model，走 Magpie 设置默认 `muse2api/muse-image`）
- 工具返回：`Generated with muse2api/muse-image, saved to: E:\ZzTmp\mcp\verify-out\a-blue-cat-on-a-table-studio-light-20261121-071002.webp`
- 产物：`E:\ZzTmp\mcp\verify-out\a-blue-cat-on-a-table-studio-light-20261121-071002.webp`
- 字节数：21192
- 文件头 hex(0-15)：`52 49 46 46 c0 52 00 00 57 45 42 50 56 50 38 20` → 0-3 `RIFF`、8-11 `WEBP`（VP8）✅

### 3. 文生视频 ✅（修复后）

- [x] `generate_video` 工具端到端交付，产物文件头 `ftyp isom`

- 根因（issue #20）：Magpie core 在视频完成后固定 `GET /v1/videos/{task_id}/content` 拉取成品，不读 `result.url`；muse2api 网关缺该路由 → FastAPI 默认 404 `{"detail":"Not Found"}`。用假网关 harness 抓包证实（core 只发 `POST /v1/videos` 与 `GET /v1/videos/task_fake_1/content` 两个请求）。
- 修复：muse2api `app.py` 新增 `GET /v1/videos/{task_id}/content` 与 `GET /v1/videos/generations/{task_id}/content`（FileResponse 返回 mp4；task 不存在 404、未完成 400）。
- DSH 侧复测（修复后）：`mcp__magpie-image__generate_video({ prompt: "a gentle ocean wave rolling onto a beach, 4 seconds", seconds: 4, path: "E:\\ZzTmp\\mcp\\verify-out" })` → `generation_result(video-141008-3)` 返回 `Generated a video with muse2api/muse-video, saved to: E:\ZzTmp\mcp\verify-out\a-gentle-ocean-wave-rolling-onto-a-beach-20261121-114220.mp4`
- 产物：`E:\ZzTmp\mcp\verify-out\a-gentle-ocean-wave-rolling-onto-a-beach-20261121-114220.mp4`，5024265 字节
- 文件头 hex(0-15)：`00 00 00 20 66 74 79 70 69 73 6f 6d 00 00 02 00` → 4-11 `ftypisom` ✅
- 注：muse2api 网关不是 git 仓库，修复以 patch 形式记录在 issue #20。

## Magpie 侧准备过程记录（2026-11-20）

- 插件更新到 0.1.2（插件详情页「更新」按钮；安装目录 `C:\Users\Teddy\.config\magpie\plugins\node_modules\magpie-plugin-muse2api`）。
- 「生图模型」下拉从「自动 · 没有能生图的模型」变为「自动 · Muse Image · muse2api」→ 选中 `Muse Image · muse2api`。
- 「快速检测 › 生图模型 › 测试」通过：`muse2api/muse-image · 51 秒`。
