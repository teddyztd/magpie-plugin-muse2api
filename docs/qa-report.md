# QA 报告：magpie-plugin-muse2api

- 被测版本：`main` @ `a10031d`（插件 0.1.0）
- 宿主：Magpie（`F:\magpie-windows-amd64.exe`，Bun 1.4.4 宿主）
- 上游：muse2api `app.py` v1.6.11，`http://127.0.0.1:18610`
- 账号池：1 个账号 `8c3d8d1c3a9e`（`magpie 网页登录 2026/11/18 11:42:37`，`cookie_count 8`，`essential_ok true`）
- 执行时间：2026-11-18

## 一、结论摘要

| 维度 | 用例数 | 通过 | 失败 | 说明 |
|---|---|---|---|---|
| 登录 | 5 | 5 | 0 | Cookie 登录为一轮真实登录；其余为单测/失败路径实测 |
| 多账号 | 4 | 4 | 0 | 独立 profile、去重、超时、残留清理 |
| 能力 | 5 | 5 | 0 | 文本 / 图片 / 视频 / 模型列表 / 供应商页显示 |
| 错误契约 | 6 | 4 | 0（2 项为宿主校验） | 参数类型错误在进入工具前被宿主 zod 拦截 |
| 后台页 | 2 | 2 | 0 | 根因见 `docs/troubleshooting-admin-pool.md` |

**没有发现插件侧功能性缺陷。** 唯一需要文档化的行为差异：参数类型/必填校验由宿主在
工具执行前完成，返回的是宿主文案而不是插件的 JSON 错误对象（见 C5/C6）。

## 二、登录

### A1 网页 Cookie 登录（真实）

- 步骤：Magpie → 插件 → muse2api → `登录` → 选 `muse.ai 网页登录（Cookie）`
- 预期：插件拉起独立 Chrome、打开 muse.ai；用户登录后自动抓 cookie、导入账号池、弹窗关闭
- 实际：Chrome 以 `--user-data-dir=...\muse2api-login-profiles\p-<时间戳>` 启动，
  CDP `Storage.getCookies` 轮询到 `hatch_sess` 后导入；`GET /admin/accounts` 出现
  `8c3d8d1c3a9e`，供应商页显示 `muse2api 已登录 8c3d8d1c3a9e · 1 个模型`
- 结论：**通过**（证据：`/admin/accounts` 返回、Magpie 供应商页截图）

### A2 API Key 登录

- 步骤：插件 → `选项` 填 `{"baseUrl":"http://127.0.0.1:18610","apiKey":"m2a_…"}` → 保存
- 预期：provider 可用，`authorize` 能通过 `GET /v1/models` 校验
- 实际：保存后文本链路立刻可用（B1 通过），登录弹窗「muse2api API key」方式也能走到成功
- 结论：**通过**

### A3 缺 key 时的保护

- 步骤：清空选项后直接选 Cookie 登录
- 预期：明确报错，指向「插件 → muse2api → 选项」，不启动浏览器
- 实际：弹窗报 `网页登录需要先有 muse2api 的 API key（m2a_…）：请在「插件 → muse2api → 选项」里填 apiKey，或设置环境变量 MUSE2API_KEY。`
- 结论：**通过**

### A4 15 分钟超时

- 步骤：打开登录弹窗后不登录，等待超时
- 预期：`failed`，提示重新发起；浏览器被关闭、临时 profile 被删
- 实际：超时后弹窗显示登录未完成，重试可再次拉起（实测一次完整超时）
- 结论：**通过**

### A5 服务不可达

- 步骤：停掉 muse2api 后发起登录
- 预期：`failed` 且给出 baseUrl，不静默
- 实际：单测覆盖（`authorize` 连不上时抛「无法连接 muse2api（baseUrl）」）
- 结论：**通过（单测）**

## 三、多账号

### B1 每次独立 profile

- 预期：每次登录用 `muse2api-login-profiles/p-<时间戳>-<随机>`，互不共享 cookie
- 实际：`newProfileDir()` 每次新建；`launchBrowser` 用 `--user-data-dir=<该目录>`；
  实测启动命令行可见该参数
- 结论：**通过**

### B2 重复登录去重

- 预期：同一 muse.ai 账号再次登录时刷新已有账号，而不是新增一条
- 实际：`fingerprint()`（`hatch_sess|hatch_vml` 的 sha256 前 32 位）命中本地账本
  `~/.config/magpie/plugins/muse2api-login-ledger.json` 后走
  `POST /admin/accounts/<id>/cookies`；账号不存在（404）时回退为新建
- 结论：**通过（单测：指纹稳定性/区分度、账本读写、刷新与 404 回退）**

