import {
  DEFAULT_BASE,
  MODEL_ID,
  PROVIDER_ID,
  PROVIDER_NAME,
  apiBase,
  authHeaders,
  checkBaseUrl,
  modelsUrl,
  normalizeKey,
  trimBase,
} from "./config.mjs"

function baseModels() {
  return {
    [MODEL_ID]: {
      name: "Muse Spark",
      reasoning: false,
      attachment: false,
      // muse2api 的 /v1/chat/completions 默认不注入 tools（上游无原生 function calling），
      // 声明支持只会让 agent 发出会被拒绝的 tools。
      tool_call: false,
      modalities: { input: ["text"], output: ["text"] },
      limit: { context: 128000, output: 16000 },
      cost: { input: 0, output: 0 },
    },
  }
}

export function buildConfigHook() {
  return async (cfg) => {
    cfg.provider ??= {}
    // 保留宿主/用户已有的同 id 配置，只补默认值，避免覆盖手改过的条目。
    const was = cfg.provider[PROVIDER_ID] ?? {}
    cfg.provider[PROVIDER_ID] = {
      ...was,
      name: was.name ?? PROVIDER_NAME,
      npm: was.npm ?? "@ai-sdk/openai-compatible",
      // 占位；loader 会用登录时填的 baseUrl 覆盖。
      api: was.api ?? apiBase(DEFAULT_BASE),
      models: { ...baseModels(), ...(was.models ?? {}) },
    }
  }
}

const prompts = [
  {
    type: "text",
    key: "baseUrl",
    message: "muse2api 地址（不含 /v1）",
    placeholder: "http://127.0.0.1:18610",
    validate: (v) => checkBaseUrl(v),
  },
  {
    type: "password",
    key: "apiKey",
    message: "MUSE2API_KEY",
    placeholder: "m2a_…",
  },
]

export function buildAuthHook() {
  return {
    provider: PROVIDER_ID,
    maxConcurrency: 1,
    methods: [
      {
        type: "api",
        label: "muse2api API key",
        placeholder: "m2a_…",
        prompts,
      },
    ],
    async authorize(inputs) {
      const baseUrl = trimBase(inputs?.baseUrl)
      const apiKey = normalizeKey(inputs?.apiKey ?? inputs?.key)
      if (!baseUrl) return { type: "failed", error: "请填写 muse2api 地址" }
      if (!apiKey) return { type: "failed", error: "请填写 MUSE2API_KEY" }
      let res
      try {
        res = await fetch(modelsUrl(baseUrl), {
          headers: authHeaders(apiKey),
          signal: AbortSignal.timeout(10_000),
        })
      } catch (e) {
        return {
          type: "failed",
          error: `无法连接 ${modelsUrl(baseUrl)}：${e?.message ?? e}`,
        }
      }
      if (res.status === 401 || res.status === 403) {
        return { type: "failed", error: `API key 无效（muse2api 返回 ${res.status}）` }
      }
      if (!res.ok) {
        return {
          type: "failed",
          error: `muse2api 返回 HTTP ${res.status}，确认地址指向 muse2api 且服务已启动`,
        }
      }
      return { type: "success", key: apiKey, metadata: { baseUrl } }
    },
    async loader(getAuth) {
      const auth = await getAuth()
      if (auth?.type !== "api") return {}
      const baseUrl = trimBase(auth.metadata?.baseUrl) || DEFAULT_BASE
      return { baseURL: apiBase(baseUrl), apiKey: auth.key }
    },
  }
}

export function buildProviderHook() {
  return {
    id: PROVIDER_ID,
    async models(provider, { auth } = {}) {
      const fallback = provider?.models ?? baseModels()
      if (auth?.type !== "api") return fallback
      const baseUrl = trimBase(auth.metadata?.baseUrl) || DEFAULT_BASE
      let body
      try {
        const res = await fetch(modelsUrl(baseUrl), {
          headers: authHeaders(auth.key),
          signal: AbortSignal.timeout(8_000),
        })
        if (!res.ok) return fallback
        body = await res.json()
      } catch {
        return fallback
      }
      const list = Array.isArray(body?.data) ? body.data : []
      const base = fallback[MODEL_ID]
      if (!base) return fallback
      // 只把可对话的 muse-spark 暴露为对话模型；muse-image / muse-video 走工具。
      const out = {}
      for (const m of list) {
        if (m?.id !== MODEL_ID) continue
        out[m.id] = { ...base, id: m.id, name: m.name ?? base.name }
      }
      return Object.keys(out).length ? out : fallback
    },
  }
}
