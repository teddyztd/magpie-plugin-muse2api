import { makeToolDefinitions } from "./definitions.mjs"
import { toJsonSchema, toZod } from "./schema.mjs"
import { loadSdk } from "./sdk.mjs"

export async function buildTools({ input, options } = {}) {
  const definitions = makeToolDefinitions({ input, options })
  const sdk = await loadSdk(input)
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
