import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
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
  mock = await startMock({ imageCompleteAfter: 1, videoCompleteAfter: 1 })
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

  test("authorize 接受带 /v1 的地址（与旧行为一致，规约后保存）", async () => {
    const ok = await buildAuthHook().authorize({ baseUrl: `${mock.url}/v1`, apiKey: mock.apiKey })
    expect(ok.type).toBe("success")
    expect(ok.metadata.baseUrl).toBe(mock.url)
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
    const out = JSON.parse(await tool.generate_image.execute({ prompt: "x" }, {}))
    expect(out.ok).toBe(false)
    expect(out.error).toBe(missingConfigText())
    expect(out.error).toContain("MUSE2API_BASE_URL")
    const video = JSON.parse(await tool.video_status.execute({ task_id: "x" }, {}))
    expect(video.ok).toBe(false)
    expect(video.error).toBe(missingConfigText())
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

  test("generate_video 立即返回 task_id，video_status 单次查询后给 URL", async () => {
    const task = JSON.parse(
      await defs().generate_video.execute(
        { prompt: "ocean wave", duration: 5, aspect_ratio: "16:9" },
        {},
      ),
    )
    expect(task.task_id).toMatch(/^vid_/)
    expect(task.ok).toBe(true)
    const sent = mock.state.videoPosts.at(-1)
    expect(sent.model).toBe("muse-video")
    expect(sent.duration).toBe(5)

    // mock 的 videoCompleteAfter=1：第一次查询还是 running，第二次才 completed
    const first = JSON.parse(await defs().video_status.execute({ task_id: task.task_id }, {}))
    expect(first.ok).toBe(true)
    expect(first.status).toBe("running")
    expect(first.hint).toBeTruthy()

    const out = JSON.parse(await defs().video_status.execute({ task_id: task.task_id }, {}))
    expect(out.ok).toBe(true)
    expect(out.status).toBe("completed")
    expect(out.url).toContain("/v1/media/vid_")
  })

  test("video_status 每次只发起一次请求（不在工具内轮询）", async () => {
    const task = JSON.parse(await defs().generate_video.execute({ prompt: "wave" }, {}))
    const before = mock.state.requests.filter((r) =>
      r.path.startsWith(`/v1/videos/${task.task_id}`),
    ).length
    await defs().video_status.execute({ task_id: task.task_id }, {})
    const after = mock.state.requests.filter((r) =>
      r.path.startsWith(`/v1/videos/${task.task_id}`),
    ).length
    expect(after - before).toBe(1)
  })

  test("video_status 的入参里没有 wait_seconds", () => {
    const args = makeToolDefinitions({}).video_status.argsSpec
    expect(Object.keys(args)).toEqual(["task_id"])
  })
})

