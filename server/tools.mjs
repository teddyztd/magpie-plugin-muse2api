// 稳定入口：index.mjs 与测试都从这里取；具体实现按职责放在 tools/ 下。
export { buildTools } from "./tools/build.mjs"
export { makeToolDefinitions } from "./tools/definitions.mjs"

import { normalizeRefs } from "./tools/refs.mjs"
import { toJsonSchema } from "./tools/schema.mjs"

// 仅供测试使用的内部缝隙：只放测试真正调用的两个纯函数。
// 返回契约、轮询流程等都已由工具本体覆盖，不需要在这里再暴露一遍。
export const _internal = {
  normalizeRefs,
  toJsonSchema,
}
