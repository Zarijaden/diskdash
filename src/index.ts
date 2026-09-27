/**
 * ============================================================================
 *  DiskDash Worker — Cloudflare 边缘后端
 * ----------------------------------------------------------------------------
 *  职责：
 *   1. 定时（每日 03:00 UTC）通过 Promise.allSettled 并行抓取 4 个数据源，
 *      拼装成统一 StatsData 并写入 KV。
 *   2. GET  /api/stats           读 Cache API（5 分钟）-> 回源 KV
 *   3. POST /api/refresh         手动刷新（KV 记录 last_refresh_time 防连点）
 *   4. GET  /api/proxy/openlist  代理并注入 Token
 *   5. GET  /api/proxy/imghub    代理并注入 Key
 *   6. 纯 CORS 防御：校验 Origin 头是否在 ALLOWED_ORIGIN 白名单内。
 * ============================================================================
 */

/* ===========================================================================
 * 1. 类型定义
 * ========================================================================= */

export interface Env {
  /** KV：保存最近一次抓取的 StatsData */
  STATS_KV: KVNamespace;

  /** 【必填】允许跨域的 Pages 源，多个用英文逗号分隔 */
  ALLOWED_ORIGIN: string;

  /* ---- R2 存储容量（跨账户 API Token）---- */
  R2_ACCOUNT_ID: string;
  R2_BUCKET_NAME: string;
  /** R2 总配额，支持 "100GB" / "1TB" / 纯字节数；为空则无法计算百分比 */
  R2_TOTAL_CAPACITY?: string;
  /** 每月免费额度：Class A，默认 1000000 */
  R2_CLASS_A_LIMIT?: string;
  /** 每月免费额度：Class B，默认 10000000 */
  R2_CLASS_B_LIMIT?: string;

  /* ---- ImgHub / Infinicloud（同一套 WebDAV）---- */
  IMGHUB_WEBDAV_URL?: string;
  IMGHUB_PROXY_URL?: string;

  /* ---- OpenList ---- */
  OPENLIST_BASE_URL?: string;
  /** proxy（默认）| redirect */
  OPENLIST_PROXY_MODE?: string;

  /* ---- Secrets：用 wrangler secret put 写入，不要放进 wrangler.toml ---- */
  R2_API_TOKEN?: string;
  IMGHUB_API_KEY?: string;
  OPENLIST_TOKEN?: string;
}

/** 通用容量模块 */
export interface QuotaStats {
  usedBytes: number | null;
  totalBytes: number | null;
  /** 0 - 100，无法计算时为 null */
  usagePercent: number | null;
  /** 抓取失败原因；null 表示成功 */
  error: string | null;
}

export interface R2StorageStats extends QuotaStats {
  objectCount: number | null;
}

/** R2 操作计费类别：Class A / Class B / 免费 / 文档未列出 */
export type R2OpClass = 'A' | 'B' | 'free' | 'other';

/** 某一类的已用额度与余额 */
export interface R2OpQuota {
  used: number;
  limit: number;
  remaining: number;
  /** 0 - 100 */
  percentage: number;
}

export interface R2OpAction {
  action: string;
  requests: number;
  opClass: R2OpClass;
}

/** R2 操作额度（本月累计，账号级） */
export interface R2OperationsStats {
  periodStart: string | null;
  periodEnd: string | null;
  classA: R2OpQuota | null;
  classB: R2OpQuota | null;
  /** 免费操作（DeleteObject / AbortMultipartUpload 等）本月请求数 */
  freeRequests: number | null;
  byAction: R2OpAction[];
  error: string | null;
}

export interface MountPoint {
  name: string;
  status: 'online' | 'error';
}

export interface OpenListStats {
  mounts: MountPoint[];
  error: string | null;
}

/** 前端消费的统一数据结构 */
export interface StatsData {
  updatedAt: string | null;
  r2Storage: R2StorageStats;
  r2Operations: R2OperationsStats;
  imghub: QuotaStats;
  openlist: OpenListStats;
}

/* ===========================================================================
 * 2. 常量
 * ========================================================================= */

const STATS_KEY = 'stats_data';
const REFRESH_KEY = 'last_refresh_time';