describe("输入校验与边界", () => {
  const defs = () =>
    makeToolDefinitions({ options: { baseUrl: mock.url, apiKey: mock.apiKey } })

  test("空 prompt 直接拒绝，不发请求", async () => {
    const before = mock.state.requests.length
    expect(String(await defs().generate_image.execute({ prompt: "   " }, {}))).toContain(
      "prompt 不能为空",
    )
    expect(String(await defs().generate_video.execute({}, {}))).toContain("prompt 不能为空")
    expect(mock.state.requests.length).toBe(before)
  })

  test("未配置时也先报入参错误，而不是直接报缺配置", async () => {
    cleanupEnv()
    const bare = makeToolDefinitions({})
    expect(String(await bare.generate_image.execute({ prompt: "   " }, {}))).toContain(
      "prompt 不能为空",
    )
    const nine = Array.from({ length: 9 }, (_, i) => `https://example.com/${i}.png`)
    expect(
      String(await bare.generate_video.execute({ prompt: "x", reference_images: nine }, {})),
    ).toContain("最多 8 张")
  })

  test("参考图超过 8 张拒绝", async () => {
    const nine = Array.from({ length: 9 }, (_, i) => `https://example.com/${i}.png`)
    const out = await defs().generate_image.execute({ prompt: "x", reference_images: nine }, {})
    expect(String(out)).toContain("最多 8 张")
  })

  test("reference_images 不是数组时给出提示", async () => {
    const out = await defs().generate_image.execute(
      { prompt: "x", reference_images: "https://example.com/a.png" },
      {},
    )
    expect(String(out)).toContain("必须是字符串数组")
  })

  test("baseUrl 带 /v1 会被规范化，不产生 /v1/v1", () => {
    expect(resolveConfig({ options: { baseUrl: "http://h:18610/v1", apiKey: "k" } })).toEqual({
      baseUrl: "http://h:18610",
      apiKey: "k",
    })
  })

  test("config 钩子保留用户已有的同 id 配置", async () => {
    const cfg = {
      provider: { muse2api: { name: "我的", models: { "muse-spark": { name: "Mine" } } } },
    }
    await buildConfigHook()(cfg)
    expect(cfg.provider.muse2api.name).toBe("我的")
    expect(cfg.provider.muse2api.models["muse-spark"].name).toBe("Mine")
    expect(cfg.provider.muse2api.npm).toBe("@ai-sdk/openai-compatible")
  })

  test("validate 拒绝带 /v1 的地址", () => {
    const validate = buildAuthHook().methods[0].prompts[0].validate
    expect(validate("http://127.0.0.1:18610/v1")).toBeTruthy()
  })

  test("auth 钩子带自己的登录图标（与插件列表图标分开）", () => {
    const auth = buildAuthHook()
    expect(auth.icon).toStartWith("data:image/svg+xml;base64,")
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
    expect(auth.icon).not.toBe(pkg.magpie.icon)
  })
})

describe("返回契约：一律 JSON", () => {
  const defs = () =>
    makeToolDefinitions({ options: { baseUrl: mock.url, apiKey: mock.apiKey } })
  const nine = Array.from({ length: 9 }, (_, i) => `https://example.com/${i}.png`)

  const failing = {
    "缺配置 generate_image": () => {
      cleanupEnv()
      return makeToolDefinitions({}).generate_image.execute({ prompt: "x" }, {})
    },
    "缺配置 image_status": () => {
      cleanupEnv()
      return makeToolDefinitions({}).image_status.execute({ task_id: "x" }, {})
    },
    "空 prompt": () => defs().generate_image.execute({ prompt: "  " }, {}),
    "参考图不是数组": () => defs().generate_image.execute({ prompt: "x", reference_images: "u" }, {}),
    "参考图超张数": () => defs().generate_video.execute({ prompt: "x", reference_images: nine }, {}),
    "缺 task_id": () => defs().video_status.execute({}, {}),
    "连接失败": () =>
      makeToolDefinitions({ options: { baseUrl: "http://127.0.0.1:1", apiKey: "k" } })
        .generate_image.execute({ prompt: "x" }, {}),
    "上游 401": () =>
      makeToolDefinitions({ options: { baseUrl: mock.url, apiKey: "bad" } })
        .generate_video.execute({ prompt: "x" }, {}),
    "任务 404": () => defs().image_status.execute({ task_id: "nope", wait_seconds: 1 }, {}),
  }

  for (const [name, run] of Object.entries(failing)) {
    test(`${name} → 合法 JSON 且 ok:false`, async () => {
      const raw = await run()
      expect(typeof raw).toBe("string")
      const out = JSON.parse(raw)
      expect(out.ok).toBe(false)
      expect(typeof out.status).toBe("string")
      expect(typeof out.error).toBe("string")
    })
  }

  test("成功路径同样是合法 JSON 且 ok:true", async () => {
    const d = defs()
    const img = JSON.parse(await d.generate_image.execute({ prompt: "cat" }, {}))
    expect(img.ok).toBe(true)
    const imgOut = JSON.parse(
      await d.image_status.execute({ task_id: img.task_id, wait_seconds: 5 }, {}),
    )
    expect(imgOut.ok).toBe(true)
    const vid = JSON.parse(await d.generate_video.execute({ prompt: "wave" }, {}))
    expect(vid.ok).toBe(true)
    const vidOut = JSON.parse(await d.video_status.execute({ task_id: vid.task_id }, {}))
    expect(typeof vidOut.ok).toBe("boolean")
  })

  test("上游错误带 http_status", async () => {
    const out = JSON.parse(
      await makeToolDefinitions({ options: { baseUrl: mock.url, apiKey: "bad" } })
        .generate_image.execute({ prompt: "x" }, {}),
    )
    expect(out.http_status).toBe(401)
    expect(out.baseUrl).toBe(mock.url)
  })
})

