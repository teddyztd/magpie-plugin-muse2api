import {
  IMAGE_MODEL,
  MAX_REFERENCE_IMAGES,
  VIDEO_MODEL,
  authHeaders,
  missingConfigText,
  pickError,
  requestJson,
  resolveConfig,
  sleep,
} from "./config.mjs"

// args 只描述一次；有 SDK 时转成 zod，没有时用 JSON Schema（文档两者都接受）。
const IMAGE_GEN_ARGS = {
  prompt: { type: "string", required: true, description: "图片描述（越具体越好）" },
  size: { type: "string", description: "尺寸，例如 1024x1024；不填由上游决定" },
  aspect_ratio: { type: "string", description: "宽高比，例如 1:1、16:9、9:16" },
  reference_images: {
    type: "array",
    items: { type: "string" },
    description: `参考图（最多 ${MAX_REFERENCE_IMAGES} 张）：http(s) URL 或本地文件路径（本地文件会转 data URL），用于图生图`,
  },
  model: { type: "string", description: `模型，默认 ${IMAGE_MODEL}` },
  extra: { type: "string", description: "附加提示词" },
}

const IMAGE_STATUS_ARGS = {
  task_id: { type: "string", required: true, description: "generate_image 返回的 task_id" },
  wait_seconds: { type: "number", description: "最多等待秒数，默认 40，上限 40" },
}

const VIDEO_GEN_ARGS = {
  prompt: { type: "string", required: true, description: "视频描述（画面、镜头、动作）" },
  duration: { type: "number", description: "时长（秒），不填由上游决定" },
  aspect_ratio: { type: "string", description: "宽高比，例如 16:9、9:16" },
  size: { type: "string", description: "分辨率，例如 1280x720" },
  reference_images: {
    type: "array",
    items: { type: "string" },
    description: "首帧/参考图（最多 8 张）：http(s) URL 或本地文件路径",
  },
  model: { type: "string", description: `模型，默认 ${VIDEO_MODEL}` },
}

const VIDEO_STATUS_ARGS = {
  task_id: { type: "string", required: true, description: "generate_video 返回的 task_id" },
  wait_seconds: { type: "number", description: "最多等待秒数，默认 40，上限 40" },
}

function toJsonSchema(spec) {
  const properties = {}
  const required = []
  for (const [key, value] of Object.entries(spec)) {
    const { required: isRequired, ...rest } = value
    properties[key] = rest
    if (isRequired) required.push(key)
  }
  return { type: "object", properties, required, additionalProperties: false }
}

function toZod(spec, schema) {
  const out = {}
  for (const [key, value] of Object.entries(spec)) {
    let z
    if (value.type === "array") z = schema.array(schema.string())
    else if (value.type === "number") z = schema.number()
    else if (value.type === "boolean") z = schema.boolean()
    else z = schema.string()
    if (value.description) z = z.describe(value.description)
    if (!value.required) z = z.optional()
    out[key] = z
  }
  return out
}

