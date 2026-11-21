// 本地 muse2api 网关的自动拉起与保活。
//
// 触发点有三个：
//   1. 插件加载时 start() —— 后台异步 ensure，不阻塞宿主；
//   2. authorize() / provider.models() 请求前 await ensure() —— 把"等网关起来"
//      藏进本来就要做的事里，用户点「重试」「重新获取模型」时自愈；
//   3. keepAlive 定时器 —— 端口连续失联则重启我们自己拉起的进程。
// 设计边界见 README「自动拉起与保活」：只管 loopback 地址；只杀自己 spawn 的进程。

import { spawn } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { trimBase } from "./config.mjs"

const IS_WINDOWS = process.platform === "win32"
const DEFAULT_GATEWAY_DIR = "E:\\github\\muse2api"
const DEFAULT_STARTUP_WAIT_MS = 60_000
const DEFAULT_HEALTH_INTERVAL_MS = 30_000
const DEFAULT_RESTART_BACKOFF_MS = 2_000
const MAX_RESTART_BACKOFF_MS = 300_000

/** options > magpie.option() > env > 默认。布尔宽容处理字符串 "true"/"1"（宿主表单常见）。 */
function pickBool(...vals) {
  for (const v of vals) {
    if (v === undefined || v === null || v === "") continue
    if (typeof v === "boolean") return v
    const s = String(v).trim().toLowerCase()
    if (s === "true" || s === "1" || s === "yes" || s === "on") return true
    if (s === "false" || s === "0" || s === "no" || s === "off") return false
  }
  return undefined
}

export function resolveGatewayConfig({ options, input, baseUrl } = {}) {
  const opt = options && typeof options === "object" ? options : {}
  const magpie = input?.magpie
  const optOf = (key) => {
    try {
      return magpie?.option?.(key)
    } catch {
      return undefined
    }
  }
  const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : "")

  let host = "127.0.0.1"
  let port = 18610
  try {
    const u = new URL(trimBase(baseUrl) || "http://127.0.0.1:18610")
    host = u.hostname
    if (u.port) port = Number(u.port)
  } catch {}

  const enabled = pickBool(opt.gatewayEnabled, opt.autoLaunch, optOf("gatewayEnabled"), optOf("autoLaunch"), process.env.MUSE2API_GATEWAY_AUTOLAUNCH) ?? true
  const keepAlive = pickBool(opt.gatewayKeepAlive, optOf("gatewayKeepAlive"), process.env.MUSE2API_GATEWAY_KEEPALIVE) ?? true
  const dir =
    str(opt.gatewayDir) ||
    str(optOf("gatewayDir")) ||
    str(process.env.MUSE2API_GATEWAY_DIR) ||
    DEFAULT_GATEWAY_DIR

  return {
    enabled: enabled !== false,
    keepAlive: keepAlive !== false,
    host,
    port,
    dir,
    startupWaitMs: Number(opt.gatewayStartupWaitMs || optOf("gatewayStartupWaitMs") || DEFAULT_STARTUP_WAIT_MS) || DEFAULT_STARTUP_WAIT_MS,
    healthIntervalMs: Number(opt.gatewayHealthIntervalMs || optOf("gatewayHealthIntervalMs") || DEFAULT_HEALTH_INTERVAL_MS) || DEFAULT_HEALTH_INTERVAL_MS,
  }
}

export function isLoopback(host) {
  const h = String(host ?? "").toLowerCase()
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h.startsWith("127.")
}

/** TCP 探针：端口能连上就算“有人在听”。不校验协议，健康判定交给上层 HTTP。 */
export function tcpOpen(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port })
    let settled = false
    const done = (v) => {
      if (settled) return
      settled = true
      sock.destroy()
      resolve(v)
    }
    sock.setTimeout(timeoutMs)
    sock.once("connect", () => done(true))
    sock.once("timeout", () => done(false))
    sock.once("error", () => done(false))
    sock.once("close", () => done(false))
  })
}

/** 依次探测候选解释器：显式配置 > venv > PATH。返回绝对路径或裸命令名。 */
export function findPython(dir, configured) {
  const cands = []
  if (configured) cands.push(configured)
  if (process.env.MUSE2API_PYTHON) cands.push(process.env.MUSE2API_PYTHON)
  if (dir) {
    cands.push(path.join(dir, IS_WINDOWS ? ".venv\\Scripts\\python.exe" : ".venv/bin/python"))
    cands.push(path.join(dir, IS_WINDOWS ? "venv\\Scripts\\python.exe" : "venv/bin/python"))
  }
  cands.push(...(IS_WINDOWS ? ["python", "py"] : ["python3", "python"]))
  for (const c of cands) {
    if (!c) continue
    // 绝对/相对路径必须存在；裸命令名交给 PATH。
    if (c.includes("/") || c.includes("\\")) {
      try {
        if (fs.existsSync(c)) return c
      } catch {}
      continue
    }
    return c
  }
  return null
}

/**
 * 网关守护单例工厂。宿主重复加载时以 dir+host:port 为键复用，
 * 保证同一网关只有一份定时器与一份被跟踪的进程句柄。
 * 对外是门面：每次调用按当次 baseUrl 选/建对应 keeper，
 * 这样用户把 baseUrl 改到别的端口时不会盯着旧端口干活。
 */
const keepers = new Map()

function keeperFor({ input, options, log, baseUrl }) {
  const cfg = resolveGatewayConfig({ options, input, baseUrl })
  const key = `${cfg.dir}|${cfg.host}:${cfg.port}`
  let keeper = keepers.get(key)
  if (!keeper) {
    keeper = createKeeper({ cfg, key, options, log })
    keepers.set(key, keeper)
  }
  return keeper
}