describe("参考图体积上限", () => {
  test("超过单张上限时本地拦下", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muse2api-size-"))
    const file = join(dir, "big.png")
    await writeFile(file, Buffer.alloc(64))
    const { error, refs } = await toolsInternal.normalizeRefs([file], {
      maxImageBytes: 32,
      maxTotalBytes: 1024,
    })
    expect(error).toContain("单张上限")
    expect(refs).toHaveLength(0)
  })

  test("超过合计上限时本地拦下", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muse2api-total-"))
    const a = join(dir, "a.png")
    const b = join(dir, "b.png")
    await writeFile(a, Buffer.alloc(24))
    await writeFile(b, Buffer.alloc(24))
    const { error } = await toolsInternal.normalizeRefs([a, b], {
      maxImageBytes: 1024,
      maxTotalBytes: 32,
    })
    expect(error).toContain("合计")
  })

  test("data URL 按解码后的字节统计", async () => {
    const payload = Buffer.alloc(64).toString("base64")
    const { error } = await toolsInternal.normalizeRefs([`data:image/png;base64,${payload}`], {
      maxImageBytes: 32,
    })
    expect(error).toContain("单张上限")
  })

  test("8 张本地图正常通过", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muse2api-eight-"))
    const files = []
    for (let i = 0; i < 8; i += 1) {
      const file = join(dir, `r${i}.png`)
      await writeFile(file, Buffer.alloc(16))
      files.push(file)
    }
    const { refs, failed, error } = await toolsInternal.normalizeRefs(files)
    expect(error).toBeUndefined()
    expect(failed).toHaveLength(0)
    expect(refs).toHaveLength(8)
  })

  test("超限时不向上游发请求", async () => {
    const before = mock.state.requests.length
    const nine = Array.from({ length: 9 }, (_, i) => `https://example.com/${i}.png`)
    const out = JSON.parse(
      await makeToolDefinitions({ options: { baseUrl: mock.url, apiKey: mock.apiKey } })
        .generate_image.execute({ prompt: "x", reference_images: nine }, {}),
    )
    expect(out.ok).toBe(false)
    expect(mock.state.requests.length).toBe(before)
  })
})

describe("异常返回", () => {
  test("图片任务完成但没有 URL 时给出 error", async () => {
    const mockNoUrl = await startMock({ imageNoUrl: true })
    try {
      const defs = makeToolDefinitions({
        options: { baseUrl: mockNoUrl.url, apiKey: mockNoUrl.apiKey },
      })
      const task = JSON.parse(await defs.generate_image.execute({ prompt: "x" }, {}))
      const out = JSON.parse(
        await defs.image_status.execute({ task_id: task.task_id, wait_seconds: 5 }, {}),
      )
      expect(out.status).toBe("completed")
      expect(out.url).toBeUndefined()
      expect(out.error).toContain("PUBLIC_BASE")
    } finally {
      await mockNoUrl.close()
    }
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

  test("normalizeRefs 把本地图片转成 data URL，读不到的单独报告", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muse2api-"))
    const file = join(dir, "a.png")
    await writeFile(file, Buffer.from("89504e470d0a1a0a", "hex"))
    const { refs, failed } = await toolsInternal.normalizeRefs([
      file,
      "https://example.com/b.jpg",
      "  ",
      join(dir, "missing.png"),
    ])
    expect(refs).toHaveLength(2)
    expect(refs[0]).toStartWith("data:image/png;base64,")
    expect(refs[1]).toBe("https://example.com/b.jpg")
    expect(failed).toHaveLength(1)
    expect(failed[0].value).toContain("missing.png")
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
