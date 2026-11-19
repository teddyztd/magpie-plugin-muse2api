import {
  DEFAULT_BASE,
  IMAGE_MODEL,
  MODEL_ID,
  PROVIDER_ID,
  PROVIDER_NAME,
  VIDEO_MODEL,
  apiBase,
  authHeaders,
  checkBaseUrl,
  modelsUrl,
  normalizeKey,
  resolveConfig,
  trimBase,
} from "./config.mjs"
import { buildBrowserLogin } from "./login/index.mjs"

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
    // muse-image / muse-video 是「生图模型」的候选：Magpie 的 设置 › 模型 › 生图模型
    // 只列出 output 里带 image / video 的模型，所以必须在这里声明，否则那边显示
    // 「自动 · 没有能生图的模型」。声明后 Magpie 会按 OpenAI 兼容协议把请求发到
    // {baseURL}/images/generations（图）与视频接口，正好是 muse2api 已经实现的路由。
    [IMAGE_MODEL]: {
      name: "Muse Image",
      reasoning: false,
      attachment: true,
      tool_call: false,
      modalities: { input: ["text", "image"], output: ["image"] },
      limit: { context: 32000, output: 8192 },
      cost: { input: 0, output: 0 },
    },
    [VIDEO_MODEL]: {
      name: "Muse Video",
      reasoning: false,
      attachment: true,
      tool_call: false,
      modalities: { input: ["text", "image"], output: ["video"] },
      limit: { context: 32000, output: 8192 },
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

// 登录卡片自己的图标（与 package.json 里的插件列表图标分开）：深色底 + 校验徽记。
export const AUTH_ICON =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCI+PHJlY3Qgd2lkdGg9IjY0IiBoZWlnaHQ9IjY0IiByeD0iMTQiIGZpbGw9IiMxMTE4MjciLz48Y2lyY2xlIGN4PSIzMiIgY3k9IjMyIiByPSIxNyIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMzhiZGY4IiBzdHJva2Utd2lkdGg9IjQiLz48cGF0aCBkPSJNMjQgMzNsNiA2IDExLTEyIiBmaWxsPSJub25lIiBzdHJva2U9IiNhN2YzZDAiIHN0cm9rZS13aWR0aD0iNSIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIi8+PC9zdmc+"

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

export function buildAuthHook({ input, options, log } = {}) {
  return {
    provider: PROVIDER_ID,
    maxConcurrency: 1,
    icon: AUTH_ICON,
    methods: [
      {
        type: "oauth",
        label: "muse.ai 网页登录（Cookie）",
        authorize: buildBrowserLogin({ input, options, log }),
      },
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
      const { key, baseUrl } = credentialOf(auth, { input, options })
      if (!key) return {}
      return { baseURL: apiBase(baseUrl), apiKey: key }
    },
  }
}

/**
 * api 方法把 key 放在 auth.key；oauth（网页登录）把它放在 access/refresh。
 * 两种方法之后都要能拿到同一把 muse2api key，所以这里统一取值。
 */
function credentialOf(auth, { input, options } = {}) {
  const configured = resolveConfig({ input, options })
  return {
    key: normalizeKey(auth?.key ?? auth?.access),
    baseUrl: trimBase(auth?.metadata?.baseUrl) || configured.baseUrl || DEFAULT_BASE,
  }
}

export function buildProviderHook({ input, options } = {}) {
  return {
    id: PROVIDER_ID,
    async models(provider, { auth } = {}) {
      const fallback = provider?.models ?? baseModels()
      const { key: apiKey, baseUrl } = credentialOf(auth, { input, options })
      if (!apiKey) return fallback
      let body
      try {
        const res = await fetch(modelsUrl(baseUrl), {
          headers: authHeaders(apiKey),
          signal: AbortSignal.timeout(8_000),
        })
        if (!res.ok) return fallback
        body = await res.json()
      } catch {
        return fallback
      }
      const list = Array.isArray(body?.data) ? body.data : []
      // 三个模型都参与：muse-spark 用来对话，muse-image / muse-video 让
      // Magpie 的「生图模型」能把它们列为候选。上游返回了名字就用上游的。
      const out = {}
      for (const m of list) {
        const base = fallback[m?.id]
        if (!base) continue
        out[m.id] = { ...base, id: m.id, name: m.name ?? base.name }
      }
      return Object.keys(out).length ? out : fallback
    },
  }
}
