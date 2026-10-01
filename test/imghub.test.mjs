// 最小回归检查：ImgHub 列表查询 -> 按渠道汇总字节（FileSize 是 MB，FileSizeBytes 是字节）
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
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/api/manage/list')) {
    listedUrl = u;
    return new Response(JSON.stringify({
      files: [
        { name: '2024/a.jpg', metadata: { FileSize: 1024 } }, // 1024 MB
        { name: 'b.jpg', metadata: { FileSizeBytes: 500 } },  // 500 B
      ],
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
assert.equal(out.usedBytes, 1024 * MB + 500);
assert.equal(out.totalBytes, 20 * GB);
assert.equal(out.usagePercent, ((1024 * MB + 500) / (20 * GB)) * 100);
assert.equal(out.error, null);

// 上游 4xx：把 body 带进 error，便于在 KV / 日志里定位
globalThis.fetch = async () => new Response('{"error":"bad_request"}', { status: 400 });
const failed = await fetchImghub(env);
assert.equal(failed.error, 'imghub_list_400: {"error":"bad_request"}');

console.log('imghub ok');
