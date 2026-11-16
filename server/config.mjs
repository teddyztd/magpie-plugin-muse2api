export const PROVIDER_ID = "muse2api"
export const PROVIDER_NAME = "muse2api"
export const MODEL_ID = "muse-spark"
export const DEFAULT_BASE = "http://127.0.0.1:18610"
export const IMAGE_MODEL = "muse-image"
export const VIDEO_MODEL = "muse-video"

export function trimBase(url) {
  return String(url ?? "").trim().replace(/\/+$/, "")
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"))
    const t = setTimeout(resolve, ms)
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t)
        reject(signal.reason ?? new Error("aborted"))
      },
      { once: true },
    )
  })
}

export function resolveConfig({ options, input } = {}) {
  const opt = options && typeof options === "object" ? options : {}
  const magpie = input?.magpie
  const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : "")

  let fromMagpie = { baseUrl: "", apiKey: "" }
  try {
    fromMagpie = {
      baseUrl: str(magpie?.option?.("baseUrl")),
      apiKey: str(magpie?.option?.("apiKey")),
    }
  } catch {
    // magpie 未提供 option()（OpenCode 或旧宿主）时忽略
  }

  return {
    baseUrl: trimBase(
      str(opt.baseUrl) || fromMagpie.baseUrl || str(process.env.MUSE2API_BASE_URL),
    ),
    apiKey: str(opt.apiKey) || fromMagpie.apiKey || str(process.env.MUSE2API_KEY),
  }
}

export function missingConfigText() {
  return [
    "没有配置 muse2api 连接信息。",
    "请在 Magpie「设置 → 插件 → muse2api」填写 baseUrl 与 apiKey（也支持环境变量 MUSE2API_BASE_URL / MUSE2API_KEY）。",
    "baseUrl 例：http://127.0.0.1:18610",
  ].join("\n")
}

export function authHeaders(apiKey) {
  return { authorization: `Bearer ${apiKey}`, "content-type": "application/json" }
}

export async function requestJson(url, init, ctx) {
  const timeout = AbortSignal.timeout(50_000)
  const signal = ctx?.abort ? AbortSignal.any([ctx.abort, timeout]) : timeout
  let res
  try {
    res = await fetch(url, { ...init, signal })
  } catch (e) {
    return { ok: false, status: 0, body: null, text: "", error: e?.message ?? String(e) }
  }
  const text = await res.text().catch(() => "")
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = null
  }
  return { ok: res.ok, status: res.status, body, text }
}

export function pickError(r) {
  return r?.body?.error?.message || r?.body?.error || r?.body?.detail || r?.text?.slice(0, 500) || `HTTP ${r?.status}`
}
