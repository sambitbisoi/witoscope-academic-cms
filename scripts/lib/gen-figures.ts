// Q38 PR 1: where generated figures go. Always the local R2 stand-in (.r2-local/cms-sources, as the other importers);
// for the real project also the real bucket cms-sources with wrangler (Sambit's Cloudflare login), read back and
// compared (size + sha256) before the batch that references it is written. Keys only under figures/, PNG only.
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { FolderBucket, localKeyPath as localPath } from './r2-local.ts';
import type { FigureStore } from './gen-pack.ts';

const KEY = /^figures\/[A-Za-z0-9._-]+\.png$/;
const sha = (b: Buffer | Uint8Array) => createHash('sha256').update(b).digest('hex');

export class LocalFigures implements FigureStore {
  constructor(private bucket = new FolderBucket()) {}
  async ensure(key: string, bytes: Buffer) {
    if (!KEY.test(key)) throw new Error(`refused figure key ${key} (only figures/<name>.png)`);
    const got = await this.bucket.get(key);
    if (got && sha(got.body as Uint8Array) === sha(bytes)) return 'present' as const;
    if (got) throw new Error(`${key} already holds a different file; keys are never overwritten`);
    await this.bucket.put(key, bytes, { httpMetadata: { contentType: 'image/png' } });
    return 'uploaded' as const;
  }
}

export class RealFigures implements FigureStore {
  private local = new LocalFigures();
  private get(key: string) {
    return new Promise<Buffer | null>((res) => execFile('npx', ['wrangler', 'r2', 'object', 'get', `cms-sources/${key}`, '--remote', '--pipe'],
      { encoding: 'buffer', maxBuffer: 60 * 1024 * 1024 }, (err, out) => res(err ? null : out as Buffer)));
  }
  async ensure(key: string, bytes: Buffer) {
    await this.local.ensure(key, bytes);
    const before = await this.get(key);
    if (before && before.length === bytes.length && sha(before) === sha(bytes)) return 'present' as const;
    if (before && before.length) throw new Error(`${key} already holds a different file in R2; keys are never overwritten`);
    const put = () => execFileSync('npx', ['wrangler', 'r2', 'object', 'put', `cms-sources/${key}`, '--file', localPath(key), '--content-type', 'image/png', '--remote'],
      { stdio: ['ignore', 'ignore', 'pipe'] });
    try { put(); } catch { await new Promise((r) => setTimeout(r, 5000)); put(); }
    const after = (await this.get(key)) ?? (await this.get(key));
    if (!after || after.length !== bytes.length || sha(after) !== sha(bytes)) throw new Error(`${key}: uploaded, but reading it back from R2 does not match (size/sha256); stopped before the batch`);
    return 'uploaded' as const;
  }
}
