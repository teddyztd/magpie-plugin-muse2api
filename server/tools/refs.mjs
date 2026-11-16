import {
  MAX_REFERENCE_IMAGES,
  MAX_REFERENCE_IMAGE_BYTES,
  MAX_REFERENCE_TOTAL_BYTES,
  formatBytes,
} from "../config.mjs"

const isRemote = (v) => /^https?:\/\//i.test(v)
const isData = (v) => /^data:/i.test(v)

/** 参考图张数：多发一张上游也是 400，不如本地拦掉。 */
export function checkRefs(rawRefs) {
  if (rawRefs === undefined || rawRefs === null) return undefined
  if (!Array.isArray(rawRefs)) return "reference_images 必须是字符串数组"
  if (rawRefs.length > MAX_REFERENCE_IMAGES) {
    return `参考图最多 ${MAX_REFERENCE_IMAGES} 张（当前 ${rawRefs.length} 张）`
  }
  return undefined
}

function dataUrlBytes(value) {
  const comma = value.indexOf(",")
  if (comma < 0) return 0
  const payload = value.slice(comma + 1)
  if (!/;base64/i.test(value.slice(0, comma))) return Buffer.byteLength(payload)
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding)
}

/**
 * 参考图归一化：http(s) 原样、data: 原样、本地文件读成 data URL。
 * 同时按上游同量级的体积上限（单张 / 合计）在本地拦下，避免白跑一次 413。
 * http(s) 的图片体积无法在本地得知，留给上游校验（README 有说明）。
 */
export async function normalizeRefs(refs, limits = {}) {
  const maxImage = limits.maxImageBytes ?? MAX_REFERENCE_IMAGE_BYTES
  const maxTotal = limits.maxTotalBytes ?? MAX_REFERENCE_TOTAL_BYTES
  const out = []
  const failed = []
  let total = 0

  if (!Array.isArray(refs)) return { refs: out, failed, error: undefined }

  for (const raw of refs) {
    const value = String(raw ?? "").trim()
    if (!value) continue

    let bytes
    let normalized = value
    if (isRemote(value)) {
      out.push(value)
      continue
    } else if (isData(value)) {
      bytes = dataUrlBytes(value)
    } else {
      try {
        const { readFile, stat } = await import("node:fs/promises")
        const { extname, resolve } = await import("node:path")
        const path = resolve(value)
        // 先看 stat 再决定读不读：避免把超限的大文件整个读进内存。
        const info = await stat(path)
        if (info.size > maxImage) {
          return {
            refs: out,
            failed,
            error: `参考图 ${value.slice(0, 80)} 超过单张上限 ${formatBytes(maxImage)}（当前 ${formatBytes(info.size)}）`,
          }
        }
        if (total + info.size > maxTotal) {
          return {
            refs: out,
            failed,
            error: `参考图合计超过 ${formatBytes(maxTotal)} 上限（累计 ${formatBytes(total + info.size)}）`,
          }
        }
        const buf = await readFile(path)
        bytes = buf.length
        const ext = extname(value).toLowerCase()
        const mime =
          ext === ".png"
            ? "image/png"
            : ext === ".webp"
              ? "image/webp"
              : ext === ".gif"
                ? "image/gif"
                : "image/jpeg"
        normalized = `data:${mime};base64,${buf.toString("base64")}`
      } catch (e) {
        failed.push({ value, error: e?.message ?? String(e) })
        continue
      }
    }

    if (bytes > maxImage) {
      return {
        refs: out,
        failed,
        error: `参考图 ${value.slice(0, 80)} 超过单张上限 ${formatBytes(maxImage)}（当前 ${formatBytes(bytes)}）`,
      }
    }
    total += bytes
    if (total > maxTotal) {
      return {
        refs: out,
        failed,
        error: `参考图合计超过 ${formatBytes(maxTotal)} 上限（已读 ${formatBytes(total)}）`,
      }
    }
    out.push(normalized)
  }

  return { refs: out, failed, error: undefined }
}
