export const PROVIDER_ID = "muse2api"
export const PROVIDER_NAME = "muse2api"
export const MODEL_ID = "muse-spark"
export const DEFAULT_BASE = "http://127.0.0.1:18610"
export const IMAGE_MODEL = "muse-image"
export const VIDEO_MODEL = "muse-video"
export const MAX_REFERENCE_IMAGES = 8

/**
 * 统一地址：去空白、去尾斜杠、去用户多写的 /v1（插件自己会拼 /v1）。
 */
export function trimBase(url) {
  return String(url ?? "")
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/v1$/i, "")
}

/** 规约后的地址 + /v1：登录、加载器、provider.models 与工具都从这里拼。 */
export function apiBase(url) {
  return `${trimBase(url)}/v1`
}

export function modelsUrl(url) {
  return `${apiBase(url)}/models`
}

/** 用户填的地址是否可用；返回错误文案或 undefined。登录表单与 authorize 共用。 */
export function checkBaseUrl(value) {
  const raw = String(value ?? "").trim()
  let u
  try {
    u = new URL(raw)
  } catch {
    return "不是合法 URL"
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return "需要 http:// 或 https:// 开头"
  }
  if (/\/v1\/?$/i.test(u.pathname)) return "地址不要带 /v1（插件会自动补）"
  return undefined
}

/** 去掉用户粘贴时带上的 Bearer 前缀。 */
export function normalizeKey(value) {
  return String(value ?? "")
    .trim()
    .replace(/^Bearer\s+/i, "")
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"))
    let timer
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason ?? new Error("aborted"))
    }
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal?.addEventListener("abort", onAbort, { once: true })
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
    "请在 Magpie「插件 → 已安装 → muse2api → 选项」里填 baseUrl 与 apiKey（也支持环境变量 MUSE2API_BASE_URL / MUSE2API_KEY）。",
    "baseUrl 例：http://127.0.0.1:18610（不要带 /v1）",
  ].join("\n")
}

export function authHeaders(apiKey) {
  return { authorization: `Bearer ${normalizeKey(apiKey)}`, "content-type": "application/json" }
}

export async function requestJson(url, init, ctx, timeoutMs = 50_000) {
  const timeout = AbortSignal.timeout(Math.max(1_000, Number(timeoutMs) || 50_000))
  const signal = ctx?.abort ? AbortSignal.any([ctx.abort, timeout]) : timeout
  let res
  try {
    res = await fetch(url, { ...init, signal })
  } catch (e) {
    const name = e?.name
    const msg =
      name === "TimeoutError"
        ? `请求超时（${Math.round((Number(timeoutMs) || 50_000) / 1000)}s）`
        : name === "AbortError"
          ? "请求被取消"
          : (e?.message ?? String(e))
    return { ok: false, status: 0, body: null, text: "", error: msg }
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
  if (typeof r?.error === "string" && r.error) return r.error
  const bodyError = r?.body?.error
  const fromBody =
    typeof bodyError === "string" ? bodyError : (bodyError?.message ?? bodyError?.code)
  return (
    (typeof fromBody === "string" && fromBody) ||
    r?.body?.detail ||
    r?.body?.message ||
    (r?.text ? r.text.slice(0, 500) : "") ||
    `HTTP ${r?.status}`
  )
}