/** 参考图 → data URL（本地文件）；读不到的单独收集，由工具返回可操作错误。 */
async function normalizeRefs(refs) {
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

function checkRefs(rawRefs) {
  if (rawRefs === undefined || rawRefs === null) return undefined
  if (!Array.isArray(rawRefs)) return "reference_images 必须是字符串数组"
  if (rawRefs.length > MAX_REFERENCE_IMAGES) {
    return `参考图最多 ${MAX_REFERENCE_IMAGES} 张（当前 ${rawRefs.length} 张）`
  }
  return undefined
}

function pendingView(body) {
  return { status: body?.status ?? "queued", progress: body?.progress }
}

/**
 * 轮询任务直到完成、失败、或预算耗尽。
 * 每次请求的超时都按剩余预算截断，保证总墙钟 < 工具 55s 上限。
 */
async function pollTask({ url, apiKey, taskId, budgetMs, ctx, mapCompleted }) {
  const deadline = Date.now() + budgetMs
  let last = {}
  for (;;) {
    const left = deadline - Date.now()
    if (left <= 0) {
      return {
        ...pendingView(last),
        task_id: taskId,
        hint: "仍在生成，稍后再调用（传同一个 task_id）",
      }
    }
    const r = await requestJson(
      url,
      { headers: authHeaders(apiKey) },
      ctx,
      Math.min(left, 10_000),
    )
    if (r.status === 0) {
      return { ...pendingView(last), task_id: taskId, error: `查询失败：${r.error}` }
    }
    if (!r.ok) {
      return {
        ...pendingView(last),
        task_id: taskId,
        error: `查询失败（HTTP ${r.status}）：${pickError(r)}`,
      }
    }
    const body = r.body ?? {}
    last = body
    if (["completed", "succeeded", "success"].includes(body.status)) {
      return mapCompleted(body)
    }
    if (["failed", "error", "cancelled", "canceled"].includes(body.status)) {
      return {
        status: body.status,
        ...pendingView(body),
        task_id: taskId,
        error: body.error ?? body.message ?? "生成失败",
      }
    }
    if (deadline - Date.now() <= 1500) {
      return {
        ...pendingView(body),
        task_id: taskId,
        hint: "仍在生成，稍后再调用（传同一个 task_id）",
      }
    }
    try {
      await sleep(1500, ctx?.abort)
    } catch (e) {
      return { ...pendingView(body), task_id: taskId, error: `已取消：${e?.message ?? e}` }
    }
  }
}

function imageTaskUrl(baseUrl, taskId) {
  return `${baseUrl}/v1/images/tasks/${encodeURIComponent(taskId)}`
}

function videoTaskUrl(baseUrl, taskId) {
  return `${baseUrl}/v1/videos/${encodeURIComponent(taskId)}`
}

function mapImageCompleted(taskId, body) {
  const data = Array.isArray(body.data) ? body.data[0] : undefined
  const url = data?.url ?? body.url ?? body.result?.url
  const out = {
    status: "completed",
    task_id: taskId,
    url,
    size: data?.size ?? body.size,
    kind: data?.kind ?? body.kind,
    bytes: data?.bytes ?? body.bytes,
    revised_prompt: data?.revised_prompt,
  }
  if (!url) out.error = "任务已完成但没有返回 URL（检查 muse2api 的 PUBLIC_BASE）"
  return out
}

function mapVideoCompleted(taskId, body) {
  const url = body.url ?? body.video?.url ?? body.result?.url
  const out = { status: "completed", task_id: taskId, url }
  if (body.size) out.size = body.size
  if (body.duration) out.duration = body.duration
  if (!url) out.error = "任务已完成但没有返回 URL（检查 muse2api 的 PUBLIC_BASE）"
  return out
}

async function waitImageTask(baseUrl, apiKey, taskId, budgetMs, ctx) {
  return pollTask({
    url: imageTaskUrl(baseUrl, taskId),
    apiKey,
    taskId,
    budgetMs,
    ctx,
    mapCompleted: (body) => mapImageCompleted(taskId, body),
  })
}

async function waitVideoTask(baseUrl, apiKey, taskId, budgetMs, ctx) {
  return pollTask({
    url: videoTaskUrl(baseUrl, taskId),
    apiKey,
    taskId,
    budgetMs,
    ctx,
    mapCompleted: (body) => mapVideoCompleted(taskId, body),
  })
}

export function makeToolDefinitions({ input, options } = {}) {
  const cfg = () => resolveConfig({ input, options })
  const ready = () => {
    const { baseUrl, apiKey } = cfg()
    if (!baseUrl || !apiKey) return null
    return { baseUrl, apiKey }
  }
  const secondsOf = (v) => Math.min(Math.max(Number(v ?? 40) || 40, 1), 40)

  return {
    generate_image: {
      description:
        "提交一次 muse2api 图片生成（文生图/图生图），立即返回 task_id（图片一律异步）。随后用 image_status 取结果。",
      argsSpec: IMAGE_GEN_ARGS,
      async execute(args, ctx) {
        const prompt = String(args?.prompt ?? "").trim()
        if (!prompt) return "prompt 不能为空：请描述你想生成的画面"
        const refErr = checkRefs(args?.reference_images)
        if (refErr) return refErr
        const c = ready()
        if (!c) return missingConfigText()

        const body = { prompt, model: args?.model || IMAGE_MODEL, async: true }
        if (args?.size) body.size = String(args.size)
        if (args?.aspect_ratio) body.aspect_ratio = String(args.aspect_ratio)
        if (args?.extra) body.extra = String(args.extra)
        const { refs, failed } = await normalizeRefs(args?.reference_images)
        if (failed.length) {
          return `参考图读取失败：${failed.map((f) => `${f.value}（${f.error}）`).join("；")}`
        }
        if (refs.length) body.images = refs

        const r = await requestJson(
          `${c.baseUrl}/v1/images/tasks`,
          { method: "POST", headers: authHeaders(c.apiKey), body: JSON.stringify(body) },
          ctx,
        )
        if (r.status === 0) return `连接失败（${c.baseUrl}）：${r.error}`
        if (!r.ok) return `提交失败（HTTP ${r.status}）：${pickError(r)}`
        const taskId = r.body?.task_id ?? r.body?.id
        if (!taskId) return `提交失败：muse2api 没有返回 task_id：${r.text.slice(0, 300)}`
        return JSON.stringify(
          {
            task_id: taskId,
            status: r.body?.status ?? "queued",
            progress: r.body?.progress ?? 0,
            hint: "调用 image_status 取结果",
          },
          null,
          2,
        )
      },
    },

    image_status: {
      description:
        "查询 muse2api 图片任务（内部最多等 wait_seconds 秒轮询）；完成时返回可直接打开的图片 URL。",
      argsSpec: IMAGE_STATUS_ARGS,
      async execute(args, ctx) {
        const c = ready()
        if (!c) return missingConfigText()
        const taskId = String(args?.task_id ?? "").trim()
        if (!taskId) return "缺少 task_id"
        const result = await waitImageTask(
          c.baseUrl,
          c.apiKey,
          taskId,
          secondsOf(args?.wait_seconds) * 1000,
          ctx,
        )
        return JSON.stringify(result, null, 2)
      },
    },

    generate_video: {
      description:
        "提交一次 muse2api 视频生成（文生视频/图生视频），立即返回 task_id。视频通常数分钟，用 video_status 轮询。",
      argsSpec: VIDEO_GEN_ARGS,
      async execute(args, ctx) {
        const prompt = String(args?.prompt ?? "").trim()
        if (!prompt) return "prompt 不能为空：请描述视频的画面、镜头与动作"
        const refErr = checkRefs(args?.reference_images)
        if (refErr) return refErr
        const c = ready()
        if (!c) return missingConfigText()

        const body = { prompt, model: args?.model || VIDEO_MODEL }
        if (args?.duration) body.duration = Number(args.duration)
        if (args?.aspect_ratio) body.aspect_ratio = String(args.aspect_ratio)
        if (args?.size) body.size = String(args.size)
        const { refs, failed } = await normalizeRefs(args?.reference_images)
        if (failed.length) {
          return `参考图读取失败：${failed.map((f) => `${f.value}（${f.error}）`).join("；")}`
        }
        if (refs.length) body.images = refs

        const r = await requestJson(
          `${c.baseUrl}/v1/videos/generations`,
          { method: "POST", headers: authHeaders(c.apiKey), body: JSON.stringify(body) },
          ctx,
        )
        if (r.status === 0) return `连接失败（${c.baseUrl}）：${r.error}`
        if (!r.ok) return `提交失败（HTTP ${r.status}）：${pickError(r)}`
        const taskId = r.body?.task_id ?? r.body?.id
        if (!taskId) return `提交失败：muse2api 没有返回 task_id：${r.text.slice(0, 300)}`
        return JSON.stringify(
          {
            task_id: taskId,
            status: r.body?.status ?? "queued",
            progress: r.body?.progress ?? 0,
            hint: "调用 video_status 取结果（视频通常数分钟）",
          },
          null,
          2,
        )
      },
    },

    video_status: {
      description:
        "查询 muse2api 视频任务（内部最多等 wait_seconds 秒轮询）；完成时返回可直接打开的视频 URL。",
      argsSpec: VIDEO_STATUS_ARGS,
      async execute(args, ctx) {
        const c = ready()
        if (!c) return missingConfigText()
        const taskId = String(args?.task_id ?? "").trim()
        if (!taskId) return "缺少 task_id"
        const result = await waitVideoTask(
          c.baseUrl,
          c.apiKey,
          taskId,
          secondsOf(args?.wait_seconds) * 1000,
          ctx,
        )
        return JSON.stringify(result, null, 2)
      },
    },
  }
}

/** 优先从宿主依赖解析 SDK；失败再试 magpie 配置目录下的 plugins/node_modules。 */
async function loadSdk(input) {
  try {
    return await import("@opencode-ai/plugin")
  } catch {
    // 继续尝试宿主绝对路径
  }
  const dir = typeof input?.directory === "string" ? input.directory : ""
  if (!dir) return null
  try {
    const { pathToFileURL } = await import("node:url")
    const { join } = await import("node:path")
    const entry = join(
      dir,
      "plugins",
      "node_modules",
      "@opencode-ai",
      "plugin",
      "dist",
      "index.js",
    )
    return await import(pathToFileURL(entry).href)
  } catch {
    return null
  }
}

export async function buildTools({ input, options } = {}) {
  const definitions = makeToolDefinitions({ input, options })
  const sdk = await loadSdk(input)
  const toolFn = sdk?.tool
  const schema = sdk?.tool?.schema

  const out = {}
  for (const [name, def] of Object.entries(definitions)) {
    if (typeof toolFn === "function" && schema) {
      out[name] = toolFn({
        description: def.description,
        args: toZod(def.argsSpec, schema),
        execute: def.execute,
      })
    } else {
      // 宿主没提供 SDK 时退回 JSON Schema（文档允许）；工具仍可用。
      out[name] = {
        description: def.description,
        args: toJsonSchema(def.argsSpec),
        execute: def.execute,
      }
    }
  }
  return out
}

export const _internal = {
  toJsonSchema,
  toZod,
  normalizeRefs,
  waitImageTask,
  waitVideoTask,
  pollTask,
}