/** Cache API 边缘缓存有效期（秒） */
const CACHE_TTL_SECONDS = 300;
/** 手动刷新冷却时间（毫秒） */
const REFRESH_COOLDOWN_MS = 5 * 60 * 1000;
/** 单个外部请求超时（毫秒） */
const FETCH_TIMEOUT_MS = 10_000;
const JSON_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json; charset=utf-8',
};

/**
 * R2 操作分类，来源：https://developers.cloudflare.com/r2/pricing/
 * 文档未列出的 actionType 归入 other，不计入 A / B 额度。
 */
const R2_CLASS_A_ACTIONS = new Set<string>([
  'ListBuckets', 'PutBucket', 'ListObjects', 'PutObject', 'CopyObject',
  'CompleteMultipartUpload', 'CreateMultipartUpload', 'LifecycleStorageTierTransition',
  'ListMultipartUploads', 'UploadPart', 'UploadPartCopy', 'ListParts',
  'PutBucketEncryption', 'PutBucketCors', 'PutBucketLifecycleConfiguration',
]);
const R2_CLASS_B_ACTIONS = new Set<string>([
  'HeadBucket', 'HeadObject', 'GetObject', 'UsageSummary',
  'GetBucketEncryption', 'GetBucketLocation', 'GetBucketCors',
  'GetBucketLifecycleConfiguration',
]);
const R2_FREE_ACTIONS = new Set<string>([
  'DeleteObject', 'DeleteBucket', 'AbortMultipartUpload',
]);

const DEFAULT_R2_CLASS_A_LIMIT = 1_000_000;
const DEFAULT_R2_CLASS_B_LIMIT = 10_000_000;

/* ===========================================================================
 * 3. 通用工具
 * ========================================================================= */

function nowIso(): string {
  return new Date().toISOString();
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.name === 'AbortError' ? 'timeout' : error.message;
  }
  return String(error);
}

/** 安全数字转换：非法/空值一律返回 null */
function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

const SIZE_UNITS: Record<string, number> = {
  b: 1,
  kb: 1024,
  mb: 1024 * 1024,
  gb: 1024 * 1024 * 1024,
  tb: 1024 * 1024 * 1024 * 1024,
  pb: 1024 * 1024 * 1024 * 1024 * 1024,
};

/** 把 "100GB" / "1.5TB" / 10737418240 解析为字节数 */
function parseCapacity(input?: string | number | null): number | null {
  if (input === null || input === undefined || input === '') return null;
  if (typeof input === 'number') return Number.isFinite(input) ? input : null;
  const matched = /^\s*([0-9]*\.?[0-9]+)\s*([a-z]*)\s*$/i.exec(String(input));
  if (!matched) return null;
  const value = parseFloat(matched[1]);
  if (!Number.isFinite(value)) return null;
  const unit = (matched[2] || 'b').toLowerCase();
  const multiplier = SIZE_UNITS[unit] !== undefined ? SIZE_UNITS[unit] : SIZE_UNITS[unit + 'b'];
  if (multiplier === undefined) return null;
  return Math.round(value * multiplier);
}

/** 计算使用率（0 - 100），无法计算返回 null */
function usagePercent(used: number | null, total: number | null): number | null {
  if (used === null || total === null || total <= 0) return null;
  return Math.min(100, Math.max(0, (used / total) * 100));
}

/** 解析正整数上限，非法或 <= 0 时回退默认值 */
function parseCount(input: string | undefined, fallback: number): number {
  const parsed = num(input);
  return parsed !== null && parsed > 0 ? parsed : fallback;
}

function classifyR2Action(action: string): R2OpClass {
  if (R2_CLASS_A_ACTIONS.has(action)) return 'A';
  if (R2_CLASS_B_ACTIONS.has(action)) return 'B';
  if (R2_FREE_ACTIONS.has(action)) return 'free';
  return 'other';
}

function buildOpQuota(used: number, limit: number): R2OpQuota {
  return {
    used,
    limit,
    remaining: Math.max(0, limit - used),
    percentage: limit > 0 ? Math.min(100, (used / limit) * 100) : 0,
  };
}

/** 当前自然月（UTC）区间 */
function currentMonthRange(now: Date = new Date()): { start: string; end: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
  return { start: start.toISOString(), end: now.toISOString() };
}

