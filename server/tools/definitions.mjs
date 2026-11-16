import { IMAGE_MODEL, VIDEO_MODEL, pickError, requestJson, resolveConfig, apiBase, authHeaders, missingConfigText } from "../config.mjs"
import { checkRefs, normalizeRefs } from "./refs.mjs"
import {
  IMAGE_GEN_ARGS,
  IMAGE_STATUS_ARGS,
  VIDEO_GEN_ARGS,
  VIDEO_STATUS_ARGS,
} from "./schema.mjs"
import { waitImageTask, waitVideoTask } from "./tasks.mjs"

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
    statusHint: "调用 video_status 取结果（视频通常数分钟）",
    description:
      "提交一次 muse2api 视频生成（文生视频/图生视频），立即返回 task_id。视频通常数分钟，用 video_status 轮询。",
    body(args, prompt) {
      const body = { prompt, model: args?.model || VIDEO_MODEL }
      if (args?.duration) body.duration = Number(args.duration)
      if (args?.aspect_ratio) body.aspect_ratio = String(args.aspect_ratio)
      if (args?.size) body.size = String(args.size)
      return body
    },
  },
}

function refsError(failed) {
  return `参考图读取失败：${failed.map((f) => `${f.value}（${f.error}）`).join("；")}`
}

async function submit(kind, args, ctx, ready) {
  const prompt = String(args?.prompt ?? "").trim()
  if (!prompt) return `prompt 不能为空：${kind.promptHint}`
  const refErr = checkRefs(args?.reference_images)
  if (refErr) return refErr

  const c = ready()
  if (!c) return missingConfigText()

  const body = kind.body(args, prompt)
  const { refs, failed } = await normalizeRefs(args?.reference_images)
  if (failed.length) return refsError(failed)
  if (refs.length) body.images = refs

  const r = await requestJson(
    `${apiBase(c.baseUrl)}${kind.path}`,
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
      hint: kind.statusHint,
    },
    null,
    2,
  )
}

export function makeToolDefinitions({ input, options } = {}) {
  const cfg = () => resolveConfig({ input, options })
  const ready = () => {
    const { baseUrl, apiKey } = cfg()
    return baseUrl && apiKey ? { baseUrl, apiKey } : null
  }
  const secondsOf = (v) => Math.min(Math.max(Number(v ?? 40) || 40, 1), 40)

  const makeGenerate = (kind) => ({
    description: kind.description,
    argsSpec: kind.argsSpec,
    async execute(args, ctx) {
      return submit(kind, args, ctx, ready)
    },
  })

  const makeStatus = (description, argsSpec, wait) => ({
    description,
    argsSpec,
    async execute(args, ctx) {
      const c = ready()
      if (!c) return missingConfigText()
      const taskId = String(args?.task_id ?? "").trim()
      if (!taskId) return "缺少 task_id"
      const result = await wait(
        c.baseUrl,
        c.apiKey,
        taskId,
        secondsOf(args?.wait_seconds) * 1000,
        ctx,
      )
      return JSON.stringify(result, null, 2)
    },
  })

  return {
    generate_image: makeGenerate(KINDS.image),
    image_status: makeStatus(
      "查询 muse2api 图片任务（内部最多等 wait_seconds 秒轮询）；完成时返回可直接打开的图片 URL。",
      IMAGE_STATUS_ARGS,
      waitImageTask,
    ),
    generate_video: makeGenerate(KINDS.video),
    video_status: makeStatus(
      "查询 muse2api 视频任务（内部最多等 wait_seconds 秒轮询）；完成时返回可直接打开的视频 URL。",
      VIDEO_STATUS_ARGS,
      waitVideoTask,
    ),
  }
}
