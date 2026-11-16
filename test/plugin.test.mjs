import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { DEFAULT_BASE, missingConfigText, resolveConfig } from "../server/config.mjs"
import { Muse2ApiPlugin } from "../server/index.mjs"
import { buildAuthHook, buildConfigHook, buildProviderHook } from "../server/provider.mjs"
import { _internal as toolsInternal, buildTools, makeToolDefinitions } from "../server/tools.mjs"
import { startMock } from "./mock-muse2api.mjs"

let mock

beforeAll(async () => {
  mock = await startMock({ imageCompleteAfter: 1 })
})

afterAll(async () => {
  await mock?.close()
})

function cleanupEnv() {
  delete process.env.MUSE2API_BASE_URL
  delete process.env.MUSE2API_KEY
}

describe("provider 声明", () => {
  test("config 钩子写入 muse2api provider", async () => {
    const cfg = { provider: {} }
    await buildConfigHook()(cfg)
    const provider = cfg.provider.muse2api
    expect(provider).toBeDefined()
    expect(provider.npm).toBe("@ai-sdk/openai-compatible")
    expect(provider.api).toBe(`${DEFAULT_BASE}/v1`)
    expect(provider.models["muse-spark"]).toBeDefined()
    expect(provider.models["muse-spark"].tool_call).toBe(false)
    expect(provider.models["muse-spark"].modalities).toEqual({
      input: ["text"],
      output: ["text"],
    })
  })

  test("provider.models 只保留 muse-spark", async () => {
    const hook = buildProviderHook()
    const fallback = { models: { "muse-spark": { name: "Muse Spark" } } }
    const out = await hook.models(fallback, {
      auth: { type: "api", key: mock.apiKey, metadata: { baseUrl: mock.url } },
    })
    expect(Object.keys(out)).toEqual(["muse-spark"])
    expect(out["muse-spark"].name).toBe("Muse Spark")
  })

  test("provider.models 在服务不可用时回退到静态列表", async () => {
    const hook = buildProviderHook()
    const fallback = { models: { "muse-spark": { name: "Muse Spark" } } }
    const out = await hook.models(fallback, {
      auth: { type: "api", key: "x", metadata: { baseUrl: "http://127.0.0.1:1" } },
    })
    expect(Object.keys(out)).toEqual(["muse-spark"])
  })

  test("provider.models 在不是 api 登录时原样返回", async () => {
    const hook = buildProviderHook()
    const fallback = { models: { "muse-spark": { name: "Muse Spark" } } }
    const out = await hook.models(fallback, { auth: { type: "oauth" } })
    expect(out).toBe(fallback.models)
  })
})

describe("auth 钩子", () => {
  test("authorize 用 /v1/models 校验并保存 baseUrl", async () => {
    const auth = buildAuthHook()
    const ok = await auth.authorize({ baseUrl: `${mock.url}/`, apiKey: mock.apiKey })
    expect(ok.type).toBe("success")
    expect(ok.key).toBe(mock.apiKey)
    expect(ok.metadata.baseUrl).toBe(mock.url)
  })

  test("authorize 对错误 key 失败", async () => {
    const auth = buildAuthHook()
    const bad = await auth.authorize({ baseUrl: mock.url, apiKey: "wrong" })
    expect(bad.type).toBe("failed")
    expect(String(bad.error)).toContain("401")
  })

  test("authorize 对连不上的地址失败", async () => {
    const auth = buildAuthHook()
    const bad = await auth.authorize({ baseUrl: "http://127.0.0.1:1", apiKey: "x" })
    expect(bad.type).toBe("failed")
  })

  test("authorize 拒绝非法 URL 与非 http 协议", async () => {
    const auth = buildAuthHook()
    const validate = auth.methods[0].prompts[0].validate
    expect(validate("not a url")).toBeTruthy()
    expect(validate("file:///etc/passwd")).toBeTruthy()
    expect(validate("http://127.0.0.1:18610")).toBeUndefined()
    expect(validate("https://muse.example.com")).toBeUndefined()
  })

  test("loader 返回带 /v1 的 baseURL", async () => {
    const auth = buildAuthHook()
    const out = await auth.loader(async () => ({
      type: "api",
      key: "k",
      metadata: { baseUrl: "http://host:18610/" },
    }))
    expect(out).toEqual({ baseURL: "http://host:18610/v1", apiKey: "k" })
  })
})

describe("工具配置来源", () => {
  test("优先级：options > magpie.option > 环境变量", () => {
    cleanupEnv()
    process.env.MUSE2API_BASE_URL = "http://env:1"
    process.env.MUSE2API_KEY = "env"

    expect(resolveConfig({ options: { baseUrl: "http://opt:1/", apiKey: "opt" } })).toEqual({
      baseUrl: "http://opt:1",
      apiKey: "opt",
    })

    const viaMagpie = resolveConfig({
      input: {
        magpie: {
          option: (key) => (key === "baseUrl" ? "http://magpie:1" : "magpie"),
        },
      },
    })
    expect(viaMagpie).toEqual({ baseUrl: "http://magpie:1", apiKey: "magpie" })

    expect(resolveConfig({})).toEqual({ baseUrl: "http://env:1", apiKey: "env" })
    cleanupEnv()
  })

  test("未配置时工具给出可操作的提示", async () => {
    cleanupEnv()
    const tool = makeToolDefinitions({})
    const out = await tool.generate_image.execute({ prompt: "x" }, {})
    expect(out).toBe(missingConfigText())
    expect(out).toContain("MUSE2API_BASE_URL")
    const video = await tool.video_status.execute({ task_id: "x" }, {})
    expect(video).toBe(missingConfigText())
  })
})

