import { buildAuthHook, buildConfigHook, buildProviderHook } from "./provider.mjs"
import { buildTools } from "./tools.mjs"

function makeLog(input) {
  return (level, message) => {
    try {
      input?.client?.app?.log?.({ level, service: "muse2api", message })
    } catch {}
  }
}

export const Muse2ApiPlugin = async (input, options) => {
  const log = makeLog(input)
  const hooks = {
    config: buildConfigHook(),
    auth: buildAuthHook({ input, options, log }),
    provider: buildProviderHook({ input, options }),
  }

  try {
    hooks.tool = await buildTools({ input, options })
  } catch (e) {
    // 工具注册失败不应让整个插件加载失败（provider 仍可用）
    log("warn", `工具注册失败：${e?.message ?? e}`)
  }

  return hooks
}
