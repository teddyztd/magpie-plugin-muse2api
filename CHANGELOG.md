# 更新日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循语义化版本。

## [0.2.0] - 2026-11-22

### 新增

- **网关自动拉起与保活**（`server/gateway.mjs`）：插件加载时后台自动拉起本机 muse2api 实例，
  每 30 秒健康检查，连续 2 次失败自动重启（指数退避，上限 5 分钟）。
  登录校验、模型列表刷新、网页登录前也会先确保网关在跑。
- 新插件选项：`gatewayEnabled` / `gatewayKeepAlive` / `gatewayDir` / `gatewayPython`；
  环境变量 `MUSE2API_GATEWAY_AUTOLAUNCH` / `MUSE2API_GATEWAY_KEEPALIVE` / `MUSE2API_GATEWAY_DIR` / `MUSE2API_PYTHON`。
- 拉起失败时登录报错附带网关日志末尾（`data/logs/gateway-keepalive.log`）。

### 说明

- 只作用于本机实例（`127.0.0.1` / `localhost` / `::1`），远端 `baseUrl` 不受影响。
- 只杀自己拉起的进程，不动手动起的 uvicorn。
- 验收：`E:\ZzTmp\mcp\gateway-harness.mjs` 7 步全绿（自动拉起 → 模型列表 → 模拟崩溃 → 自动恢复）。

## [0.1.2] - 2026-11-20

### 新增

- `provider.models` 现在声明 `muse-image` 与 `muse-video`，`modalities.output` 分别为 `image` / `video`。
  这是 Magpie「设置 › 模型 › 生图模型」的候选来源：不声明时该处只显示「自动 · 没有能生图的模型」，
  Magpie Image（`magpie mcp image`）也就没有模型可画。

### 说明

- 只增加模型声明，工具（`generate_image` / `image_status` / `generate_video` / `video_status`）契约不变。
- 上游 `/v1/models` 不可达时仍回退到静态列表，现在静态列表同样含三个模型。
## [0.1.1] - 2026-11-19

### 新增

- 第二账号端到端回归证据：独立 Chrome profile 登录 → 新账号入库 → 供应商弹窗双账号 → 文本 / 图片 / 视频全链路（`docs/qa-report.md` 第八节 D1–D7）。
- 故障排查条目：机器重启后 Magpie 报「连不上」，根因是 muse2api 不会自启。

### 变更

- `README.md` 前置条件写明启动命令 `python -m uvicorn app:app --host 127.0.0.1 --port 18610`，并说明 `python app.py` 因缺少 `__main__` 入口会静默退出。

### 说明

- 本版本不含功能改动，插件对外契约（provider + 4 个工具）与 0.1.0 一致。

## [0.1.0] - 2026-11-18

### 新增

- 供应商插件：`muse2api` provider，模型 `muse-spark`（上下文 128000 / 输出 16000），走 `/v1/chat/completions`。
- 登录方式：`muse.ai 网页登录（Cookie）` —— 插件拉起独立 Chrome profile 完成登录，抓取 `hatch_sess` 后导入 muse2api 账号池；另保留 `muse2api API key` 方式。
- 多账号：每次登录使用独立 profile（互不串号），成功自动关窗；重复登录同一 Muse 账号按 handle 去重；15 分钟未完成记为登录未完成并清理残留进程。
- 工具：`generate_image` / `image_status` / `generate_video` / `video_status`，全部返回统一 JSON 契约（`ok`、`task_id`、`status`、`url`、`hint` 等）。
- 图片与视频统一异步：提交即返回 `task_id`，用 `*_status` 单次查询取结果，避免超出 Magpie 单工具 55 秒上限。
- 参考图支持：最多 8 张、单张 40 MiB、合计 100 MiB，本地文件按原始字节上传。
- 文档与工程：`docs/spec.md`、`docs/qa-report.md`、`docs/troubleshooting-admin-pool.md`、`CONTRIBUTING.md`、issue/PR 模板、GitHub Actions（ubuntu + windows 跑 `bun test`、smoke、入口自检）。

### 修复

- 后台账号池页面看不到账号：根因与修复记录见 `docs/troubleshooting-admin-pool.md`。
- 网关 `401` 时登录态过期提示、`baseUrl` 带 `/v1` 尾巴、`video_status` 轮询超时等若干问题。
