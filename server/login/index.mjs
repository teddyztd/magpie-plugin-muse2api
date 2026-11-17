import {
  DEFAULT_BASE,
  authHeaders,
  modelsUrl,
  pickError,
  resolveConfig,
  sleep,
  trimBase,
} from "../config.mjs"
import { findBrowser, freePort, killTree, launchBrowser } from "./browser.mjs"
import { Cdp, readCookies, waitForCdp } from "./cdp.mjs"

/** muse2api 判定「账号可用」的核心 cookie（store.py / engine.py 同名常量）。 */
export const ESSENTIAL_COOKIES = ["hatch_sess"]
export const LOGIN_URL = "https://muse.ai/"
export const LOGIN_LIMIT_MS = 15 * 60 * 1000

const POLL_MS = 1500
const MUSE_DOMAINS = ["muse.ai", "www.muse.ai"]

export function isMuseCookie(cookie) {
  const domain = String(cookie?.domain ?? "").replace(/^\./, "").toLowerCase()
  return MUSE_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))
}

/** 只留 muse.ai 的 cookie；CDP 还会带回一堆浏览器内部 cookie。 */
export function pickMuseCookies(all) {
  return (Array.isArray(all) ? all : []).filter(
    (c) => isMuseCookie(c) && typeof c?.name === "string" && c.name && typeof c.value === "string",
  )
}

export function missingEssentials(cookies) {
  const names = new Set((cookies ?? []).map((c) => c.name))
  return ESSENTIAL_COOKIES.filter((name) => !names.has(name))
}

export function toCookieMap(cookies) {
  const map = {}
  for (const c of cookies ?? []) map[c.name] = c.value
  return map
}

/** 导入到 muse2api 的账号池；成功返回账号 id，失败返回可操作文案。 */
export async function importAccount({ baseUrl, apiKey, cookies, label }) {
  const endpoint = `${trimBase(baseUrl)}/admin/accounts`
  let res
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ label, cookies: toCookieMap(cookies) }),
      signal: AbortSignal.timeout(20_000),
    })
  } catch (e) {
    return { ok: false, error: `连不上 ${endpoint}：${e?.message ?? e}` }
  }
  const text = await res.text().catch(() => "")
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = null
  }
  if (!res.ok) return { ok: false, error: pickError({ status: res.status, body, text }) }
  const added = Array.isArray(body?.added) ? body.added : []
  if (!added.length) return { ok: false, error: "muse2api 没有导入任何账号（cookie 为空）" }
  const first = added[0]
  return {
    ok: true,
    id: first.id,
    label: first.label,
    cookieCount: first.cookie_count,
    essentialMissing: Array.isArray(body?.essential_missing) ? body.essential_missing : [],
    warning: typeof body?.warning === "string" ? body.warning : "",
  }
}

/** 登录进度页：Magpie 会在系统浏览器里打开它；只用内联资源，2 秒自刷新。 */
export function startProgressPage() {
  let state = { title: "正在等待 muse.ai 登录", detail: "请在弹出的浏览器窗口里登录 muse.ai。" }
  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Response(progressHtml(state), {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      })
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}/`,
    set(next) {
      state = { ...state, ...next }
    },
    stop() {
      try {
        server.stop(true)
      } catch {}
    },
  }
}

function progressHtml({ title, detail }) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="refresh" content="2">
<title>muse2api 登录</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:#0b1220;color:#e6edf7;font:16px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
  .card{max-width:520px;padding:32px 36px;border:1px solid #1f2a44;border-radius:16px;background:#111a2e}
  h1{margin:0 0 12px;font-size:20px}
  p{margin:0;color:#9fb0c9}
  .dot{display:inline-block;width:10px;height:10px;margin-right:8px;border-radius:50%;background:#38bdf8;
    animation:pulse 1.4s ease-in-out infinite}
  @keyframes pulse{0%,100%{opacity:.35}50%{opacity:1}}
</style></head><body><div class="card">
<h1><span class="dot"></span>${escapeHtml(title)}</h1>
<p>${escapeHtml(detail)}</p>
</div></body></html>`
}

function escapeHtml(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])
}