/** N 天前的 ISO 时间 */
function isoDaysAgo(days: number, now: Date = new Date()): string {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

/** 读取 WebDAV XML 中的数字属性（例如 quota-used-bytes），避免引入 XML 解析库 */
function readXmlNumber(xml: string, tag: string): number | null {
  const pattern = new RegExp('<' + '[^>]*' + tag + '[^>]*>' + '([^<]*)' + '<', 'i');
  const matched = pattern.exec(xml);
  return matched ? num(matched[1].trim()) : null;
}

/** 带超时的 fetch */
async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(text, { status, headers: { ...JSON_HEADERS, ...headers } });
}

function settle<T>(result: PromiseSettledResult<T>, fallback: () => T): T {
  return result.status === 'fulfilled' ? result.value : fallback();
}

/* ===========================================================================
 * 4. CORS —— 纯 Origin 白名单防御
 * ========================================================================= */

function allowedOrigins(env: Env): string[] {
  return (env.ALLOWED_ORIGIN || '')
    .split(',')
    .map((item) => item.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

/**
 * 命中白名单才回写 Access-Control-Allow-Origin。
 * 没有 Origin 头的请求（curl / 定时任务 / 同域）视为非浏览器请求放行，
 * 但不会附带 CORS 头 —— 防君子不防小人。
 */
function isOriginAllowed(origin: string | null, env: Env): boolean {
  if (!origin) return true;
  return allowedOrigins(env).includes(origin.replace(/\/+$/, ''));
}

function corsHeaders(origin: string | null, env: Env): Record<string, string> {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (origin && allowedOrigins(env).includes(origin.replace(/\/+$/, ''))) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

/* ===========================================================================
 * 5. 数据源抓取器
 *    每个函数都自行 catch，绝不 throw，失败时只把对应字段置空。
 * ========================================================================= */

function emptyR2Storage(totalBytes: number | null = null): R2StorageStats {
  return { usedBytes: null, totalBytes, usagePercent: null, objectCount: null, error: null };
}

function emptyQuota(): QuotaStats {
  return { usedBytes: null, totalBytes: null, usagePercent: null, error: null };
}

function emptyOps(): R2OperationsStats {
  return {
    periodStart: null,
    periodEnd: null,
    classA: null,
    classB: null,
    freeRequests: null,
    byAction: [],
    error: null,
  };
}

/**
 * 5.1 R2 存储容量 —— Cloudflare GraphQL Analytics API
 *     使用 r2StorageAdaptiveGroups 取最近 7 天内最新一条的 payloadSize / objectCount。
 *     时间字段以官方文档为准用 datetime；若该字段在 schema 里不存在，
 *     会自动回退到旧版的 date 再试一次，避免整块失效。
 *
 *     跨账户场景：R2 账号 ID 与 API Token 均从环境变量读取
 *     （R2_ACCOUNT_ID / R2_API_TOKEN），Token 来自有该账号
 *     Account Analytics Read 权限的账户。GraphQL 请求头需手动带上
 *     Authorization: Bearer <R2_API_TOKEN>，SDK/绑定不会代填。
 */
async function fetchR2Storage(env: Env): Promise<R2StorageStats> {
  const totalBytes = parseCapacity(env.R2_TOTAL_CAPACITY);
  const result = emptyR2Storage(totalBytes);

  if (!env.R2_API_TOKEN || !env.R2_ACCOUNT_ID || !env.R2_BUCKET_NAME) {
    result.error = 'missing_config';
    return result;
  }

  // 参数内联：Cloudflare schema 标量写作 string / Time，
  // 用变量声明容易因 String / string 大小写不匹配导致整条查询失败。
  const end = nowIso();
  const start = isoDaysAgo(7);

  // 时间字段在不同版本的 R2 schema 里叫 datetime 或 date：
  // 先用当前文档的 datetime，字段不存在会自动回退到旧版的 date。
  let lastError = 'no_analytics_data';
  for (const timeField of ['datetime', 'date'] as const) {
    try {
      const query =
        'query {' +
        '  viewer {' +
        '    accounts(filter: { accountTag: ' + JSON.stringify(env.R2_ACCOUNT_ID) + ' }) {' +
        '      r2StorageAdaptiveGroups(' +
        '        limit: 1' +
        '        filter: { ' + timeField + '_geq: ' + JSON.stringify(start) + ', ' + timeField + '_leq: ' + JSON.stringify(end) +
        ', bucketName: ' + JSON.stringify(env.R2_BUCKET_NAME) + ' }' +
        '        orderBy: [' + timeField + '_DESC]' +
        '      ) {' +
        '        max { payloadSize objectCount }' +
        '        dimensions { ' + timeField + ' }' +
        '      }' +
        '    }' +
        '  }' +
        '}';

      const response = await fetchWithTimeout('https://api.cloudflare.com/client/v4/graphql', {
        method: 'POST',
        headers: {
          // 手动注入跨账户 Token
          Authorization: 'Bearer ' + env.R2_API_TOKEN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query }),
      });

      if (!response.ok) throw new Error('graphql_http_' + response.status);

      const payload = (await response.json()) as {
        data?: { viewer?: { accounts?: Array<{ r2StorageAdaptiveGroups?: Array<{ max?: { payloadSize?: unknown; objectCount?: unknown } }> }> } };
        errors?: Array<{ message?: string }>;
      };

      if (Array.isArray(payload.errors) && payload.errors.length > 0) {
        throw new Error(payload.errors[0]?.message || 'graphql_error');
      }

      const groups = payload.data?.viewer?.accounts?.[0]?.r2StorageAdaptiveGroups;
      const latest = Array.isArray(groups) ? groups[0]?.max : undefined;
      if (!latest) {
        result.error = 'no_analytics_data';
        return result;
      }

      result.usedBytes = num(latest.payloadSize);
      result.objectCount = num(latest.objectCount);
      result.usagePercent = usagePercent(result.usedBytes, result.totalBytes);
      result.error = null;
      return result;
    } catch (error) {
      lastError = errorMessage(error);
    }
  }

  result.error = lastError;
  return result;
}

/**
 * 5.2 R2 操作额度 —— Cloudflare GraphQL Analytics API（r2OperationsAdaptiveGroups）
 *
 *     按官方文档取本月累计、账号级的操作请求数，按 actionType 汇总后归入
 *     Class A / Class B / Free 三类，再与每月免费额度相减算余额。
 *     免费额度：Class A 1,000,000 / Class B 10,000,000（可用环境变量覆盖）。
 *     参考：https://developers.cloudflare.com/r2/platform/metrics-analytics/
 *           https://developers.cloudflare.com/r2/pricing/
 *
 *     这里刻意不按 bucketName 过滤：免费额度是按账号计的，按桶过滤会低估用量。
 *     参数内联进 query，避开 Cloudflare schema 里 string / String 标量命名差异。
 */
async function fetchR2Operations(env: Env): Promise<R2OperationsStats> {
  const limitA = parseCount(env.R2_CLASS_A_LIMIT, DEFAULT_R2_CLASS_A_LIMIT);
  const limitB = parseCount(env.R2_CLASS_B_LIMIT, DEFAULT_R2_CLASS_B_LIMIT);
  const { start, end } = currentMonthRange();
  const result = emptyOps();
  result.periodStart = start;
  result.periodEnd = end;

  if (!env.R2_API_TOKEN || !env.R2_ACCOUNT_ID) {
    result.error = 'missing_config';
    return result;
  }

  const query =
    'query {' +
    '  viewer {' +
    '    accounts(filter: { accountTag: ' + JSON.stringify(env.R2_ACCOUNT_ID) + ' }) {' +
    '      r2OperationsAdaptiveGroups(' +
    '        limit: 10000' +
    '        filter: { datetime_geq: ' + JSON.stringify(start) + ', datetime_leq: ' + JSON.stringify(end) + ' }' +
    '      ) {' +
    '        sum { requests }' +
    '        dimensions { actionType }' +
    '      }' +
    '    }' +
    '  }' +
    '}';

  try {
    const response = await fetchWithTimeout('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + env.R2_API_TOKEN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query }),
    });

    if (!response.ok) throw new Error('graphql_http_' + response.status);

    const payload = (await response.json()) as {
      data?: { viewer?: { accounts?: Array<{ r2OperationsAdaptiveGroups?: Array<{ sum?: { requests?: unknown }; dimensions?: { actionType?: unknown } }> }> } };
      errors?: Array<{ message?: string }>;
    };

    if (Array.isArray(payload.errors) && payload.errors.length > 0) {
      throw new Error(payload.errors[0]?.message || 'graphql_error');
    }

    const groups = payload.data?.viewer?.accounts?.[0]?.r2OperationsAdaptiveGroups;
    const list = Array.isArray(groups) ? groups : [];

    let usedA = 0;
    let usedB = 0;
    let freeUsed = 0;

    for (const group of list) {
      const action = String(group?.dimensions?.actionType ?? 'unknown');
      const requests = num(group?.sum?.requests) ?? 0;
      const opClass = classifyR2Action(action);
      result.byAction.push({ action, requests, opClass });
      if (opClass === 'A') usedA += requests;
      else if (opClass === 'B') usedB += requests;
      else if (opClass === 'free') freeUsed += requests;
    }

    result.byAction.sort((left, right) => right.requests - left.requests);
    result.classA = buildOpQuota(usedA, limitA);
    result.classB = buildOpQuota(usedB, limitB);
    result.freeRequests = freeUsed;
    return result;
  } catch (error) {
    result.error = errorMessage(error);
    return result;
  }
}

/**
 * 5.3 ImgHub / Infinicloud (WebDAV) —— Infinicloud 就是同一套 WebDAV，合并为一个模块
 *     用 PROPFIND 读取 quota-used-bytes / quota-available-bytes 得到配额。
 *     实测（aki.teracloud.jp）：DAV 头为 "1, 2"，未声明 RFC 4331 的 quota 标记，
 *     两个配额属性均返回 404，allprop 也不含任何配额属性 —— 该 WebDAV 拿不到容量，
 *     此时返回 error = 'quota_property_not_supported'，前端显示「WEBDAV 无配额信息」。
 *     若要总配额，需改用 InfiniCLOUD REST API V2（X-TeraCLOUD-API-KEY）。
 *     所需 Secret：IMGHUB_API_KEY
 *     注意：不同服务端鉴权方式不同，若使用 Basic Auth，请改为
 *     'Basic ' + btoa(env.IMGHUB_USER + ':' + env.IMGHUB_API_KEY)
 */
async function fetchImghub(env: Env): Promise<QuotaStats> {
  const result = emptyQuota();
  const url = env.IMGHUB_WEBDAV_URL;
  if (!url) {
    result.error = 'missing_config';
    return result;
  }

  try {
    const headers: Record<string, string> = {
      Depth: '0',
      'Content-Type': 'application/xml; charset=utf-8',
    };
    if (env.IMGHUB_API_KEY) headers.Authorization = 'Bearer ' + env.IMGHUB_API_KEY;

    const response = await fetchWithTimeout(url, {
      method: 'PROPFIND',
      headers,
      body:
        '<?xml version="1.0" encoding="utf-8"?>' +
        '<d:propfind xmlns:d="DAV:"><d:prop>' +
        '<d:quota-used-bytes/><d:quota-available-bytes/>' +
        '</d:prop></d:propfind>',
    });

    if (!response.ok && response.status !== 207) {
      throw new Error('webdav_http_' + response.status);
    }

    const xml = await response.text();
    const used = readXmlNumber(xml, 'quota-used-bytes');
    const available = readXmlNumber(xml, 'quota-available-bytes');

    result.usedBytes = used;
    result.totalBytes = used !== null && available !== null && available >= 0 ? used + available : null;
    result.usagePercent = usagePercent(result.usedBytes, result.totalBytes);

    if (used === null && available === null) result.error = 'quota_property_not_supported';
    return result;
  } catch (error) {
    result.error = errorMessage(error);
    return result;
  }
}

/**
 * 5.4 OpenList —— 仅提取挂载点名称，不取容量、不取文件列表
 *     所需 Secret：OPENLIST_TOKEN（Alist / OpenList 的 Authorization 直接放 token）
 */
async function fetchOpenlist(env: Env): Promise<OpenListStats> {
  const result: OpenListStats = { mounts: [], error: null };
  if (!env.OPENLIST_BASE_URL) {
    result.error = 'missing_config';
    return result;
  }

  try {
    const url = env.OPENLIST_BASE_URL.replace(/\/+$/, '') + '/api/admin/storage/list';
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (env.OPENLIST_TOKEN) headers.Authorization = env.OPENLIST_TOKEN;

    const response = await fetchWithTimeout(url, { headers });
    if (!response.ok) throw new Error('openlist_http_' + response.status);

    const payload = (await response.json()) as {
      code?: number;
      message?: string;
      data?: { content?: unknown[] } | unknown[];
    };

    if (payload.code !== undefined && payload.code !== 200) {
      throw new Error(payload.message || 'openlist_code_' + payload.code);
    }

    let list: unknown[] = [];
    if (Array.isArray(payload.data)) list = payload.data;
    else if (payload.data && Array.isArray((payload.data as { content?: unknown[] }).content)) {
      list = (payload.data as { content: unknown[] }).content;
    }

    result.mounts = list.map((raw): MountPoint => {
      const item = raw as Record<string, unknown>;
      const rawStatus = item.status;
      const online = rawStatus === undefined || rawStatus === 'work' || rawStatus === 'working';
      return {
        name: String(item.mount_path || item.name || item.driver || 'unknown'),
        status: online ? 'online' : 'error',
      };
    });
    return result;
  } catch (error) {
    result.error = errorMessage(error);
    return result;
  }
}

/* ===========================================================================
 * 6. 聚合抓取
 * ========================================================================= */

export async function collectAll(env: Env): Promise<StatsData> {
  const [r2Storage, r2Operations, imghub, openlist] = await Promise.allSettled([
    fetchR2Storage(env),
    fetchR2Operations(env),
    fetchImghub(env),
    fetchOpenlist(env),
  ]);

  return {
    updatedAt: nowIso(),
    r2Storage: settle(r2Storage, () => ({ ...emptyR2Storage(parseCapacity(env.R2_TOTAL_CAPACITY)), error: 'source_crashed' })),
    r2Operations: settle(r2Operations, () => ({ ...emptyOps(), error: 'source_crashed' })),
    imghub: settle(imghub, () => ({ ...emptyQuota(), error: 'source_crashed' })),
    openlist: settle(openlist, () => ({ mounts: [], error: 'source_crashed' })),
  };
}

export async function collectAndStore(env: Env): Promise<StatsData> {
  const data = await collectAll(env);
  await env.STATS_KV.put(STATS_KEY, JSON.stringify(data));
  return data;
}

/* ===========================================================================
 * 7. API 处理
 * ========================================================================= */

function statsCacheKey(request: Request): Request {
  const url = new URL(request.url);
  url.pathname = '/api/stats';
  url.search = '';
  return new Request(url.toString(), { method: 'GET' });
}

function placeholderStats(): StatsData {
  return {
    updatedAt: null,
    r2Storage: emptyR2Storage(null),
    r2Operations: emptyOps(),
    imghub: emptyQuota(),
    openlist: { mounts: [], error: null },
  };
}

/** GET /api/stats —— 先查边缘缓存，未命中再读 KV 并回填缓存 */
async function handleStats(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const origin = request.headers.get('Origin');
  const cors = corsHeaders(origin, env);
  const cache = caches.default;
  const cacheKey = statsCacheKey(request);

  const cached = await cache.match(cacheKey);
  if (cached) {
    const body = await cached.text();
    return jsonResponse(body, 200, {
      ...cors,
      'X-Cache': 'HIT',
      'Cache-Control': 'public, max-age=' + CACHE_TTL_SECONDS,
    });
  }

  const raw = await env.STATS_KV.get(STATS_KEY);
  if (!raw) {
    // 首次部署、KV 尚无数据：返回占位数据，且不写缓存
    return jsonResponse(JSON.stringify(placeholderStats()), 200, {
      ...cors,
      'X-Cache': 'MISS',
      'Cache-Control': 'no-store',
    });
  }

  ctx.waitUntil(
    cache.put(
      cacheKey,
      new Response(raw, {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'public, max-age=' + CACHE_TTL_SECONDS,
          Vary: 'Origin',
        },
      }),
    ),
  );

  return jsonResponse(raw, 200, {
    ...cors,
    'X-Cache': 'MISS',
    'Cache-Control': 'public, max-age=' + CACHE_TTL_SECONDS,
  });
}

