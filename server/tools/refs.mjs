import { MAX_REFERENCE_IMAGES } from "../config.mjs"

/** 参考图 → data URL（本地文件）；读不到的单独收集，由工具返回可操作错误。 */
export async function normalizeRefs(refs) {
  if (!Array.isArray(refs)) return { refs: [], failed: [] }
  const out = []
  const failed = []
  for (const raw of refs) {
    const value = String(raw ?? "").trim()
    if (!value) continue
    if (/^https?:\/\//i.test(value) || /^data:/i.test(value)) {
      out.push(value)
      continue
    }
    try {
      const { readFile } = await import("node:fs/promises")
      const { extname, resolve } = await import("node:path")
      const buf = await readFile(resolve(value))
      const ext = extname(value).toLowerCase()
      const mime =
        ext === ".png"
          ? "image/png"
          : ext === ".webp"
            ? "image/webp"
            : ext === ".gif"
              ? "image/gif"
              : "image/jpeg"
      out.push(`data:${mime};base64,${buf.toString("base64")}`)
    } catch (e) {
      failed.push({ value, error: e?.message ?? String(e) })
    }
  }
  return { refs: out, failed }
}

export function checkRefs(rawRefs) {
  if (rawRefs === undefined || rawRefs === null) return undefined
  if (!Array.isArray(rawRefs)) return "reference_images 必须是字符串数组"
  if (rawRefs.length > MAX_REFERENCE_IMAGES) {
    return `参考图最多 ${MAX_REFERENCE_IMAGES} 张（当前 ${rawRefs.length} 张）`
  }
  return undefined
}
