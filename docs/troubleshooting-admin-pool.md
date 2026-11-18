# 排查报告：muse2api 后台页「账号池看不到账号」

- 报告对象：`http://127.0.0.1:18610/`（muse2api 自带的账号池控制台，v1.6.11）
- 现象：API 已确认账号池里有 1 个账号，页面「账号总数 / 可用」仍显示 0
- 结论：**不是后端、缓存或路由问题；是页面本身没拿到 API Key，所有 `/admin/*` 请求都是 401**

## 一、证据链

### 1) API 侧一切正常

```
GET http://127.0.0.1:18610/admin/accounts   (Authorization: Bearer m2a_…)
→ 200 {"accounts":[{ "id":"8c3d8d1c3a9e", "label":"magpie 网页登录 2026/11/18 11:42:37",
        "cookie_count":8, "essential_ok":true, "ok":true }], "stats":{...}}
```

同一进程、同一时刻，页面却显示 0 → 说明页面发出的请求和这条不是同一种「带鉴权」的请求。

### 2) 页面自身的鉴权逻辑（内联 JS）

```js
let KEY = localStorage.getItem(KEY_STORE) || new URLSearchParams(location.search).get('key') || ''

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) }
  if (KEY) headers['Authorization'] = `Bearer ${KEY}`
  const res = await fetch(path, { ...opts, headers })
  if (res.status === 401) { setAuth(false); throw new Error('API Key 未填写或填写错误') }
  ...
}

async function loadPool() {
  const data = await api('/admin/accounts')   // KEY 为空 → 无 Authorization → 401
  ...
}
```

关键点：**KEY 为空时 `api()` 不会带 `Authorization` 头**，于是 `/admin/accounts`
一律 401，`loadPool()` 抛错，页面把 `#poolCount` 留在 0。

### 3) 页面也在提示这件事

用户当时那个标签页顶部有黄条：「需要先填入 API Key，页面才能读到数据」，
右上角输入框（placeholder「粘贴 m2a_ 开头的密钥」）为空。

### 4) 填入 key 后立刻正常

用 CUA 在页面里填入 `m2a_…` → 点右上「保存」→ 切到「账号池」：

```
服务 正常 | 账号 1 | 已登录 | 账号总数 1 | 可用 1 | 异常 0 | 已禁用 0 | 媒体文件 3
```

与 `/admin/accounts` 完全一致（截图：`E:\ZzTmp\mcp\admin-pool.png`）。

## 二、根因

页面是纯前端渲染：`loadPool()` 依赖 `api()`，而 `api()` 只在 `KEY` 非空时才加
`Authorization`。KEY 来自 `localStorage` 或 URL 上的 `?key=`，用户既没填也没带，
于是：

```
KEY = '' → api('/admin/accounts') 无 Authorization → 401 → loadPool 抛错 → 计数保持 0
```

后端 `/admin/accounts` 本身有 `Depends(auth)`，没问题；问题在「页面没带凭证」这一步。

## 三、处置

**不改上游代码**（保持 muse2api 语义不变），改为在插件文档里写清两种正确用法：

1. 打开页面后先在右上角填 `m2a_…` 并点「保存」（会写进 `localStorage`）；
2. 或者直接带参数打开：`http://127.0.0.1:18610/?key=<m2a_…>`。

已落在 `README.md` 的「故障排查」一节：

> 管理页账号池显示 0：页面需要先填 API Key。页面只在有 key 时才带 `Authorization`
> 调 `/admin/accounts`，否则全是 401。填入 key 或直接打开 `http://127.0.0.1:18610/?key=<m2a_…>`。

## 四、验证

| 检查 | 命令/操作 | 结果 |
|---|---|---|
| 后端账号池 | `curl -H "Authorization: Bearer m2a_…" /admin/accounts` | 1 条账号 |
| 页面未填 key | 打开 `http://127.0.0.1:18610/`（无 `?key=`、localStorage 为空） | 顶部黄条，账号池 0 |
| 页面填入 key | 页面右上填 key → 保存 → 账号池 | 账号总数 1 / 可用 1 |
| 页面带参 | 打开 `http://127.0.0.1:18610/?key=m2a_…` | 直接显示 1 条 |

## 五、遗留建议（可选，属于上游项目范畴）

若希望页面更友好，可在 `admin.html` 里把「未填 key 时账号池显示 0」改成显式空态文案
（如「未填写 API Key，无法读取账号池」）。本仓库只做封装，不修改上游文件；
如需，可向上游开 issue。
