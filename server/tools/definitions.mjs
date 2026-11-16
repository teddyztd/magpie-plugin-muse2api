import {
  IMAGE_MODEL,
  VIDEO_MODEL,
  apiBase,
  authHeaders,
  missingConfigText,
  pickError,
  requestJson,
  resolveConfig,
} from "../config.mjs"
import { checkRefs, normalizeRefs } from "./refs.mjs"
import { failJson, okJson } from "./result.mjs"
import {
  IMAGE_GEN_ARGS,
  IMAGE_STATUS_ARGS,
  VIDEO_GEN_ARGS,
  VIDEO_STATUS_ARGS,
} from "./schema.mjs"
import { queryVideoTask, waitImageTask } from "./tasks.mjs"

/**
 * 图片与视频只有提交地址、默认模型、参数取舍不同；
 * 提交流程（校验 → 参考图 → 提交 → 错误文案 → task_id）共用一份。
 */
const KINDS = {
  image: {
    path: "/images/tasks",
    argsSpec: IMAGE_GEN_ARGS,
    promptHint: "请描述你想生成的画面",
    statusHint: "调用 image_status 取结果",
    description:
      "提交一次 muse2api 图片生成（文生图/图生图），立即返回 task_id（图片一律异步）。随后用 image_status 取结果。",
    body(args, prompt) {
      const body = { prompt, model: args?.model || IMAGE_MODEL, async: true }
      if (args?.size) body.size = String(args.size)
      if (args?.aspect_ratio) body.aspect_ratio = String(args.aspect_ratio)
      if (args?.extra) body.extra = String(args.extra)
      return body
    },
  },
  video: {
    path: "/videos/generations",
    argsSpec: VIDEO_GEN_ARGS,
    promptHint: "请描述视频的画面、镜头与动作",
    statusHint: "调用 video_status 取结果（视频通常数分钟，隔一会儿再查）",
    description:
      "提交一次 muse2api 视频生成（文生视频/图生视频），立即返回 task_id。视频通常数分钟，稍后用 video_status 查询。",
    body(args, prompt) {
      const body = { prompt, model: args?.model || VIDEO_MODEL }
      if (args?.duration) body.duration = Number(args.duration)
      if (args?.aspect_ratio) body.aspect_ratio = String(args.aspect_ratio)
      if (args?.size) body.size = String(args.size)
      return body
    },
  },
}

const MISSING_CONFIG_HINT = "去 Magpie「插件 → 已安装 → muse2api → 选项」填 baseUrl 与 apiKey"

const missingConfigFail = () =>
  failJson({ error: missingConfigText(), hint: MISSING_CONFIG_HINT })

async function submit(kind, args, ctx, ready) {
  const prompt = String(args?.prompt ?? "").trim()
  if (!prompt) {
    return failJson({ error: `prompt 不能为空：${kind.promptHint}`, field: "prompt" })
  }
  const refErr = checkRefs(args?.reference_images)
  if (refErr) return failJson({ error: refErr, field: "reference_images" })

  const c = ready()
  if (!c) return missingConfigFail()

  const body = kind.body(args, prompt)
  const norm = await normalizeRefs(args?.reference_images)
  if (norm.error) return failJson({ error: norm.error, field: "reference_images" })
  if (norm.failed.length) {
    const detail = norm.failed.map((f) => `${f.value}（${f.error}）`).join("；")
    return failJson({ error: `参考图读取失败：${detail}`, field: "reference_images" })
  }
  if (norm.refs.length) body.images = norm.refs

  const r = await requestJson(
    `${apiBase(c.baseUrl)}${kind.path}`,
    { method: "POST", headers: authHeaders(c.apiKey), body: JSON.stringify(body) },
    ctx,
  )
  if (r.status === 0) {
    return failJson({ error: `连接失败（${c.baseUrl}）：${r.error}`, baseUrl: c.baseUrl })
  }
  if (!r.ok) {
    return failJson({
      http_status: r.status,
      error: `提交失败（HTTP ${r.status}）：${pickError(r)}`,
      baseUrl: c.baseUrl,
    })
  }
  const taskId = r.body?.task_id ?? r.body?.id
  if (!taskId) {
    return failJson({
      error: `提交失败：muse2api 没有返回 task_id：${r.text.slice(0, 300)}`,
      baseUrl: c.baseUrl,
    })
  }
  return okJson({
    task_id: taskId,
    status: r.body?.status ?? "queued",
    progress: r.body?.progress ?? 0,
    hint: kind.statusHint,
  })
}

export function makeToolDefinitions({ input, options } = {}) {
  const cfg = () => resolveConfig({ input, options })
  const ready = () => {
    const { baseUrl, apiKey } = cfg()
    return baseUrl && apiKey ? { baseUrl, apiKey } : null
  }
  const secondsOf = (v) => Math.min(Math.max(Number(v ?? 40) || 40, 1), 40)
  const statusReady = () => ready() ?? missingConfigFail()

  const makeGenerate = (kind) => ({
    description: kind.description,
    argsSpec: kind.argsSpec,
    async execute(args, ctx) {
      return submit(kind, args, ctx, ready)
    },
  })

  return {
    generate_image: makeGenerate(KINDS.image),
    image_status: {
      description:
        "查询 muse2api 图片任务（最多等 wait_seconds 秒轮询）；完成时返回可直接打开的图片 URL。",
      argsSpec: IMAGE_STATUS_ARGS,
      async execute(args, ctx) {
        const c = statusReady()
        if (typeof c === "string") return c
        const taskId = String(args?.task_id ?? "").trim()
        if (!taskId) return failJson({ error: "缺少 task_id", field: "task_id" })
        return waitImageTask(c.baseUrl, c.apiKey, taskId, secondsOf(args?.wait_seconds) * 1000, ctx)
      },
    },
    generate_video: makeGenerate(KINDS.video),
    video_status: {
      description:
        "查询 muse2api 视频任务（单次查询，不等待）；未完成时返回 status/progress，稍后再查即可。",
      argsSpec: VIDEO_STATUS_ARGS,
      async execute(args, ctx) {
        const c = statusReady()
        if (typeof c === "string") return c
        const taskId = String(args?.task_id ?? "").trim()
        if (!taskId) return failJson({ error: "缺少 task_id", field: "task_id" })
        return queryVideoTask(c.baseUrl, c.apiKey, taskId, ctx)
      },
    },
  }
}