export function createGatewayKeeper({ input, options, log = () => {} } = {}) {
  return {
    ensure: (baseUrl, apiKey, opts) => keeperFor({ input, options, log, baseUrl }).ensure(baseUrl, apiKey, opts),
    start: (baseUrl) => keeperFor({ input, options, log, baseUrl }).start(),
    stop() {
      for (const k of keepers.values()) k.stop()
      keepers.clear()
    },
    status: () => [...keepers.values()].map((k) => k.status()),
  }
}

function createKeeper({ cfg, key, options, log }) {
  let proc = null // 只跟踪我们自己 spawn 的进程
  let restarts = 0
  let misses = 0
  let timer = null
  let pending = null // ensure 单飞：并发请求共享同一次启动

  const file = path.join(cfg.dir, "data", "logs", "gateway-keepalive.log")
  const append = (line) => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`)
    } catch {}
    log("info", `[gateway] ${line}`)
  }

  async function ready() {
    return tcpOpen(cfg.host, cfg.port)
  }

  function spawnGateway() {
    if (!cfg.dir || !fs.existsSync(cfg.dir)) {
      throw new Error(`找不到 muse2api 目录：${cfg.dir}（可在插件选项 gatewayDir 里改）`)
    }
    const python = findPython(cfg.dir, options?.gatewayPython ?? undefined)
    if (!python) throw new Error("没有找到可用的 Python（可选项 gatewayPython 指定解释器路径）")
    let fd
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fd = fs.openSync(file, "a")
    } catch {
      fd = "ignore"
    }
    const args = ["-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", String(cfg.port)]
    append(`starting: ${python} ${args.join(" ")} (cwd=${cfg.dir})`)
    proc = spawn(python, args, {
      cwd: cfg.dir,
      detached: true,
      stdio: ["ignore", fd, fd],
      windowsHide: true,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    })
    proc.on("exit", (code, signal) => {
      append(`gateway exited code=${code} signal=${signal}`)
      proc = null
    })
    // detached + stdio ignore 已经让它独立于宿主生命周期，这里再解除
    // ChildProcess 句柄对事件循环的引用，宿主退出时不会被钉住。
    if (typeof proc.unref === "function") proc.unref()
    append(`spawned pid=${proc.pid}`)
    return proc.pid
  }

  async function waitForReady(waitMs) {
    const deadline = Date.now() + waitMs
    while (Date.now() < deadline) {
      if (await ready()) return true
      await new Promise((r) => setTimeout(r, 400))
    }
    return false
  }

  function killOwned() {
    if (!proc?.pid) return
    const pid = proc.pid
    try {
      if (IS_WINDOWS) spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore", windowsHide: true })
      else proc.kill("SIGKILL")
      append(`killed owned pid=${pid}`)
    } catch (e) {
      append(`kill failed pid=${pid}: ${e?.message ?? e}`)
    }
    proc = null
  }

  /** 幂等：端口已被占用（无论是谁起的）直接返回 up。 */
  async function ensure(baseUrlArg, _apiKey, { waitMs = cfg.startupWaitMs } = {}) {
    const host = cfg.host
    const port = cfg.port
    if (!cfg.enabled) return { state: "disabled" }
    if (!isLoopback(host)) return { state: "remote", host, port }
    if (await ready()) {
      misses = 0
      return { state: "up", host, port }
    }
    if (pending) return pending
    pending = (async () => {
      try {
        spawnGateway()
        const ok = await waitForReady(waitMs)
        if (!ok) {
          const tail = (() => {
            try {
              return fs.readFileSync(file, "utf8").split("\n").slice(-12).join("\n")
            } catch {
              return ""
            }
          })()
          append(`startup timeout after ${waitMs}ms`)
          throw new Error(
            `已尝试在 ${port} 自动拉起 muse2api，但 ${Math.round(waitMs / 1000)}s 内没有就绪。检查日志：${file}${tail ? `\n--- 最后几行 ---\n${tail}` : ""}`,
          )
        }
        restarts = 0
        misses = 0
        append(`ready on ${host}:${port}`)
        return { state: "started", host, port }
      } finally {
        pending = null
      }
    })()
    return pending
  }

  function startHealthLoop() {
    if (timer || !cfg.enabled || !cfg.keepAlive || !isLoopback(cfg.host)) return
    timer = setInterval(async () => {
      if (pending) return
      if (await ready()) {
        misses = 0
        return
      }
      misses += 1
      if (misses < 2) return
      const delay = Math.min(MAX_RESTART_BACKOFF_MS, DEFAULT_RESTART_BACKOFF_MS * 2 ** restarts)
      append(`port ${cfg.port} down (${misses} misses), restart in ${delay}ms`)
      misses = 0
      await new Promise((r) => setTimeout(r, delay))
      if (await ready()) return // 别人（或迟到进程）已经把它带回来了
      killOwned()
      restarts += 1
      try {
        await ensure(null, null, { waitMs: cfg.startupWaitMs })
        append(`restart succeeded (attempt ${restarts})`)
        restarts = 0
      } catch (e) {
        append(`restart failed (attempt ${restarts}): ${e?.message ?? e}`)
      }
    }, cfg.healthIntervalMs)
    // 定时器不应把宿主进程钉住
    if (typeof timer?.unref === "function") timer.unref()
  }

  function stop() {
    if (timer) clearInterval(timer)
    timer = null
    if (proc) killOwned()
  }

  const keeper = {
    config: cfg,
    ensure,
    start() {
      startHealthLoop()
      // 后台预热：不 await，失败留给 ensure / health 循环重试，绝不打断插件加载。
      ensure().catch((e) => append(`background ensure failed: ${e?.message ?? e}`))
    },
    stop,
    status() {
      return { key, pid: proc?.pid ?? null, restarts, misses, tracked: keepers.size }
    },
  }
  return keeper
}
