# DISKDASH

纯静态网盘控制台：前端跑在 **Cloudflare Pages**，后端逻辑全部交给 **Cloudflare Worker + KV**，零服务器。

## 目录结构

    .
    ├─ wrangler.toml        # Worker 配置（定时任务 / KV 绑定 / 环境变量）
    ├─ src/index.ts         # Worker：Fetch 路由、Scheduled 抓取、Cache API、CORS
    ├─ public/index.html    # 前端仪表盘（内联 CSS + JS，工业暗黑风）
    ├─ package.json
    └─ tsconfig.json

## 数据流

    Cron 03:00 UTC ─► collectAll() ─► Promise.allSettled(4 个数据源)
                                  └► STATS_KV.put('stats_data', json)

    浏览器 ─► GET /api/stats ─► Cache API(5min) ─命中─► 返回
                                     └─未命中─► KV ─► 写缓存 ─► 返回

## 四个数据源

| 模块 | 获取方式 | 失败表现 |
| --- | --- | --- |
| R2 存储容量 | 跨账户 API Token 调 Cloudflare GraphQL Analytics `r2StorageAdaptiveGroups` | 卡片显示 `DEGRADED` |
| R2 操作额度 | 同一个 Token 调 `r2OperationsAdaptiveGroups`，本月按 Class A / B 汇总已用与余额 | 只该区块显示 N/A，不影响 R2 存储 |
| ImgHub / Infinicloud | 二者是同一个 WebDAV：`PROPFIND` 读取 `quota-used-bytes` / `quota-available-bytes` | 显示 N/A |
| OpenList | `GET /api/admin/storage/list`，只取挂载点名 | 挂载区显示 source error |

> R2 使用**跨账户 API Token**：`R2_ACCOUNT_ID` 是要查询的账号 ID，`R2_API_TOKEN` 是具备该账号
> Account Analytics Read 权限的 Token，二者均从 Worker 环境变量读取；GraphQL 请求头由 Worker
> 手动写入 `Authorization: Bearer <R2_API_TOKEN>`。

## 部署步骤

### 1. 安装依赖

    npm install

### 2. 创建 KV 命名空间

    npx wrangler kv namespace create STATS_KV

把输出的 `id` 和 `preview_id` 填进 `wrangler.toml` 的 `[[kv_namespaces]]`。

### 3. 写入密钥（不要写进 wrangler.toml）

    npx wrangler secret put R2_API_TOKEN        # 跨账户 Token，权限：Account Analytics Read
    npx wrangler secret put IMGHUB_API_KEY
    npx wrangler secret put OPENLIST_TOKEN

### 4. 修改 wrangler.toml 里的占位符

所有 `YOUR_...` 都要替换，重点是：

- `ALLOWED_ORIGIN`：你的 Pages 域名（可多个，逗号分隔）
- `R2_ACCOUNT_ID` / `R2_BUCKET_NAME` / `R2_TOTAL_CAPACITY` / `R2_CLASS_A_LIMIT` / `R2_CLASS_B_LIMIT`
- `IMGHUB_WEBDAV_URL` / `IMGHUB_PROXY_URL`
- `OPENLIST_BASE_URL`

### 5. 部署 Worker

    npx wrangler deploy

### 6. 首次填充 KV

定时任务要到凌晨 3 点才跑，先手动触发一次：

    curl -X POST https://YOUR_WORKER_URL/api/refresh

### 7. 部署前端到 Pages

把 `public/` 作为 Pages 的构建输出目录（Framework preset 选 None，输出目录填 `public`），
或直接：

    npx wrangler pages deploy public --project-name=YOUR_PROJECT

最后把 `public/index.html` 里的 `CONFIG.API_BASE` 改成你的 Worker 地址。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/stats` | 边缘缓存 5 分钟，未命中读 KV |
| POST | `/api/refresh` | 手动刷新，KV 记录 `last_refresh_time`，5 分钟冷却（超限返回 429 + `Retry-After`）|
| GET | `/api/proxy/openlist` | 注入 `OPENLIST_TOKEN` 反向代理 |
| GET | `/api/proxy/imghub` | 注入 `IMGHUB_API_KEY` 反向代理 |
| GET | `/api/health` | 健康检查 |

### 关于 OpenList 代理

`OPENLIST_PROXY_MODE = "proxy"`（默认）时，Worker 会携带 Token 拉取后台页面并原样返回。
因为后台是 SPA，页面内的相对资源路径不会被改写，可能显示不完整。
如果只是想让浏览器跳到 OpenList 原生后台，把该值改成 `"redirect"`（此时无法注入 Token）。

## 安全说明

采用**纯 CORS 防御**：Worker 校验 `Origin` 头是否命中 `ALLOWED_ORIGIN` 白名单。
没有 `Origin` 的非浏览器请求（curl）会放行——防君子不防小人。
如果需要真正的访问控制，请在此基础上加 Cloudflare Access。

## 本地开发

    npx wrangler dev        # Worker: http://localhost:8787
    npx tsc --noEmit        # 类型检查

前端可以起任意静态服务器指向 `public/`，并把 `API_BASE` 指向 `http://localhost:8787`。
注意本地调试时 `Origin` 需要加进 `ALLOWED_ORIGIN`。

## 部署排错：Unexpected token 'export'

如果部署后面板报：

    Uncaught SyntaxError: Unexpected token 'export' at diskdash-worker:20

说明**上传的是未打包的 `src/index.ts` 原文**（第 20 行正好是 `export interface Env`），
被当成 classic（service worker）脚本解析了。只有 module worker 才允许顶层 `export`。

正确做法是用 wrangler 打包部署（wrangler 会自动剥离类型并输出 ESM）：

    npm install
    npx wrangler deploy

自查：部署成功后，面板里 Worker 代码开头应是 `var __defProp = ...`，结尾是
`export { ... src_default as default };`，而不是 `export interface`。

如果只能通过面板粘贴代码，先本地打包，再粘贴 `dist/index.js` 的内容：

    npm run build
