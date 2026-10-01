/**
 * ============================================================================
 *  DiskDash Worker — Cloudflare 边缘后端
 * ----------------------------------------------------------------------------
 *  职责：
 *   1. 定时（每日 03:00 UTC）通过 Promise.allSettled 并行抓取 3 个数据源，
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

  /* ---- R2 用量 API（一个接口同时返回存储 + 操作）---- */
  /** 用量接口地址，默认 https://r2usage.zpbk.cc.cd/api */
  R2_USAGE_API_URL?: string;
  /** 兜底：接口没返回 totalBytes 时用它算百分比，支持 "100GB" / 纯字节数 */
  R2_TOTAL_CAPACITY?: string;
  /** 每月免费额度：Class A，默认 1000000 */
  R2_CLASS_A_LIMIT?: string;
  /** 每月免费额度：Class B，默认 10000000 */
  R2_CLASS_B_LIMIT?: string;

  /* ---- ImgHub / Infinicloud（走 ImgHub 管理 API，按渠道聚合）---- */
  /** ImgHub 实例根地址，例如 https://zpbk.cc.cd；缺省时取 IMGHUB_PROXY_URL 的 origin */
  IMGHUB_API_BASE?: string;
  /** ImgHub 里承载 InfiniCLOUD 的渠道名（ChannelName），默认 infinicloud */
  IMGHUB_CHANNEL?: string;
  /** 兜底总配额：ImgHub 渠道未配置 quota 时使用，支持 "20GB" / 纯字节数 */
  INFINICLOUD_TOTAL_CAPACITY?: string;
  /** ImgHub 后台地址，/api/proxy/imghub 代理跳转的目标 */
  IMGHUB_PROXY_URL?: string;

  /* ---- OpenList ---- */
  OPENLIST_BASE_URL?: string;
  /** proxy（默认）| redirect */
  OPENLIST_PROXY_MODE?: string;

  /* ---- Secrets：用 wrangler secret put 写入，不要放进 wrangler.toml ---- */
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

/** 单桶存储明细（来自用量接口的 REST 逐桶统计） */
export interface R2BucketUsage {
  name: string;
  usedBytes: number | null;
  objectCount: number | null;
}

export interface R2StorageStats extends QuotaStats {
  objectCount: number | null;
  /** 快照时间，REST 实时统计的时刻 */
  snapshotAt: string | null;
  /** 数据来源标记，例如 "rest_api" */
  source: string | null;
  /** 桶数量 */
  bucketCount: number | null;
  /** 逐桶明细 */
  buckets: R2BucketUsage[];
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
  /** 数据来源标记，例如 "graphql" */
  source: string | null;
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

const DEFAULT_R2_USAGE_API_URL = 'https://r2usage.zpbk.cc.cd/api';
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
  return { usedBytes: null, totalBytes, usagePercent: null, objectCount: null, snapshotAt: null, source: null, bucketCount: null, buckets: [], error: null };
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
    source: null,
    error: null,
  };
}

/**
 * 5.1 R2 用量 —— 自家用量接口，一次返回存储容量 + 操作额度。
 *
 *     GET https://r2usage.zpbk.cc.cd/api
 *     {
 *       "month": "2026-09",
 *       "operations": { "classA": 281, "classB": 325, "total": 606, "source": "graphql" },
 *       "storage": {
 *         "usedBytes": 584972225, "usedGB": 0.5448,
 *         "totalBytes": 10737418240, "totalGB": 10,
 *         "usagePercent": 5.448, "snapshotAt": "2026-09-27T07:33:17.029Z",
 *         "source": "rest_api", "bucketCount": 3,
 *         "buckets": [
 *           { "name": "bkr2", "payloadBytes": 525205324, "metadataBytes": 667,
 *             "usedBytes": 525205991, "objectCount": 26 }
 *         ]
 *       },
 *       "fetchedAt": "2026-09-27T07:33:17.029Z"
 *     }
 *
 *     存储来自 REST 逐桶实时统计，操作数来自 GraphQL（约 24h 延迟）。
 *     两者共用一个请求，封装成一个函数同时返回，失败时各自标记 error。
 */
interface R2UsageBundle {
  storage: R2StorageStats;
  operations: R2OperationsStats;
}

