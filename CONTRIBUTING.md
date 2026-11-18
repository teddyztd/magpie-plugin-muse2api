# 贡献指南

本仓库是一个 Magpie 插件（`github:` 分发），目标是**只做封装**：把 muse2api 的能力接进
Magpie，不改变 muse2api 本身的语义。

## 环境

- Bun ≥ 1.3（宿主就是 Bun）
- Node ≥ 22（只在跑辅助脚本时需要）
- 一个可用的 muse2api 实例（本机 `http://127.0.0.1:18610` 或远端）

## 本地开发

```bash
bun install
bun test                # 单元测试，全部走本地 mock，不需要真实 muse2api
bun run test/smoke.mjs  # 端到端冒烟：起 mock 服务，跑四个工具的完整链路
```

联调真实实例：

```bash
# 1) 起 muse2api（示例）
cd ../muse2api && .venv/Scripts/python.exe -m uvicorn app:app --host 127.0.0.1 --port 18610

# 2) 在 Magpie 里安装本地目录
magpie plugin add ./            # 或 GUI：设置 → 插件 → 从本地目录安装
```

## 改动约定

- **返回契约**：四个工具在任何路径下都返回 JSON 字符串，`ok:false` 时至少带
  `status` 与 `error`。新增失败分支必须走 `server/tools/result.mjs` 的 `failJson`。
- **单一事实来源**：参考图张数/体积上限只在 `server/config.mjs` 定义，
  `server/tools/schema.mjs` 只负责把它们插进描述文案。
- **不猜上游**：muse2api 的字段以 `app.py` / `engine.py` 为准；不确定就先在
  `test/mock-muse2api.mjs` 里补一个形状，再改实现。
- **单个文件 ≤ 200 行**：超了就拆到 `server/tools/*.mjs`。

## 提交与 PR

1. 从 `main` 拉分支：`feat/xxx`、`fix/xxx`、`docs/xxx`。
2. 改完跑 `bun test` 与 `bun run test/smoke.mjs`，两者都必须绿。
3. PR 描述写清：改了什么、为什么、怎么验证的（贴命令与输出）。
4. CI（`.github/workflows/ci.yml`）会在 Linux/Windows 两个 runner 上跑测试。

## 发布

发布即“推 main”：Magpie 通过 GitHub API 比对提交，最长 10 分钟内自动更新。
正式版本另打 tag 并发 Release，Release 说明里写清能力范围与已知限制。

## 证书

MIT，见 [LICENSE](../LICENSE)。