/** POST /api/refresh —— 5 分钟冷却，立即抓取、写 KV、刷新缓存 */
async function handleRefresh(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const origin = request.headers.get('Origin');
  const cors = corsHeaders(origin, env);

  const lastRaw = await env.STATS_KV.get(REFRESH_KEY);
  const last = lastRaw ? Number(lastRaw) : 0;
  const elapsed = Date.now() - last;

  if (last > 0 && elapsed < REFRESH_COOLDOWN_MS) {
    const retryAfter = Math.ceil((REFRESH_COOLDOWN_MS - elapsed) / 1000);
    return jsonResponse(
      { ok: false, error: 'rate_limited', retryAfter },
      429,
      { ...cors, 'Retry-After': String(retryAfter) },
    );
  }

  // 先落冷却时间，避免并发重复触发
  await env.STATS_KV.put(REFRESH_KEY, String(Date.now()));

  const data = await collectAndStore(env);

  // 主动覆盖边缘缓存，保证后续 /api/stats 立即拿到新数据
  const cache = caches.default;
  const cacheKey = statsCacheKey(request);
  ctx.waitUntil(
    cache.put(
      cacheKey,
      new Response(JSON.stringify(data), {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'public, max-age=' + CACHE_TTL_SECONDS,
          Vary: 'Origin',
        },
      }),
    ),
  );

  return jsonResponse({ ok: true, data }, 200, cors);
}

