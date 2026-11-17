import { sleep } from "../config.mjs"

/**
 * 极简 CDP 客户端：只用到浏览器级 Storage.getCookies。
 * 走 Bun 自带的 WebSocket，不引第三方依赖。
 */
export class Cdp {
  #ws = null
  #seq = 0
  #pending = new Map()

  static async connect(wsUrl, timeoutMs = 15_000) {
    const cdp = new Cdp()
    await cdp.#open(wsUrl, timeoutMs)
    return cdp
  }

  #open(wsUrl, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`连不上浏览器调试端口：${wsUrl}`)), timeoutMs)
      let ws
      try {
        ws = new WebSocket(wsUrl)
      } catch (e) {
        clearTimeout(timer)
        reject(e)
        return
      }
      ws.addEventListener("open", () => {
        clearTimeout(timer)
        this.#ws = ws
        resolve()
      })
      ws.addEventListener("message", (event) => {
        let msg
        try {
          msg = JSON.parse(typeof event.data === "string" ? event.data : "")
        } catch {
          return
        }
        const pending = this.#pending.get(msg.id)
        if (!pending) return
        this.#pending.delete(msg.id)
        if (msg.error) pending.reject(new Error(msg.error.message ?? "CDP 调用失败"))
        else pending.resolve(msg.result)
      })
      ws.addEventListener("error", () => {
        clearTimeout(timer)
        reject(new Error(`浏览器调试端口握手失败：${wsUrl}`))
      })
      ws.addEventListener("close", () => {
        for (const [, p] of this.#pending) p.reject(new Error("浏览器已关闭"))
        this.#pending.clear()
      })
    })
  }

  send(method, params = {}, timeoutMs = 10_000) {
    const ws = this.#ws
    if (!ws || ws.readyState !== 1) return Promise.reject(new Error("浏览器调试会话已关闭"))
    const id = ++this.#seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`浏览器没有响应 ${method}`))
      }, timeoutMs)
      this.#pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      })
      try {
        ws.send(JSON.stringify({ id, method, params }))
      } catch (e) {
        clearTimeout(timer)
        this.#pending.delete(id)
        reject(e)
      }
    })
  }

  close() {
    try {
      this.#ws?.close()
    } catch {}
    this.#ws = null
  }
}

/** 轮询 /json/version，拿到浏览器级 WebSocket 地址。 */
export async function waitForCdp(port, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs
  let lastError = ""
  while (Date.now() < end) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(2_000),
      })
      if (res.ok) {
        const info = await res.json()
        if (info?.webSocketDebuggerUrl) return info.webSocketDebuggerUrl
        lastError = "浏览器没有给出调试地址"
      } else {
        lastError = `HTTP ${res.status}`
      }
    } catch (e) {
      lastError = e?.message ?? String(e)
    }
    await sleep(500)
  }
  throw new Error(`登录窗口没有开出调试端口（${lastError}）`)
}

export async function readCookies(cdp) {
  const result = await cdp.send("Storage.getCookies", {})
  return Array.isArray(result?.cookies) ? result.cookies : []
}
