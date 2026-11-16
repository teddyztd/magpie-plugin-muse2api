import { buildAuthHook, buildConfigHook, buildProviderHook } from "./provider.mjs"
import { buildTools } from "./tools.mjs"

export const Muse2ApiPlugin = async (input, options) => {
  const hooks = {
    config: buildConfigHook(),
    auth: buildAuthHook(),
    provider: buildProviderHook(),
  }

  try {
    hooks.tool = await buildTools({ input, options })
  } catch (e) {
    // 工具注册失败不应让整个插件加载失败（provider 仍可用）
    try {
      input?.client?.app?.log?.({
        level: "warn",
        service: "muse2api",
        message: `工具注册失败：${e?.message ?? e}`,
      })
    } catch {}
  }

  return hooks
}
