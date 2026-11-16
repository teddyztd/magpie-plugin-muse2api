import {
  IMAGE_MODEL,
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
    description: "参考图：http(s) URL 或本地文件路径（本地文件会转 data URL），用于图生图",
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
    description: "首帧/参考图：http(s) URL 或本地文件路径",
  },
  model: { type: "string", description: `模型，默认 ${VIDEO_MODEL}` },
}

const VIDEO_STATUS_ARGS = {
  task_id: { type: "string", required: true, description: "generate_video 返回的 task_id" },
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

async function normalizeRefs(refs) {
  if (!Array.isArray(refs)) return []
  const out = []
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
    } catch {
      // 读不到就原样交给上游判定，并把问题留在返回里
      out.push(value)
    }
  }
  return out
}

async function waitImageTask(baseUrl, apiKey, taskId, budgetMs, ctx) {
  const deadline = Date.now() + budgetMs
  let last = {}
  for (;;) {
    const r = await requestJson(
      `${baseUrl}/v1/images/tasks/${encodeURIComponent(taskId)}`,
      { headers: authHeaders(apiKey) },
      ctx,
    )
    if (r.status === 0) {
      return { ...last, task_id: taskId, error: `查询失败：${r.error}` }
    }
    if (!r.ok) {
      return { ...last, task_id: taskId, error: `查询失败（HTTP ${r.status}）：${pickError(r)}` }
    }
    const body = r.body ?? {}
    last = body
    if (body.status === "completed") {
      const data = Array.isArray(body.data) ? body.data[0] : undefined
      const url = data?.url ?? body.url ?? body.result?.url
      return {
        status: "completed",
        task_id: taskId,
        url,
        size: data?.size ?? body.size,
        kind: data?.kind ?? body.kind,
        bytes: data?.bytes ?? body.bytes,
        revised_prompt: data?.revised_prompt,
      }
    }
    if (["failed", "error", "cancelled", "canceled"].includes(body.status)) {
      return {
        status: body.status,
        task_id: taskId,
        error: body.error ?? body.message ?? "生成失败",
      }
    }
    if (Date.now() + 1500 > deadline) {
      return {
        status: body.status ?? "queued",
        progress: body.progress,
        task_id: taskId,
        hint: "仍在生成，稍后再调用 image_status（传同一个 task_id）",
      }
    }
    try {
      await sleep(1500, ctx?.abort)
    } catch (e) {
      return { status: body.status ?? "queued", task_id: taskId, error: `已取消：${e?.message ?? e}` }
    }
  }
}

export function makeToolDefinitions({ input, options } = {}) {
  const cfg = () => resolveConfig({ input, options })
  const ready = () => {
    const { baseUrl, apiKey } = cfg()
    if (!baseUrl || !apiKey) return null
    return { baseUrl, apiKey }
  }

  return {
    generate_image: {
      description:
        "提交一次 muse2api 图片生成（文生图/图生图），立即返回 task_id（图片一律异步）。随后用 image_status 取结果。",
      argsSpec: IMAGE_GEN_ARGS,
      async execute(args, ctx) {
        const c = ready()
        if (!c) return missingConfigText()
        const body = {
          prompt: String(args?.prompt ?? ""),
          model: args?.model || IMAGE_MODEL,
          async: true,
        }
        if (args?.size) body.size = String(args.size)
        if (args?.aspect_ratio) body.aspect_ratio = String(args.aspect_ratio)
        if (args?.extra) body.extra = String(args.extra)
        const refs = await normalizeRefs(args?.reference_images)
        if (refs.length) body.images = refs

        const r = await requestJson(
          `${c.baseUrl}/v1/images/tasks`,
          { method: "POST", headers: authHeaders(c.apiKey), body: JSON.stringify(body) },
          ctx,
        )
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
      description: "查询 muse2api 图片任务；完成时返回可直接打开的图片 URL。",
      argsSpec: IMAGE_STATUS_ARGS,
      async execute(args, ctx) {
        const c = ready()
        if (!c) return missingConfigText()
        const taskId = String(args?.task_id ?? "").trim()
        if (!taskId) return "缺少 task_id"
        const seconds = Math.min(Math.max(Number(args?.wait_seconds ?? 40) || 40, 1), 40)
        const result = await waitImageTask(c.baseUrl, c.apiKey, taskId, seconds * 1000, ctx)
        return JSON.stringify(result, null, 2)
      },
    },

    generate_video: {
      description:
        "提交一次 muse2api 视频生成（文生视频/图生视频），立即返回 task_id。视频通常数分钟，用 video_status 轮询。",
      argsSpec: VIDEO_GEN_ARGS,
      async execute(args, ctx) {
        const c = ready()
        if (!c) return missingConfigText()
        const body = {
          prompt: String(args?.prompt ?? ""),
          model: args?.model || VIDEO_MODEL,
        }
        if (args?.duration) body.duration = Number(args.duration)
        if (args?.aspect_ratio) body.aspect_ratio = String(args.aspect_ratio)
        if (args?.size) body.size = String(args.size)
        const refs = await normalizeRefs(args?.reference_images)
        if (refs.length) body.images = refs

        const r = await requestJson(
          `${c.baseUrl}/v1/videos/generations`,
          { method: "POST", headers: authHeaders(c.apiKey), body: JSON.stringify(body) },
          ctx,
        )
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
      description: "查询 muse2api 视频任务；完成时返回可直接打开的视频 URL。",
      argsSpec: VIDEO_STATUS_ARGS,
      async execute(args, ctx) {
        const c = ready()
        if (!c) return missingConfigText()
        const taskId = String(args?.task_id ?? "").trim()
        if (!taskId) return "缺少 task_id"
        const r = await requestJson(
          `${c.baseUrl}/v1/videos/${encodeURIComponent(taskId)}`,
          { headers: authHeaders(c.apiKey) },
          ctx,
        )
        if (r.status === 0) return `查询失败：${r.error}`
        if (!r.ok) return `查询失败（HTTP ${r.status}）：${pickError(r)}`
        const body = r.body ?? {}
        const url = body.url ?? body.video?.url ?? body.result?.url
        const out = {
          status: body.status,
          progress: body.progress,
          task_id: taskId,
        }
        if (url) out.url = url
        if (body.status === "completed" && !url) out.error = "任务已完成但没有返回 URL"
        if (body.status !== "completed" && !url) out.hint = "任务未完成，稍后再查"
        return JSON.stringify(out, null, 2)
      },
    },
  }
}

export async function buildTools({ input, options } = {}) {
  const definitions = makeToolDefinitions({ input, options })
  let toolFn
  let schema
  try {
    const sdk = await import("@opencode-ai/plugin")
    toolFn = sdk.tool
    schema = sdk.tool?.schema
  } catch {
    toolFn = undefined
  }

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

export const _internal = { toJsonSchema, toZod, normalizeRefs, waitImageTask }
