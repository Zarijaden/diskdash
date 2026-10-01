// 最小回归检查：ImgHub 列表查询 -> 按渠道汇总字节
// 真实响应里 metadata.FileSize 是 MB 字符串，metadata.FileSizeBytes 是精确字节数
import assert from 'node:assert/strict';
import { fetchImghub } from '../src/index.ts';

const MB = 1024 * 1024;
const GB = 1024 * 1024 * 1024;
const env = {
  IMGHUB_API_BASE: 'https://imghub.test',
  IMGHUB_API_KEY: 'imgbed_test',
  IMGHUB_CHANNEL: 'infinicloud',
};

let listedUrl = '';
let listedHeaders = {};
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.includes('/api/manage/list')) {
    listedUrl = u;
    listedHeaders = init.headers || {};
    return new Response(JSON.stringify({
      files: [
        { name: 'a.jpg', metadata: { FileSize: '0.14', FileSizeBytes: 148502 } },
        { name: 'b.jpg', metadata: { FileSize: '4.06', FileSizeBytes: 4254218 } },
        { name: 'old.jpg', metadata: { FileSize: '1.00' } }, // 没 FileSizeBytes 时按 MB 兜底
      ],
      totalCount: 3,
      returnedCount: 3,
      isIndexedResponse: true,
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
assert.ok(listedUrl.includes('count=-1'), 'must request all files');
assert.ok(listedUrl.includes('recursive=true'), 'must recurse into subdirectories');
assert.ok(listedUrl.includes('channelName=infinicloud'), 'must filter by channel name');
assert.ok(listedHeaders['User-Agent'], 'must send a User-Agent (WAF)');
assert.equal(listedHeaders.Accept, '*/*');
assert.equal(out.usedBytes, 148502 + 4254218 + 1 * MB);
assert.equal(out.totalBytes, 20 * GB);
assert.equal(out.error, null);

// 上游 4xx：把 body 带进 error，便于在 KV / 日志里定位
globalThis.fetch = async () => new Response('{"error":"bad_request"}', { status: 400 });
const failed = await fetchImghub(env);
assert.equal(failed.error, 'imghub_list_400: {"error":"bad_request"}');

console.log('imghub ok');
