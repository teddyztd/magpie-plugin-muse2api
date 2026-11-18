import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs"
import { spawn } from "node:child_process"
import { homedir, platform } from "node:os"
import { join } from "node:path"

/**
 * 登录窗口只认「能用 CDP 控制」的 Chromium 系浏览器；Firefox 不提供 CDP，不在候选里。
 * 顺序：Chrome → Edge → Chromium → Brave。
 */
const CANDIDATES = {
  win32: [
    "PROGRAMFILES/Google/Chrome/Application/chrome.exe",
    "PROGRAMFILES(X86)/Google/Chrome/Application/chrome.exe",
    "LOCALAPPDATA/Google/Chrome/Application/chrome.exe",
    "PROGRAMFILES/Microsoft/Edge/Application/msedge.exe",
    "PROGRAMFILES(X86)/Microsoft/Edge/Application/msedge.exe",
    "PROGRAMFILES/Chromium/Application/chrome.exe",
    "PROGRAMFILES/BraveSoftware/Brave-Browser/Application/brave.exe",
  ],
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  ],
  linux: ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"],
}

function expand(p) {
  return p.replace(/PROGRAMFILES\(X86\)/g, process.env["ProgramFiles(x86)"] ?? "")
    .replace(/PROGRAMFILES/g, process.env.ProgramFiles ?? "")
    .replace(/LOCALAPPDATA/g, process.env.LOCALAPPDATA ?? "")
}

/** 返回可执行的浏览器路径；找不到时返回 null（调用方给出可操作的错误）。 */
export function findBrowser() {
  const os = platform()
  const list = CANDIDATES[os] ?? []
  for (const item of list) {
    if (os === "linux") {
      const found = Bun.which(item)
      if (found) return found
      continue
    }
    const p = expand(item)
    if (p && existsSync(p)) return p
  }
  return null
}

/** 每次登录一个独立 profile 的父目录：多个账号之间不共享 cookie / 会话。 */
export function profileRoot() {
  return join(homedir(), ".config", "magpie", "plugins", "muse2api-login-profiles")
}

/** 为本次登录开一个新的独立 profile 目录（已创建好），退出后整目录删除。 */
export function newProfileDir(now = Date.now()) {
  const dir = join(profileRoot(), `p-${now}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 删掉某个 profile；浏览器还占着文件时静默失败，下次清理再收。 */
export function removeProfile(dir) {
  if (!dir) return false
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    return true
  } catch {
    return false
  }
}

/** 清理僵尸 profile：正常流程会自己删，这里兜住崩溃/强杀留下的目录。 */
export function cleanupProfiles({ maxAgeMs = 12 * 60 * 60 * 1000, now = Date.now() } = {}) {
  const root = profileRoot()
  if (!existsSync(root)) return 0
  let removed = 0
  for (const name of readdirSync(root)) {
    const dir = join(root, name)
    try {
      if (now - statSync(dir).mtimeMs < maxAgeMs) continue
      removeProfile(dir)
      removed++
    } catch {}
  }
  return removed
}

export function freePort() {
  const server = Bun.serve({ port: 0, fetch: () => new Response("") })
  const port = server.port
  server.stop(true)
  return port
}

/** 启动登录窗口；返回 pid，供结束时整棵进程树一起收掉。 */
export function launchBrowser({ browser, cdpPort, url, profile = newProfileDir() }) {
  const args = [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=Translate,MediaRouter",
    "--disable-background-networking",
    "--disable-sync",
    "--window-size=1100,860",
    url,
  ]
  const proc = spawn(browser, args, { stdio: "ignore", windowsHide: false })
  proc.on("error", () => {})
  return proc.pid
}

/** Chrome 会派生子进程；Windows 上用 taskkill 收整棵树，其它平台按进程组杀。 */
export function killTree(pid) {
  if (!pid) return
  try {
    if (platform() === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore", windowsHide: true })
      return
    }
    process.kill(-pid, "SIGKILL")
  } catch {
    try {
      process.kill(pid, "SIGKILL")
    } catch {}
  }
}