async function fetchR2Usage(env: Env): Promise<R2UsageBundle> {
  const totalFallback = parseCapacity(env.R2_TOTAL_CAPACITY);
  const limitA = parseCount(env.R2_CLASS_A_LIMIT, DEFAULT_R2_CLASS_A_LIMIT);
  const limitB = parseCount(env.R2_CLASS_B_LIMIT, DEFAULT_R2_CLASS_B_LIMIT);
  const url = env.R2_USAGE_API_URL || DEFAULT_R2_USAGE_API_URL;

  const storage = emptyR2Storage(totalFallback);
  const operations = emptyOps();
  const range = currentMonthRange();
  operations.periodStart = range.start;
  operations.periodEnd = range.end;

  try {
    const response = await fetchWithTimeout(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'diskdash-worker/1.0' },
    });
    if (!response.ok) throw new Error('r2usage_http_' + response.status);

    const payload = (await response.json()) as {
      month?: unknown;
      fetchedAt?: unknown;
      operations?: { classA?: unknown; classB?: unknown; total?: unknown; source?: unknown };
      storage?: {
        usedBytes?: unknown;
        totalBytes?: unknown;
        usagePercent?: unknown;
        snapshotAt?: unknown;
        source?: unknown;
        bucketCount?: unknown;
        buckets?: Array<{ name?: unknown; usedBytes?: unknown; objectCount?: unknown }>;
      };
    };

    // ---- 存储容量（REST 逐桶实时统计）----
    const usedBytes = num(payload.storage?.usedBytes);
    const totalBytes = num(payload.storage?.totalBytes) ?? totalFallback;
    storage.usedBytes = usedBytes;
    storage.totalBytes = totalBytes;
    storage.usagePercent = usagePercent(usedBytes, totalBytes);
    if (storage.usagePercent === null) {
      // 接口自带的百分比只在自己算不出来时兜底
      storage.usagePercent = num(payload.storage?.usagePercent);
    }
    if (usedBytes === null && totalBytes === null) storage.error = 'unexpected_payload';

    storage.snapshotAt = typeof payload.storage?.snapshotAt === 'string' ? payload.storage.snapshotAt : null;
    storage.source = typeof payload.storage?.source === 'string' ? payload.storage.source : null;
    storage.bucketCount = num(payload.storage?.bucketCount);

    const rawBuckets = Array.isArray(payload.storage?.buckets) ? payload.storage.buckets : [];
    storage.buckets = rawBuckets.map((bucket) => ({
      name: String(bucket?.name ?? 'unknown'),
      usedBytes: num(bucket?.usedBytes),
      objectCount: num(bucket?.objectCount),
    }));

    // 顶层没有 objectCount，用逐桶明细求和补上
    const objectCounts = storage.buckets
      .map((bucket) => bucket.objectCount)
      .filter((value): value is number => value !== null);
    storage.objectCount = objectCounts.length > 0
      ? objectCounts.reduce((sum, value) => sum + value, 0)
      : null;

    // ---- 操作额度（GraphQL，约 24h 延迟）----
    const usedA = num(payload.operations?.classA) ?? 0;
    const usedB = num(payload.operations?.classB) ?? 0;
    operations.classA = buildOpQuota(usedA, limitA);
    operations.classB = buildOpQuota(usedB, limitB);
    operations.freeRequests = null;
    operations.byAction = [];
    operations.source = typeof payload.operations?.source === 'string' ? payload.operations.source : null;
    if (typeof payload.month === 'string' && /^\d{4}-\d{2}$/.test(payload.month)) {
      operations.periodStart = payload.month + '-01T00:00:00.000Z';
      operations.periodEnd = typeof payload.fetchedAt === 'string' ? payload.fetchedAt : nowIso();
    }

    return { storage, operations };
  } catch (error) {
    const message = errorMessage(error);
    storage.error = message;
    operations.error = message;
    return { storage, operations };
  }
}

