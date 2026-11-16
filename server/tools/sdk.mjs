/** 优先从宿主依赖解析 SDK；失败再试 magpie 配置目录下的 plugins/node_modules。 */
export async function loadSdk(input) {
  try {
    return await import("@opencode-ai/plugin")
  } catch {
    // 继续尝试宿主绝对路径
  }
  const dir = typeof input?.directory === "string" ? input.directory : ""
  if (!dir) return null
  try {
    const { pathToFileURL } = await import("node:url")
    const { join } = await import("node:path")
    const entry = join(dir, "plugins", "node_modules", "@opencode-ai", "plugin", "dist", "index.js")
    return await import(pathToFileURL(entry).href)
  } catch {
    return null
  }
}
