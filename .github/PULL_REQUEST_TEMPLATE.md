## 改了什么

<!-- 一两句话说明动机与结果 -->

## 怎么验证的

<!-- 贴命令与输出；两条必须跑绿 -->
- [ ] `bun test`
- [ ] `bun run test/smoke.mjs`

## 契约检查

- [ ] 工具的所有返回路径仍是 JSON（`ok` / `status` / `error`）
- [ ] 参考图上限只从 `server/config.mjs` 取，没有写死新数字
- [ ] 单个文件仍 ≤ 200 行（超出请拆分到 `server/tools/*.mjs`）
- [ ] 涉及行为变化时，`docs/spec.md` 与 `README.md` 已同步

## 关联

<!-- Closes #123 -->