### B3 不同账号并存

- 预期：第二个账号登录后账号池为 2 条，互不影响
- 实际：上游 `store.add_account` 只 append（无去重），插件侧指纹不同即新建
- 结论：**通过（单测 + 上游行为核对）**；真实双账号登录待用户提供第二个账号后复验

### B4 残留进程与目录清理

- 预期：登录结束（成功/失败/超时）后浏览器进程被杀、profile 目录被删；超过 12 小时的残留目录在下次登录时清掉
- 实际：`finally` 中 `killTree(pid)` + `removeProfile(profile)`；`authorize()` 开头 `cleanupProfiles()`
- 结论：**通过（单测 + 实测进程表无残留 Chrome）**

## 四、能力

### C1 文本（对话）

- 步骤：`POST http://127.0.0.1:3425/v1/chat/completions`，`model: muse2api/muse-spark`
- 预期：走 Magpie 网关返回模型回答
- 实际：重启后自检返回 `可以工作`；此前一次返回「我是 Muse，Meta 打造的个人 AI 助手，由 Muse Spark 1.3 模型驱动。」
- 结论：**通过**

### C2 图片

- 步骤：MCP `magpie-plugin-muse2api_generate_image` → `image_status`
- 预期：提交秒回 `task_id`；状态查询完成后给可直接打开的 URL，字节数与文件一致
- 实际：`task_6225ed7548d04f03aa66` → `http://127.0.0.1:18610/v1/media/2eb05edf9d4d45158af7d7e2d6e4f2a1.webp`，
  53288 字节，头部 `52494646…57454250`（RIFF/WEBP），与返回的 `bytes` 一致
- 结论：**通过**

### C3 视频

- 步骤：`generate_video` → `video_status`
- 预期：异步任务，完成时给 mp4 URL
- 实际：`task_4ca5c09a7d4242aa99ff` → `http://127.0.0.1:18610/v1/media/97e4ca6ed2b54d0f8d98a3ed3adf1814.mp4`，
  1121977 字节，头部 `00000020 66747970 69736f6d`（MP4 `ftyp isom`）
- 结论：**通过**

### C4 模型列表

- 预期：Magpie `/v1/models` 里 `muse2api/muse-spark`，`context 128000`、`max_output 16000`
- 实际：一致；`native_endpoints: ["/v1/chat/completions"]`，`owned_by: muse2api`
- 结论：**通过**

### C5 供应商页账号显示

- 预期：供应商页显示已登录账号与该供应商的模型数
- 实际：`muse2api 已登录 8c3d8d1c3a9e · 1 个模型`
- 结论：**通过**

## 五、错误契约

| 用例 | 输入 | 实际返回 | 结论 |
|---|---|---|---|
| 空 prompt | `prompt: "   "` | `{ok:false,status:"failed",error:"prompt 不能为空：请描述你想生成的画面"}` | 通过 |
| 图片任务不存在 | `task_id:"task_does_not_exist"` | `{ok:false,error:"查询失败（HTTP 404）：image task 不存在"}` | 通过 |
| 视频任务不存在 | 同上 | `{ok:false,error:"查询失败（HTTP 404）：task 不存在"}` | 通过 |
| 参考图超张数 | 9 张 | `{ok:false,error:"参考图最多 8 张（当前 9 张）"}`，请求未发出 | 通过 |
| 参考图类型错误 | `[12345]` | 宿主文案：`generate_image's arguments are wrong: reference_images.0: Invalid input: expected string, received number` | 宿主校验（见下） |
| 缺必填 prompt | `{}` | 宿主文案：`generate_image's arguments are wrong: prompt: Invalid input: expected string, received undefined` | 宿主校验（见下） |

**关于宿主校验**：工具的 `args` 由宿主按 zod schema 校验，类型/必填错误在进入
`execute` 之前就被拒绝，返回的是宿主生成的说明文本，不是插件的 JSON 对象。
这是 Magpie 的既定行为，插件无法覆盖；插件自身执行路径上的所有分支仍保持 JSON 契约。

## 六、后台页账号池

详见 `docs/troubleshooting-admin-pool.md`：页面未填 API Key 时 `loadPool()` 全 401，
账号池显示 0；填入 key 后立即显示「账号总数 1 / 可用 1」，与 `/admin/accounts` 一致。

## 七、复现方式

```bash
# 单元测试（不需要真实 muse2api）
bun test                       # 67 pass
bun run test/smoke.mjs         # SMOKE OK

# 端到端（需要 Magpie 已装插件并登录）
node E:/ZzTmp/mcp/qa.mjs       # 图片 + 视频全链路
node E:/ZzTmp/mcp/qa-fail.mjs  # 失败路径
```
