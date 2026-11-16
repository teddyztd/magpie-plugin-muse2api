import { IMAGE_MODEL, MAX_REFERENCE_IMAGES, VIDEO_MODEL } from "../config.mjs"

// args 只描述一次；有 SDK 时转成 zod，没有时用 JSON Schema（文档两者都接受）。
export const IMAGE_GEN_ARGS = {
  prompt: { type: "string", required: true, description: "图片描述（越具体越好）" },
  size: { type: "string", description: "尺寸，例如 1024x1024；不填由上游决定" },
  aspect_ratio: { type: "string", description: "宽高比，例如 1:1、16:9、9:16" },
  reference_images: {
    type: "array",
    items: { type: "string" },
    description: `参考图（最多 ${MAX_REFERENCE_IMAGES} 张，单张 ≤40 MiB、合计 ≤100 MiB）：http(s) URL 或本地文件路径（本地文件会转 data URL），用于图生图`,
  },
  model: { type: "string", description: `模型，默认 ${IMAGE_MODEL}` },
  extra: { type: "string", description: "附加提示词" },
}

export const IMAGE_STATUS_ARGS = {
  task_id: { type: "string", required: true, description: "generate_image 返回的 task_id" },
  wait_seconds: { type: "number", description: "最多等待秒数，默认 40，上限 40" },
}

export const VIDEO_GEN_ARGS = {
  prompt: { type: "string", required: true, description: "视频描述（画面、镜头、动作）" },
  duration: { type: "number", description: "时长（秒），不填由上游决定" },
  aspect_ratio: { type: "string", description: "宽高比，例如 16:9、9:16" },
  size: { type: "string", description: "分辨率，例如 1280x720" },
  reference_images: {
    type: "array",
    items: { type: "string" },
    description: `首帧/参考图（最多 ${MAX_REFERENCE_IMAGES} 张，单张 ≤40 MiB、合计 ≤100 MiB）：http(s) URL 或本地文件路径`,
  },
  model: { type: "string", description: `模型，默认 ${VIDEO_MODEL}` },
}

export const VIDEO_STATUS_ARGS = {
  task_id: { type: "string", required: true, description: "generate_video 返回的 task_id" },
}

export function toJsonSchema(spec) {
  const properties = {}
  const required = []
  for (const [key, value] of Object.entries(spec)) {
    const { required: isRequired, ...rest } = value
    properties[key] = rest
    if (isRequired) required.push(key)
  }
  return { type: "object", properties, required, additionalProperties: false }
}

export function toZod(spec, schema) {
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
