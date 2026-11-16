import { apiBase, authHeaders, pickError, requestJson, sleep } from "../config.mjs"
import { failJson, okJson } from "./result.mjs"

const DONE = ["completed", "succeeded", "success"]
const BAD = ["failed", "error", "cancelled", "canceled"]
const PENDING_HINT = "任务仍在生成，稍后再调用（传同一个 task_id）"

/** 完成态的三种 URL 形状：data[0].url / url / result.url 等，各工具自己挑。 */
function mapImageCompleted(taskId, body) {
  const data = Array.isArray(body.data) ? body.data[0] : undefined
  return {
    task_id: taskId,
    url: data?.url ?? body.url ?? body.result?.url,
    size: data?.size ?? body.size,
    kind: data?.kind ?? body.kind,
    bytes: data?.bytes ?? body.bytes,
    revised_prompt: data?.revised_prompt,
  }
}

function mapVideoCompleted(taskId, body) {
  const out = { task_id: taskId, url: body.url ?? body.video?.url ?? body.result?.url }
  if (body.size) out.size = body.size
  if (body.duration) out.duration = body.duration
  return out
}

/** 把一次任务查询的响应翻成对外 JSON；未完成也是正常返回（带 hint）。 */
export function taskView(body, taskId, mapCompleted) {
  const status = body?.status ?? "queued"
  if (DONE.includes(status)) {
    const done = mapCompleted(body)
    if (!done.url) {
      return failJson({
        status,
        task_id: taskId,
        error: "任务已完成但没有返回 URL（检查 muse2api 的 PUBLIC_BASE 是否可达）",
      })
    }
    return okJson({ status: "completed", ...done })
  }
  if (BAD.includes(status)) {
    return failJson({
      status,
      task_id: taskId,
      error: body?.error ?? body?.message ?? "生成失败",
    })
  }
  return okJson({ status, progress: body?.progress, task_id: taskId, hint: PENDING_HINT })
}

function imageTaskUrl(baseUrl, taskId) {
  return `${apiBase(baseUrl)}/images/tasks/${encodeURIComponent(taskId)}`
}

function videoTaskUrl(baseUrl, taskId) {
  return `${apiBase(baseUrl)}/videos/${encodeURIComponent(taskId)}`
}

function failure(result, taskId, what) {
  if (result.status === 0) return failJson({ task_id: taskId, error: `${what}失败：${result.error}` })
  return failJson({
    task_id: taskId,
    http_status: result.status,
    error: `${what}失败（HTTP ${result.status}）：${pickError(result)}`,
  })
}

/**
 * 轮询任务直到完成、失败或预算耗尽；每次请求超时按剩余预算截断，
 * 保证总墙钟留在工具 55s 上限内。图片用（视频只在工具外再查）。
 */
export async function pollTask({ url, apiKey, taskId, budgetMs, ctx, mapCompleted }) {
  const deadline = Date.now() + budgetMs
  let last = {}
  for (;;) {
    const left = deadline - Date.now()
    if (left <= 0) {
      return okJson({
        status: last?.status ?? "queued",
        progress: last?.progress,
        task_id: taskId,
        hint: PENDING_HINT,
      })
    }
    const r = await requestJson(url, { headers: authHeaders(apiKey) }, ctx, Math.min(left, 10_000))
    if (r.status === 0 || !r.ok) return failure(r, taskId, "查询")
    const body = r.body ?? {}
    last = body
    if (DONE.includes(body.status) || BAD.includes(body.status)) {
      return taskView(body, taskId, mapCompleted)
    }
    if (deadline - Date.now() <= 1500) {
      return okJson({ status: body.status ?? "queued", progress: body.progress, task_id: taskId, hint: PENDING_HINT })
    }
    try {
      await sleep(1500, ctx?.abort)
    } catch (e) {
      return failJson({ task_id: taskId, error: `已取消：${e?.message ?? e}` })
    }
  }
}

export async function waitImageTask(baseUrl, apiKey, taskId, budgetMs, ctx) {
  return pollTask({
    url: imageTaskUrl(baseUrl, taskId),
    apiKey,
    taskId,
    budgetMs,
    ctx,
    mapCompleted: (body) => mapImageCompleted(taskId, body),
  })
}

/** 视频只查一次：视频要几分钟，工具内等不起（每次调用最多 55s）。 */
export async function queryVideoTask(baseUrl, apiKey, taskId, ctx) {
  const r = await requestJson(
    videoTaskUrl(baseUrl, taskId),
    { headers: authHeaders(apiKey) },
    ctx,
    20_000,
  )
  if (r.status === 0 || !r.ok) return failure(r, taskId, "查询")
  return taskView(r.body ?? {}, taskId, (body) => mapVideoCompleted(taskId, body))
}