/**
 * Magpie 的 oauth 登录方法：authorize 返回进度页地址，callback 里开浏览器抓 cookie、
 * 导入 muse2api、再用当前 key 收口。账号池在 muse2api 侧，所以成功凭据仍是那把 key。
 */
export function buildBrowserLogin({ input, options, log } = {}) {
  return async function authorize() {
    const cfg = resolveConfig({ input, options })
    const baseUrl = cfg.baseUrl || DEFAULT_BASE
    if (!cfg.apiKey) {
      throw new Error(
        "网页登录需要先有 muse2api 的 API key（m2a_…）：请在「插件 → muse2api → 选项」里填 apiKey，或设置环境变量 MUSE2API_KEY。",
      )
    }
    let res
    try {
      res = await fetch(modelsUrl(baseUrl), {
        headers: authHeaders(cfg.apiKey),
        signal: AbortSignal.timeout(10_000),
      })
    } catch (e) {
      throw new Error(`连不上 ${modelsUrl(baseUrl)}：${e?.message ?? e}（先在 18610 启动 muse2api）`)
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(`插件选项里的 API key 不对（muse2api 返回 ${res.status}）`)
    }
    if (!res.ok) throw new Error(`muse2api 返回 HTTP ${res.status}，确认地址指向 muse2api`)

    const browser = findBrowser()
    if (!browser) {
      throw new Error("没有找到 Chrome / Edge / Chromium / Brave，登录窗口需要其中之一。")
    }

    const progress = startProgressPage()
    const cdpPort = freePort()

    return {
      url: progress.url,
      instructions:
        "插件会另开一个浏览器窗口打开 muse.ai，请在那里照常登录；登录成功后窗口会自动关闭，cookie 会自动导入 muse2api。",
      method: "auto",
      // 供测试与调试收口（Magpie 会忽略未知字段）。
      progress,
      async callback() {
        let cdp = null
        let pid = 0
        try {
          pid = launchBrowser({ browser, cdpPort, url: LOGIN_URL })
          const wsUrl = await waitForCdp(cdpPort)
          cdp = await Cdp.connect(wsUrl)
          progress.set({ title: "已打开登录窗口", detail: "请在 muse.ai 页面完成登录，这里会自动检测。" })

          const end = Date.now() + LOGIN_LIMIT_MS
          let cookies = []
          while (Date.now() < end) {
            cookies = pickMuseCookies(await readCookies(cdp))
            const missing = missingEssentials(cookies)
            if (!missing.length) break
            progress.set({
              title: "等待登录完成",
              detail: `已抓到 ${cookies.length} 个 muse.ai cookie，还缺 ${missing.join("、")}。请在浏览器窗口里登录。`,
            })
            await sleep(POLL_MS)
          }
          const missing = missingEssentials(cookies)
          if (missing.length) {
            return {
              type: "failed",
              error: `muse.ai 登录没有在 ${Math.round(LOGIN_LIMIT_MS / 60000)} 分钟内完成（缺 ${missing.join("、")}）`,
            }
          }

          progress.set({ title: "正在导入 muse2api", detail: "已拿到 muse.ai 会话，正在写入账号池。" })
          const label = `magpie 网页登录 ${new Date().toLocaleString("zh-CN")}`
          const imported = await importAccount({ baseUrl, apiKey: cfg.apiKey, cookies, label })
          if (!imported.ok) {
            log?.("warn", `导入账号失败：${imported.error}`)
            return { type: "failed", error: `muse2api 导入账号失败：${imported.error}` }
          }
          progress.set({ title: "登录成功", detail: `已导入账号 ${imported.id}（${imported.cookieCount} 个 cookie），可以关闭这个页面。` })
          return {
            type: "success",
            access: cfg.apiKey,
            refresh: cfg.apiKey,
            // muse2api 的 key 本身不过期；给一个远期值，避免 Magpie 反复要求续期。
            expires: Date.now() + 365 * 86_400_000,
            accountId: imported.id,
            metadata: { baseUrl: trimBase(baseUrl) },
          }
        } catch (e) {
          return { type: "failed", error: `muse.ai 登录失败：${e?.message ?? e}` }
        } finally {
          try {
            cdp?.close()
          } catch {}
          killTree(pid)
          progress.stop()
        }
      },
    }
  }
}