/** GET /api/proxy/openlist | /api/proxy/imghub —— 注入密钥后反向代理 */
async function handleProxy(
  kind: 'openlist' | 'imghub',
  request: Request,
  env: Env,
): Promise<Response> {
  const origin = request.headers.get('Origin');
  const cors = corsHeaders(origin, env);

  const target = kind === 'openlist' ? env.OPENLIST_BASE_URL : env.IMGHUB_PROXY_URL;
  if (!target) return jsonResponse({ error: 'proxy_not_configured' }, 501, cors);

  const mode = (env.OPENLIST_PROXY_MODE || 'proxy').toLowerCase();
  if (mode === 'redirect') {
    // 直接 302 到真实后台：浏览器会离开 Pages 源，Token 无法注入，
    // 仅适合后台自身已带登录态的场景。
    return new Response(null, { status: 302, headers: { ...cors, Location: target } });
  }

  const headers = new Headers();
  const accept = request.headers.get('Accept');
  if (accept) headers.set('Accept', accept);
  if (kind === 'openlist' && env.OPENLIST_TOKEN) headers.set('Authorization', env.OPENLIST_TOKEN);
  if (kind === 'imghub' && env.IMGHUB_API_KEY) {
    headers.set('Authorization', 'Bearer ' + env.IMGHUB_API_KEY);
  }

  try {
    const upstream = await fetchWithTimeout(target, { headers, redirect: 'follow' });
    const out = new Headers(upstream.headers);
    // 让运行时重新计算长度/编码
    out.delete('content-encoding');
    out.delete('content-length');
    for (const key of Object.keys(cors)) out.set(key, cors[key]);
    return new Response(upstream.body, { status: upstream.status, headers: out });
  } catch (error) {
    return jsonResponse({ error: 'proxy_failed', detail: errorMessage(error) }, 502, cors);
  }
}

/* ===========================================================================
 * 8. 入口
 * ========================================================================= */

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');

    // CORS 预检
    if (request.method === 'OPTIONS') {
      if (!isOriginAllowed(origin, env)) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: corsHeaders(origin, env) });
    }

    // Origin 白名单校验
    if (!isOriginAllowed(origin, env)) {
      return jsonResponse({ error: 'origin_not_allowed' }, 403, { Vary: 'Origin' });
    }

    if (url.pathname === '/api/stats' && request.method === 'GET') {
      return handleStats(request, env, ctx);
    }
    if (url.pathname === '/api/refresh' && request.method === 'POST') {
      return handleRefresh(request, env, ctx);
    }
    if (url.pathname === '/api/proxy/openlist' && request.method === 'GET') {
      return handleProxy('openlist', request, env);
    }
    if (url.pathname === '/api/proxy/imghub' && request.method === 'GET') {
      return handleProxy('imghub', request, env);
    }
    if (url.pathname === '/api/health') {
      return jsonResponse({ ok: true, time: nowIso() }, 200, corsHeaders(origin, env));
    }

    return jsonResponse({ error: 'not_found' }, 404, corsHeaders(origin, env));
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(collectAndStore(env).then(() => undefined));
  },
};
