// 端到端冒烟：直接调用插件入口 + 真 HTTP 打到 mock muse2api。
// 跑法：bun run test/smoke.mjs
// 说明：不依赖 @opencode-ai/plugin 一定能解析；解析不到时工具走 JSON Schema 兜底，仍然可执行。
import { Muse2ApiPlugin } from "../server/index.mjs"
import { startMock } from "./mock-muse2api.mjs"

const apiKey = "m2a_smoke"
const mock = await startMock({ apiKey, imageCompleteAfter: 2, videoCompleteAfter: 1 })
const ctx = { abort: new AbortController().signal }
const ok = []

try {
  const hooks = await Muse2ApiPlugin(
    {
      directory: process.cwd(),
      worktree: process.cwd(),
      project: { id: "magpie" },
      magpie: { option: () => "" },
    },
    { baseUrl: mock.url, apiKey },
  )

  const tools = hooks.tool ?? {}
  const names = Object.keys(tools).sort()
  console.log("tools:", names.join(", "))
  ok.push(names.join(",") === "generate_image,generate_video,image_status,video_status")

  const submitted = JSON.parse(
    await tools.generate_image.execute({ prompt: "a blue cat", aspect_ratio: "1:1" }, ctx),
  )
  console.log("image submit:", JSON.stringify(submitted))
  ok.push(submitted.ok === true && submitted.status === "queued" && submitted.task_id === "img_1")

  const img = JSON.parse(
    await tools.image_status.execute({ task_id: submitted.task_id, wait_seconds: 20 }, ctx),
  )
  console.log("image status:", JSON.stringify(img))
  ok.push(img.ok === true && img.status === "completed" && img.url === `${mock.url}/v1/media/img_1.png`)

  const vsub = JSON.parse(
    await tools.generate_video.execute({ prompt: "waves at dusk", duration: 5 }, ctx),
  )
  console.log("video submit:", JSON.stringify(vsub))
  ok.push(vsub.ok === true && vsub.status === "queued" && vsub.task_id === "vid_1")

  // video_status 是单次查询：mock 第一次返回 running，第二次才 completed
  const vpending = JSON.parse(await tools.video_status.execute({ task_id: vsub.task_id }, ctx))
  console.log("video status #1:", JSON.stringify(vpending))
  ok.push(vpending.ok === true && vpending.status === "running")

  const vid = JSON.parse(await tools.video_status.execute({ task_id: vsub.task_id }, ctx))
  console.log("video status #2:", JSON.stringify(vid))
  ok.push(vid.ok === true && vid.status === "completed" && vid.url === `${mock.url}/v1/media/vid_1.mp4`)

  // 未配置时的可操作提示（JSON 契约）
  const bare = await Muse2ApiPlugin({ directory: process.cwd(), magpie: { option: () => "" } }, {})
  const bareMsg = JSON.parse(await bare.tool.generate_image.execute({ prompt: "x" }, ctx))
  console.log("unconfigured:", String(bareMsg.error).split("\n")[0])
  ok.push(bareMsg.ok === false && String(bareMsg.error).includes("没有配置 muse2api 连接信息"))
} finally {
  await mock.close()
}

const passed = ok.every(Boolean)
console.log(passed ? "SMOKE OK" : "SMOKE FAILED")
process.exitCode = passed ? 0 : 1
