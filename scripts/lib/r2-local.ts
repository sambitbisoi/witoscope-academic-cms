// Local stand-in for the R2 bucket cms-sources (dev only): a folder, git-ignored.
// Implements the same Bucket interface the Pages Function uses.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Bucket } from '../../functions/_lib/files.ts';

export const LOCAL_R2_DIR = resolve(import.meta.dirname, '..', '..', '.r2-local', 'cms-sources');

export class FolderBucket implements Bucket {
  constructor(private root = LOCAL_R2_DIR) {}
  private path(key: string) {
    const p = resolve(this.root, key);
    if (!p.startsWith(this.root + '/')) throw new Error('key escapes the bucket');
    return p;
  }
  async get(key: string) {
    const p = this.path(key);
    if (!existsSync(p)) return null;
    const meta = existsSync(`${p}.meta.json`) ? JSON.parse(readFileSync(`${p}.meta.json`, 'utf8')) : {};
    const body = readFileSync(p);
    return { body: new Uint8Array(body), httpMetadata: { contentType: meta.contentType }, size: body.byteLength };
  }
  async put(key: string, body: ReadableStream | ArrayBuffer | Uint8Array, opts: { httpMetadata: { contentType: string } }) {
    const p = this.path(key);
    mkdirSync(dirname(p), { recursive: true });
    const bytes = body instanceof Uint8Array ? body : new Uint8Array(body instanceof ArrayBuffer ? body : await new Response(body).arrayBuffer());
    writeFileSync(p, bytes);
    writeFileSync(`${p}.meta.json`, JSON.stringify({ contentType: opts.httpMetadata.contentType }));
  }
  has(key: string) { const p = this.path(key); return existsSync(p) ? statSync(p).size : 0; }
}

export const localKeyPath = (key: string) => join(LOCAL_R2_DIR, key);
