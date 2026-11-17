import { existsSync } from "node:fs"
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

/** 独立 profile：不碰用户日常浏览器，退出后可整目录删除。 */
export function profileDir() {
  return join(homedir(), ".config", "magpie", "plugins", "muse2api-login-profile")
}

export function freePort() {
  const server = Bun.serve({ port: 0, fetch: () => new Response("") })
  const port = server.port
  server.stop(true)
  return port
}

/** 启动登录窗口；返回 pid，供结束时整棵进程树一起收掉。 */
export function launchBrowser({ browser, cdpPort, url }) {
  const args = [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profileDir()}`,
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
