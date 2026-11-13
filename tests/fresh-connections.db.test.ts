// Go-live fix (13 Nov 2026): a fresh connection per file; a dropped connection is retried once
// (after its old session is ended), a second drop stops the run, other errors are not retried.
import { describe, expect, it } from 'vitest';
import { freshConnections, isDropped } from '../scripts/lib/db.ts';
import { assertLocal, LOCAL_CMS_OWNER_URL } from '../scripts/local-bootstrap.ts';

assertLocal(LOCAL_CMS_OWNER_URL);
const drop = () => Object.assign(new Error('write ECONNRESET'), { code: 'ECONNRESET' });

describe('freshConnections', () => {
  it('classifies dropped connections', () => {
    expect(isDropped(drop())).toBe(true);
    expect(isDropped(Object.assign(new Error('x'), { code: 'CONNECTION_CLOSED' }))).toBe(true);
    expect(isDropped(new Error('watchdog: no answer for 10 min'))).toBe(true);
    expect(isDropped(Object.assign(new Error('duplicate key'), { code: '23505' }))).toBe(false);
  });
  it('retries a dropped file once on a new connection (the old session is ended first)', async () => {
    const logs: string[] = []; const pids: number[] = [];
    const run = freshConnections({ url: LOCAL_CMS_OWNER_URL, log: (s) => logs.push(s) });
    let n = 0;
    const r = await run('file A', async (sql) => {
      pids.push(Number((await sql`select pg_backend_pid() as p`)[0]!.p));
      if (++n === 1) throw drop();
      return 'imported';
    });
    expect(r).toBe('imported');
    expect(pids).toHaveLength(2);
    expect(pids[0]).not.toBe(pids[1]);
    expect(logs.join('\n')).toMatch(/connection dropped .*retrying once/);
  });
  it('a second drop stops; an ordinary error is not retried', async () => {
    const run = freshConnections({ url: LOCAL_CMS_OWNER_URL, log: () => {} });
    await expect(run('file B', async () => { throw drop(); })).rejects.toThrow(/dropped again/);
    let calls = 0;
    await expect(run('file C', async () => { calls++; throw new Error('a real import error'); })).rejects.toThrow('a real import error');
    expect(calls).toBe(1);
  });
  it('the watchdog turns a silent hang into a drop', async () => {
    const run = freshConnections({ url: LOCAL_CMS_OWNER_URL, log: () => {}, watchdogMs: 300 });
    let calls = 0;
    const r = await run('file D', async () => { calls++; if (calls === 1) await new Promise((res) => setTimeout(res, 2000)); return 'ok'; });
    expect([r, calls]).toEqual(['ok', 2]);
  });
});