describe("图片工具", () => {
  const defs = () =>
    makeToolDefinitions({ options: { baseUrl: mock.url, apiKey: mock.apiKey } })

  test("generate_image 一律异步，返回 task_id", async () => {
    const out = JSON.parse(
      await defs().generate_image.execute(
        { prompt: "a cat on a sofa", size: "1024x1024", aspect_ratio: "1:1" },
        {},
      ),
    )
    expect(out.task_id).toMatch(/^img_/)
    expect(out.status).toBe("queued")

    const sent = mock.state.imagePosts.at(-1)
    expect(sent.async).toBe(true)
    expect(sent.model).toBe("muse-image")
    expect(sent.size).toBe("1024x1024")
    expect(sent.aspect_ratio).toBe("1:1")
  })

  test("generate_image 把参考图一起提交", async () => {
    await defs().generate_image.execute(
      { prompt: "restyle", reference_images: ["https://example.com/a.png"] },
      {},
    )
    const sent = mock.state.imagePosts.at(-1)
    expect(sent.images).toEqual(["https://example.com/a.png"])
  })

  test("image_status 轮询到完成并返回可直接打开的 URL", async () => {
    const task = JSON.parse(await defs().generate_image.execute({ prompt: "dog" }, {}))
    const out = JSON.parse(
      await defs().image_status.execute({ task_id: task.task_id, wait_seconds: 10 }, {}),
    )
    expect(out.status).toBe("completed")
    expect(out.url).toContain("/v1/media/img_")
    expect(out.revised_prompt).toBe("dog")
  })

  test("image_status 对不存在的任务报错", async () => {
    const out = JSON.parse(await defs().image_status.execute({ task_id: "nope", wait_seconds: 1 }, {}))
    expect(out.error).toContain("404")
  })

  test("鉴权失败时给出 401 文案", async () => {
    const bad = makeToolDefinitions({ options: { baseUrl: mock.url, apiKey: "bad" } })
    const out = await bad.generate_image.execute({ prompt: "x" }, {})
    expect(String(out)).toContain("401")
  })
})

describe("视频工具", () => {
  const defs = () =>
    makeToolDefinitions({ options: { baseUrl: mock.url, apiKey: mock.apiKey } })

  test("generate_video 立即返回 task_id，video_status 完成时给 URL", async () => {
    const task = JSON.parse(
      await defs().generate_video.execute(
        { prompt: "ocean wave", duration: 5, aspect_ratio: "16:9" },
        {},
      ),
    )
    expect(task.task_id).toMatch(/^vid_/)
    const sent = mock.state.videoPosts.at(-1)
    expect(sent.model).toBe("muse-video")
    expect(sent.duration).toBe(5)

    const out = JSON.parse(await defs().video_status.execute({ task_id: task.task_id }, {}))
    expect(out.status).toBe("completed")
    expect(out.url).toContain("/v1/media/vid_")
  })
})

describe("工具形态与辅助函数", () => {
  test("toJsonSchema 标记 required 与 additionalProperties", () => {
    const schema = toolsInternal.toJsonSchema({
      prompt: { type: "string", required: true, description: "p" },
      refs: { type: "array", items: { type: "string" } },
    })
    expect(schema.type).toBe("object")
    expect(schema.required).toEqual(["prompt"])
    expect(schema.additionalProperties).toBe(false)
    expect(schema.properties.refs.items).toEqual({ type: "string" })
  })

  test("buildTools 在拿不到 SDK 时退回 JSON Schema 形态", async () => {
    const built = await buildTools({ options: { baseUrl: mock.url, apiKey: mock.apiKey } })
    expect(Object.keys(built).sort()).toEqual([
      "generate_image",
      "generate_video",
      "image_status",
      "video_status",
    ])
    const args = built.generate_image.args
    // 有 SDK 时是 zod 字段表，没有时是 JSON Schema；两种都合法。
    const isJsonSchema = args?.type === "object"
    const isZodFields = args && typeof args === "object" && "prompt" in args
    expect(isJsonSchema || isZodFields).toBe(true)
    expect(typeof built.generate_image.execute).toBe("function")
  })

  test("normalizeRefs 把本地图片转成 data URL", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muse2api-"))
    const file = join(dir, "a.png")
    await writeFile(file, Buffer.from("89504e470d0a1a0a", "hex"))
    const refs = await toolsInternal.normalizeRefs([file, "https://example.com/b.jpg", "  "])
    expect(refs).toHaveLength(2)
    expect(refs[0]).toStartWith("data:image/png;base64,")
    expect(refs[1]).toBe("https://example.com/b.jpg")
  })
})

describe("插件入口", () => {
  test("Muse2ApiPlugin 返回 config/auth/provider/tool 四个钩子", async () => {
    const hooks = await Muse2ApiPlugin(
      { client: { app: { log: () => {} } }, magpie: { option: () => undefined } },
      { baseUrl: mock.url, apiKey: mock.apiKey },
    )
    expect(typeof hooks.config).toBe("function")
    expect(hooks.auth.provider).toBe("muse2api")
    expect(hooks.provider.id).toBe("muse2api")
    expect(Object.keys(hooks.tool).sort()).toEqual([
      "generate_image",
      "generate_video",
      "image_status",
      "video_status",
    ])
  })
})
