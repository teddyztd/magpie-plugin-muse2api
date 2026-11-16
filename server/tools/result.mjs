/**
 * 工具返回值只有两种形态，都必须是合法 JSON 字符串：
 * 成功 { ok: true, ... }，失败 { ok: false, status, error, ... }。
 * 宿主把对象转 JSON 发给模型，这里显式 stringify 保证新行可读、字段稳定。
 */
export function okJson(obj) {
  return JSON.stringify({ ok: true, ...obj }, null, 2)
}

export function failJson({ status = "failed", error, ...rest }) {
  return JSON.stringify({ ok: false, status, error, ...rest }, null, 2)
}
