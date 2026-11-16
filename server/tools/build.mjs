import { makeToolDefinitions } from "./definitions.mjs"
import { toJsonSchema, toZod } from "./schema.mjs"
import { loadSdk } from "./sdk.mjs"

export async function buildTools({ input, options, sdk: sdkOverride } = {}) {
  const definitions = makeToolDefinitions({ input, options })
  // sdkOverride 传 null 表示「确定没有 SDK」，测试用它固定走 JSON Schema 分支。
  const sdk = sdkOverride !== undefined ? sdkOverride : await loadSdk(input)
  const toolFn = sdk?.tool
  const schema = sdk?.tool?.schema

  const out = {}
  for (const [name, def] of Object.entries(definitions)) {
    if (typeof toolFn === "function" && schema) {
      out[name] = toolFn({
        description: def.description,
        args: toZod(def.argsSpec, schema),
        execute: def.execute,
      })
    } else {
      // 宿主没提供 SDK 时退回 JSON Schema（文档允许）；工具仍可用。
      out[name] = {
        description: def.description,
        args: toJsonSchema(def.argsSpec),
        execute: def.execute,
      }
    }
  }
  return out
}
