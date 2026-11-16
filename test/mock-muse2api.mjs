import { createServer } from "node:http"

function readBody(req) {
  return new Promise((resolve) => {
    let data = ""
    req.on("data", (chunk) => {
      data += chunk
    })
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : null)
      } catch {
        resolve(null)
      }
    })
  })
}

const DEFAULT_MODELS = [
  { id: "muse-spark", object: "model", name: "Muse Spark" },
  { id: "muse-image", object: "model", name: "Muse Image" },
  { id: "muse-video", object: "model", name: "Muse Video" },
]

/**
 * 假的 muse2api：只实现插件用到的协议面。
 * imageCompleteAfter=0 表示第一次查询就 completed；1 表示先 running 一次。
 */
export async function startMock(options = {}) {
  const apiKey = options.apiKey ?? "m2a_test_key"
  const models = options.models ?? DEFAULT_MODELS
  const imageCompleteAfter = options.imageCompleteAfter ?? 0
  const videoCompleteAfter = options.videoCompleteAfter ?? 0
  const imageNoUrl = options.imageNoUrl ?? false
  // videoUrlShape: "all" | "url" | "video" | "result"；videoFail: true 时任务以 failed 结束
  const videoUrlShape = options.videoUrlShape ?? "all"
  const videoFail = options.videoFail ?? false

  const state = {
    requests: [],
    imagePosts: [],
    videoPosts: [],
    imageTasks: new Map(),
    videoTasks: new Map(),
  }

  let base = ""
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1")
    state.requests.push({ method: req.method, path: url.pathname })

    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" })
      res.end(JSON.stringify(body))
    }
    const authorized = req.headers.authorization === `Bearer ${apiKey}`

    if (url.pathname === "/v1/models") {
      if (!authorized) return send(401, { detail: "缺少 Authorization: Bearer <key>" })
      return send(200, { object: "list", data: models })
    }

    if (req.method === "POST" && url.pathname === "/v1/images/tasks") {
      if (!authorized) return send(401, { detail: "API key 无效" })
      const body = await readBody(req)
      state.imagePosts.push(body)
      const id = `img_${state.imageTasks.size + 1}`
      state.imageTasks.set(id, { polls: 0, prompt: body?.prompt })
      return send(202, {
        id,
        task_id: id,
        object: "image.task",
        status: "queued",
        progress: 10,
        created_at: 1,
      })
    }

    const imageTask = url.pathname.match(/^\/v1\/images\/tasks\/([^/]+)$/)
    if (req.method === "GET" && imageTask) {
      if (!authorized) return send(401, { detail: "API key 无效" })
      const id = decodeURIComponent(imageTask[1])
      const task = state.imageTasks.get(id)
      if (!task) return send(404, { detail: "task not found" })
      task.polls += 1
      if (task.polls > imageCompleteAfter) {
        return send(200, {
          id,
          task_id: id,
          status: "completed",
          progress: 100,
          data: [
            {
              revised_prompt: task.prompt,
              ...(imageNoUrl ? {} : { url: `${base}/v1/media/${id}.png` }),
              size: "1024x1024",
              kind: "image",
              bytes: 1234,
            },
          ],
        })
      }
      return send(200, { id, task_id: id, status: "running", progress: 40 })
    }

    if (
      req.method === "POST" &&
      (url.pathname === "/v1/videos/generations" || url.pathname === "/v1/videos")
    ) {
      if (!authorized) return send(401, { detail: "API key 无效" })
      const body = await readBody(req)
      state.videoPosts.push(body)
      const id = `vid_${state.videoTasks.size + 1}`
      state.videoTasks.set(id, { polls: 0, body })
      return send(200, {
        id,
        task_id: id,
        object: "video.task",
        status: "queued",
        progress: 10,
        created_at: 1,
      })
    }

    const videoTask = url.pathname.match(/^\/v1\/videos\/(?:generations\/)?([^/]+)$/)
    if (req.method === "GET" && videoTask) {
      if (!authorized) return send(401, { detail: "API key 无效" })
      const id = decodeURIComponent(videoTask[1])
      const task = state.videoTasks.get(id)
      if (!task) return send(404, { detail: "task not found" })
      task.polls += 1
      if (task.polls > videoCompleteAfter) {
        const videoUrl = `${base}/v1/media/${id}.mp4`
        if (videoFail) {
          return send(200, {
            id,
            task_id: id,
            status: "failed",
            progress: 100,
            error: "upstream generation failed",
          })
        }
        const body = { id, task_id: id, status: "completed", progress: 100 }
        if (videoUrlShape === "all" || videoUrlShape === "url") body.url = videoUrl
        if (videoUrlShape === "all" || videoUrlShape === "video") body.video = { url: videoUrl }
        if (videoUrlShape === "all" || videoUrlShape === "result") body.result = { url: videoUrl }
        return send(200, body)
      }
      return send(200, { id, task_id: id, status: "running", progress: 30 })
    }

    send(404, { detail: "not found" })
  })

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  base = `http://127.0.0.1:${server.address().port}`

  return {
    url: base,
    apiKey,
    models,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}
