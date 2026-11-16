import { apiBase, authHeaders, pickError, requestJson, sleep } from "../config.mjs"

function pendingView(body) {
  return { status: body?.status ?? "queued", progress: body?.progress }
}

/**
 * 轮询任务直到完成、失败、或预算耗尽。
 * 每次请求的超时都按剩余预算截断，保证总墙钟 < 工具 55s 上限。
 */
export async function pollTask({ url, apiKey, taskId, budgetMs, ctx, mapCompleted }) {
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
    const r = await requestJson(url, { headers: authHeaders(apiKey) }, ctx, Math.min(left, 10_000))
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
  return `${apiBase(baseUrl)}/images/tasks/${encodeURIComponent(taskId)}`
}

function videoTaskUrl(baseUrl, taskId) {
  return `${apiBase(baseUrl)}/videos/${encodeURIComponent(taskId)}`
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

export async function waitVideoTask(baseUrl, apiKey, taskId, budgetMs, ctx) {
  return pollTask({
    url: videoTaskUrl(baseUrl, taskId),
    apiKey,
    taskId,
    budgetMs,
    ctx,
    mapCompleted: (body) => mapVideoCompleted(taskId, body),
  })
}
