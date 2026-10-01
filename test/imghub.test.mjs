// 最小回归检查：ImgHub 渠道容量解析（usedMB 是 MB，quota.limitGB 是 GB）
import assert from 'node:assert/strict';
import { fetchImghub } from '../src/index.ts';

const MB = 1024 * 1024;
const GB = 1024 * 1024 * 1024;
const env = {
  IMGHUB_API_BASE: 'https://imghub.test',
  IMGHUB_API_KEY: 'imgbed_test',
  IMGHUB_CHANNEL: 'infinicloud',
};

globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('sum=true')) return new Response('{}', { status: 200 });
  if (u.includes('index-storage-stats')) {
    return new Response(JSON.stringify({
      metadata: { channelStats: { infinicloud: { usedMB: 1536, fileCount: 3 }, r2: { usedMB: 10, fileCount: 1 } } },
    }), { status: 200 });
  }
  if (u.includes('sysConfig/upload')) {
    return new Response(JSON.stringify({
      webdav: { channels: [{ name: 'infinicloud', quota: { enabled: true, limitGB: 20 } }] },
    }), { status: 200 });
  }
  throw new Error('unexpected request: ' + u);
};

const out = await fetchImghub(env);
assert.equal(out.usedBytes, 1536 * MB);
assert.equal(out.totalBytes, 20 * GB);
assert.equal(out.usagePercent, ((1536 * MB) / (20 * GB)) * 100);
assert.equal(out.error, null);

// 渠道不存在时报 channel_not_found，且不抛异常
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('index-storage-stats')) {
    return new Response(JSON.stringify({ metadata: { channelStats: {} } }), { status: 200 });
  }
  return new Response('{}', { status: 200 });
};
const missing = await fetchImghub(env);
assert.equal(missing.usedBytes, null);
assert.equal(missing.error, 'channel_not_found');

// 上游 4xx：把 body 带进 error，便于在 KV / 日志里定位
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('index-storage-stats')) {
    return new Response('{"error":"bad_request","message":"invalid action"}', { status: 400 });
  }
  return new Response('{}', { status: 200 });
};
const failed = await fetchImghub(env);
assert.equal(failed.error, 'imghub_list_400: {"error":"bad_request","message":"invalid action"}');

console.log('imghub ok');