/** ImgHub 管理 API 根地址：优先 IMGHUB_API_BASE，缺省取 IMGHUB_PROXY_URL 的 origin */
function imghubBase(env: Env): string | null {
  const raw = (env.IMGHUB_API_BASE || env.IMGHUB_PROXY_URL || '').trim();
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

/** 读出错响应的 body（截断成一行）并打日志，同时把它拼进 error，便于在 KV / wrangler tail 定位 4xx */
async function imghubError(label: string, response: Response): Promise<string> {
  let detail = '';
  try {
    detail = (await response.text()).replace(/\s+/g, ' ').trim().slice(0, 300);
  } catch {
    /* body 读不出来就算了 */
  }
  console.error('[imghub] ' + label + ' HTTP ' + response.status + (detail ? ' body=' + detail : ''));
  return 'imghub_' + label + '_' + response.status + (detail ? ': ' + detail : '');
}

/**
 * 5.3 ImgHub / Infinicloud —— 走 ImgHub 管理 API 按渠道聚合，不再连 WebDAV。
 *
 *     GET /api/manage/list?action=index-storage-stats
 *     -> metadata.channelStats = { infinicloud: { usedMB, fileCount }, ... }，单位 MB
 *
 *     读取前先打一次 count=-1&sum=true，让 ImgHub 合并挂起操作并重算 channelStats。
 *     已用容量取该渠道；总配额优先取渠道配置里的 quota.limitGB，取不到再退回
 *     INFINICLOUD_TOTAL_CAPACITY。所需 Secret：IMGHUB_API_KEY（list + manage 权限）。
 */
export async function fetchImghub(env: Env): Promise<QuotaStats> {
  const result = emptyQuota();
  const base = imghubBase(env);
  const channel = (env.IMGHUB_CHANNEL || 'infinicloud').trim();
  if (!base || !env.IMGHUB_API_KEY) {
    result.error = 'missing_config';
    return result;
  }

  const auth = { Authorization: 'Bearer ' + env.IMGHUB_API_KEY, Accept: 'application/json' };
  const listUrl = (query: string) => base + '/api/manage/list?' + query;

  try {
    // 触发一次索引合并，保证 channelStats 含最新上传；失败不阻断读取
    try {
      const warmup = await fetchWithTimeout(listUrl('count=-1&sum=true'), { headers: auth });
      if (!warmup.ok) await imghubError('warmup', warmup);
    } catch {
      /* best-effort */
    }

    const statsResponse = await fetchWithTimeout(listUrl('action=index-storage-stats'), { headers: auth });
    if (!statsResponse.ok) throw new Error(await imghubError('list', statsResponse));
    const payload = (await statsResponse.json()) as {
      metadata?: { channelStats?: Record<string, { usedMB?: unknown }> };
    };
    const channelStats = payload.metadata?.channelStats;
    const key = channelStats
      ? Object.keys(channelStats).find((name) => name.toLowerCase() === channel.toLowerCase())
      : undefined;
    const usedMB = key && channelStats ? num(channelStats[key]?.usedMB) : null;
    result.usedBytes = usedMB === null ? null : Math.round(usedMB * 1024 * 1024);

    result.totalBytes = parseCapacity(env.INFINICLOUD_TOTAL_CAPACITY);
    if (result.totalBytes === null) result.totalBytes = await fetchImghubChannelCapacity(base, auth, channel);

    result.usagePercent = usagePercent(result.usedBytes, result.totalBytes);
    if (result.usedBytes === null) result.error = 'channel_not_found';
    return result;
  } catch (error) {
    result.error = errorMessage(error);
    return result;
  }
}

/** 读 ImgHub 渠道配置里的总配额（webdav.channels[].quota.limitGB）；读不到返回 null */
async function fetchImghubChannelCapacity(
  base: string,
  auth: Record<string, string>,
  channel: string,
): Promise<number | null> {
  try {
    const response = await fetchWithTimeout(base + '/api/manage/sysConfig/upload', { headers: auth });
    if (!response.ok) {
      await imghubError('capacity', response);
      return null;
    }
    const payload = (await response.json()) as {
      webdav?: { channels?: Array<{ name?: unknown; quota?: { limitGB?: unknown } }> };
    };
    const match = (payload.webdav?.channels || []).find(
      (item) => String(item?.name ?? '').toLowerCase() === channel.toLowerCase(),
    );
    const limitGB = num(match?.quota?.limitGB);
    return limitGB !== null && limitGB > 0 ? Math.round(limitGB * 1024 * 1024 * 1024) : null;
  } catch {
    return null;
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
  const [r2Usage, imghub, openlist] = await Promise.allSettled([
    fetchR2Usage(env),
    fetchImghub(env),
    fetchOpenlist(env),
  ]);

  const usage = settle(r2Usage, () => ({
    storage: { ...emptyR2Storage(parseCapacity(env.R2_TOTAL_CAPACITY)), error: 'source_crashed' },
    operations: { ...emptyOps(), error: 'source_crashed' },
  }));

  return {
    updatedAt: nowIso(),
    r2Storage: usage.storage,
    r2Operations: usage.operations,
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
