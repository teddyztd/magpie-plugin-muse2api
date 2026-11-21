import { buildAuthHook, buildConfigHook, buildProviderHook } from "./provider.mjs"
import { buildTools } from "./tools.mjs"
import { createGatewayKeeper } from "./gateway.mjs"

function makeLog(input) {
  return (level, message) => {
    try {
      input?.client?.app?.log?.({ level, service: "muse2api", message })
    } catch {}
  }
}

export const Muse2ApiPlugin = async (input, options) => {
  const log = makeLog(input)

  // 本地网关守护：插件一加载就后台预热（不阻塞宿主），并且之后每次
  // authorize / models 前都会再 ensure 一次。配置项见 gateway.mjs 的 resolveGatewayConfig。
  let gateway = null
  try {
    gateway = createGatewayKeeper({ input, options, log })
    gateway.start()
  } catch (e) {
    log("warn", `网关守护初始化失败：${e?.message ?? e}`)
  }

  const hooks = {
    config: buildConfigHook(),
    auth: buildAuthHook({ input, options, log, gateway }),
    provider: buildProviderHook({ input, options, gateway }),
  }

  try {
    hooks.tool = await buildTools({ input, options })
  } catch (e) {
    // 工具注册失败不应让整个插件加载失败（provider 仍可用）
    log("warn", `工具注册失败：${e?.message ?? e}`)
  }

  return hooks
}
