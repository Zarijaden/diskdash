// 最小回归检查：ImgHub 递归遍历目录 -> 按 ChannelName 过滤 -> 累加 FileSizeBytes
import assert from 'node:assert/strict';
import { fetchImghub } from '../src/index.ts';

const MB = 1024 * 1024;
const GB = 1024 * 1024 * 1024;
const env = {
  IMGHUB_API_BASE: 'https://imghub.test',
  IMGHUB_API_KEY: 'imgbed_test',
  IMGHUB_CHANNEL: 'infinicloud',
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

// 1) 递归：root -> new -> new/deep，跨目录汇总，大小写不敏感过滤
const listUrls = [];
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/api/manage/list')) {
    listUrls.push(u);
    const dir = new URL(u).searchParams.get('dir') || '';
    if (dir === '') {
      return json({
        files: [
          { name: 'root-r2.jpg', metadata: { ChannelName: 'R2_env', FileSizeBytes: 999 } },
          { name: 'root-a.jpg', metadata: { ChannelName: 'infinicloud', FileSizeBytes: 148502 } },
        ],
        directories: ['new'],
      });
    }
    if (dir === 'new') {
      return json({
        files: [{ name: 'new/b.jpg', metadata: { ChannelName: 'Infinicloud', FileSizeBytes: 4254218 } }],
        directories: ['new/deep'],
      });
    }
    if (dir === 'new/deep') {
      return json({
        files: [{ name: 'new/deep/c.jpg', metadata: { ChannelName: 'infinicloud', FileSize: '1.00' } }],
        directories: [],
      });
    }
    throw new Error('unexpected dir: ' + dir);
  }
  if (u.includes('sysConfig/upload')) {
    return json({ webdav: { channels: [{ name: 'infinicloud', quota: { enabled: true, limitGB: 20 } }] } });
  }
  throw new Error('unexpected request: ' + u);
};

const out = await fetchImghub(env);
assert.equal(listUrls.length, 3, 'one request per directory');
for (const u of listUrls) {
  assert.ok(u.includes('count=-1'));
  assert.ok(!u.includes('recursive'), 'must not use recursive');
  assert.ok(!u.includes('channelName'), 'must not use channelName');
}
assert.ok(!listUrls[0].includes('dir='), 'root request omits empty dir');
assert.ok(listUrls[1].includes('dir=new'));
assert.ok(listUrls[2].includes('dir=new%2Fdeep'));
assert.equal(out.usedBytes, 148502 + 4254218 + 1 * MB);
assert.equal(out.totalBytes, 20 * GB);
assert.equal(out.error, null);

// 2) 深度限制 5：最多 6 次请求（第 0..5 层）
let depthCalls = 0;
globalThis.fetch = async () => {
  depthCalls++;
  return json({
    files: [{ metadata: { ChannelName: 'infinicloud', FileSizeBytes: 1 } }],
    directories: ['d' + depthCalls],
  });
};
const deep = await fetchImghub({ ...env, INFINICLOUD_TOTAL_CAPACITY: '20GB' });
assert.equal(depthCalls, 6, 'depth limit 5 => 6 requests');
assert.equal(deep.usedBytes, 6);

// 3) 上游 4xx：body 带进 error，便于在 KV / 日志里定位
globalThis.fetch = async () => new Response('{"error":"bad_request"}', { status: 400 });
const failed = await fetchImghub(env);
assert.equal(failed.error, 'imghub_400: {"error":"bad_request"}');

console.log('imghub ok');
