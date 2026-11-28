// Q38 PR 3 (0052): dry runs take no numbers; the key registry. Against THIS repo's local database, rolled back.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import { connect } from '../scripts/lib/db.ts';
import { assertLocal, LOCAL_CMS_GEN_WRITER_URL, LOCAL_CMS_OWNER_URL, LOCAL_CMS_READER_URL } from '../scripts/local-bootstrap.ts';

assertLocal(LOCAL_CMS_OWNER_URL);
const sql = connect(LOCAL_CMS_OWNER_URL), writer = connect(LOCAL_CMS_GEN_WRITER_URL), reader = connect(LOCAL_CMS_READER_URL);
afterAll(async () => { await Promise.all([sql.end(), writer.end(), reader.end()]); });
class Done extends Error {}
async function inRollback(fn: (tx: postgres.TransactionSql) => Promise<void>, conn: postgres.Sql = sql) {
  await conn.begin(async (tx) => { await fn(tx); throw new Done(); }).catch((e) => { if (!(e instanceof Done)) throw e; });
}
const fails = (tx: postgres.TransactionSql, q: (sp: postgres.TransactionSql) => Promise<unknown>) => tx.savepoint(q as never);
const seqs = async (c: postgres.Sql | postgres.TransactionSql = sql) => (await c`select (select last_value from cms.cms_mq_seq) mq, (select last_value from cms.cms_sq_seq) sq,
  (select last_value from cms.cms_gr_seq) gr, (select is_called from cms.cms_gr_seq) gr_called`)[0]!;

describe('dry runs take no numbers (cms_mint)', () => {
  it('normal: nextval; dry run: the number nextval would give, the sequence untouched, consecutive inside the transaction', async () => {
    const before = await seqs();
    await inRollback(async (tx) => {
      const { a } = (await tx`select cms.cms_mint('SQ') as a`)[0]!;
      expect(a).toBe(`SQ${String(Number(before.sq) + 1).padStart(6, '0')}`);
    });
    const mid = await seqs();
    expect(Number(mid.sq)).toBe(Number(before.sq) + 1);   // a normal mint takes its number (rolled back or not)
    await inRollback(async (tx) => {
      await tx`select set_config('cms.dry_run', 'on', true)`;
      const { a } = (await tx`select cms.cms_mint('SQ') as a`)[0]!;
      const top = (await tx`select coalesce(max(substring(question_id from '[0-9]+$')::int), 0) as n from cms.cms_questions where question_id like 'SQ%'`)[0]!.n as number;
      expect(a).toBe(`SQ${String(Math.max(Number(mid.sq), top) + 1).padStart(6, '0')}`);
      await tx`insert into cms.cms_questions (question_id, bank, subject, file_key, chapter_id, topic_id, class, current_version) select ${a}, 'production', 'science', chapter_id || '-9990', chapter_id, topic_id, 2, 1 from cms.cms_topics where topic_id = 'ST0003'`;
      const { b } = (await tx`select cms.cms_mint('SQ') as b`)[0]!;
      expect(Number(String(b).slice(2))).toBe(Number(String(a).slice(2)) + 1);
      const { g } = (await tx`select cms.cms_mint('GR') as g`)[0]!;
      expect(g).toMatch(/^GR\d{4}$/);
    });
    expect(await seqs()).toEqual(mid);
  });

  it('a transaction that minted in dry-run mode can never commit', async () => {
    const before = await seqs();
    await expect(sql.begin(async (tx) => {
      await tx`select set_config('cms.dry_run', 'on', true)`;
      const { a } = (await tx`select cms.cms_mint('SQ') as a`)[0]!;
      await tx`insert into cms.cms_questions (question_id, bank, subject, file_key, chapter_id, topic_id, class, current_version) select ${a}, 'production', 'science', chapter_id || '-9990', chapter_id, topic_id, 2, 1 from cms.cms_topics where topic_id = 'ST0003'`;
    })).rejects.toThrow(/dry run can't be committed/);
    expect(await seqs()).toEqual(before);
    // and switching the flag off before the commit doesn't help
    await expect(sql.begin(async (tx) => {
      await tx`select set_config('cms.dry_run', 'on', true)`;
      const { a } = (await tx`select cms.cms_mint('SQ') as a`)[0]!;
      await tx`select set_config('cms.dry_run', 'off', true)`;
      await tx`insert into cms.cms_questions (question_id, bank, subject, file_key, chapter_id, topic_id, class, current_version) select ${a}, 'production', 'science', chapter_id || '-9990', chapter_id, topic_id, 2, 1 from cms.cms_topics where topic_id = 'ST0003'`;
    })).rejects.toThrow(/dry run can't be committed/);
  });

  it('0052 re-created each minting function with only the planned substitutions (bodies re-derived from their previous migrations)', async () => {
    const dir = join(import.meta.dirname, '..', 'db', 'migrations');
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql') && f < '0052').sort();
    const lastBody = (name: string) => {
      let body: string | null = null;
      for (const f of files) {
        const t = readFileSync(join(dir, f), 'utf8');
        const re = new RegExp(`create (?:or replace )?function cms\\.${name}\\([^]*?\\bas \\$\\$([^]*?)\\$\\$;`, 'gi');
        for (const m of t.matchAll(re)) body = m[1]!;
      }
      return body!;
    };
    const back = (s: string) => s
      .replace(/cms\.cms_mint\('(MQ|SQ|GQ)'\)/g, (_m, k: string) => `'${k}' || lpad(nextval('cms.cms_${k.toLowerCase()}_seq')::text, 6, '0')`)
      .replace(/cms\.cms_mint\('GR'\)/g, `'GR' || lpad(nextval('cms.cms_gr_seq')::text, 4, '0')`)
      .replace(/ {6}n := cms\.cms_next_free\('concept', n\);[^\n]*\n/, '')
      .replace(/ {6}if pre = 'MP' then n := cms\.cms_next_free\('pattern', n\); end if;[^\n]*\n/, '');
    for (const f of ['cms_apply_save', 'cms_add_questions', 'cms_place_held_out', 'cms_gen_write_item', 'cms_gen_open_run', 'cms_save_curriculum']) {
      const { src } = (await sql`select prosrc as src from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'cms' and p.proname = ${f}`)[0]!;
      expect(src as string, f).toMatch(/cms_mint|cms_next_free/);
      expect(back(src as string), f).toBe(lastBody(f));
    }
  });
});

describe('key registry', () => {
  it('file keys: after the highest stored, held-out, reserved key and the bank floor; below 5000; audited; closed once', async () => {
    await inRollback(async (tx) => {
      const r = async (extra: Record<string, unknown>) => (await tx`select cms.cms_reserve_keys(${tx.json({ kind: 'file_key', prefix: 'MC98', count: 10, purpose: 'test', ...extra } as never)}) as r`)[0]!.r;
      const a = await r({});
      expect([a.first, a.last, a.count, a.status]).toEqual(['MC98-0001', 'MC98-0010', 10, 'reserved']);
      const b = await r({ at_least: 40 });
      expect([b.first, b.last]).toEqual(['MC98-0040', 'MC98-0049']);
      const c = await r({ count: 2 });
      expect(c.first).toBe('MC98-0050');
      await expect(fails(tx, (sp) => sp`select cms.cms_reserve_keys('{"kind":"file_key","prefix":"MC98","count":10,"purpose":"x","at_least":4995}'::jsonb)`)).rejects.toThrow(/below 5000/);
      await expect(fails(tx, (sp) => sp`select cms.cms_reserve_keys('{"kind":"file_key","prefix":"XX1","count":1,"purpose":"x"}'::jsonb)`)).rejects.toThrow(/per chapter prefix/);
      await expect(fails(tx, (sp) => sp`select cms.cms_reserve_keys('{"kind":"file_key","prefix":"MC98","count":1}'::jsonb)`)).rejects.toThrow(/purpose/);
      const closed = (await tx`select cms.cms_close_keys(${tx.json({ reservation_id: a.reservation_id, status: 'used', note: 'built' } as never)}) as r`)[0]!.r;
      expect(closed.status).toBe('used');
      await expect(fails(tx, (sp) => sp`select cms.cms_close_keys(${sp.json({ reservation_id: a.reservation_id, status: 'released' } as never)})`)).rejects.toThrow(/already used/);
      const audit = await tx`select action from cms.cms_reviews where target = 'keys' and target_table = 'cms_key_reservations' order by review_id desc limit 4`;
      expect(audit.map((x) => x.action)).toEqual(['keys_close', 'keys_reserve', 'keys_reserve', 'keys_reserve']);
    });
  });

  it('a held-out key counts as taken', async () => {
    await inRollback(async (tx) => {
      const [h] = await tx`select file_key from cms.cms_held_out where file_key like 'MC%' and substring(file_key from '-([0-9]+)$')::int < 5000 order by file_key desc limit 1`;
      if (!h) return;   // the local bank may have no held-out Math item
      const pre = String(h.file_key).split('-')[0]!;
      const top = Math.max(...(await tx`select substring(file_key from '-([0-9]+)$')::int as n from cms.cms_questions where file_key like ${pre + '-%'} and substring(file_key from '-([0-9]+)$')::int < 5000
                                         union all select substring(file_key from '-([0-9]+)$')::int from cms.cms_held_out where file_key like ${pre + '-%'}`).map((x) => Number(x.n)));
      const r = (await tx`select cms.cms_reserve_keys(${tx.json({ kind: 'file_key', prefix: pre, count: 1, purpose: 'test' } as never)}) as r`)[0]!.r;
      expect(r.first).toBe(`${pre}-${String(top + 1).padStart(4, '0')}`);
    });
  });

  it('blocks: the next after every stored or reserved number; while reserved, CMS concept / MP numbering skips it', async () => {
    await inRollback(async (tx) => {
      const { floor } = (await tx`select cms.cms_key_block_floor() as floor`)[0]!;
      const a = (await tx`select cms.cms_reserve_keys('{"kind":"block","purpose":"test A"}'::jsonb) as r`)[0]!.r;
      expect(a.block).toBe(Number(floor) + 1);
      const b = Number(a.block);
      expect(a.patterns).toBe(`MP${String(b * 50).padStart(4, '0')}–MP${String(b * 50 + 49).padStart(4, '0')}`);
      const nf = async (k: string, n: number) => Number((await tx`select cms.cms_next_free(${k}, ${n}) as n`)[0]!.n);
      expect(await nf('pattern', b * 50 + 3)).toBe((b + 1) * 50);
      expect(await nf('pattern', b * 50 - 1)).toBe(b * 50 - 1);
      expect(await nf('concept', b * 100 + 1)).toBe((b + 1) * 100);
      await tx`select cms.cms_close_keys(${tx.json({ reservation_id: a.reservation_id, status: 'released' } as never)})`;
      expect(await nf('pattern', b * 50 + 3)).toBe(b * 50 + 3);   // a released block is no longer skipped
      const c = (await tx`select cms.cms_reserve_keys('{"kind":"block","purpose":"test B"}'::jsonb) as r`)[0]!.r;
      expect(c.block).toBe(b + 1);   // never reused
    });
  });

  it('id_blocks import: idempotent by block; another purpose is a conflict and never overwrites', async () => {
    await inRollback(async (tx) => {
      const { floor } = (await tx`select cms.cms_key_block_floor() as floor`)[0]!;
      const b = Number(floor) + 5;
      const imp = async (purpose: string) => (await tx`select cms.cms_import_key_blocks(${tx.json({ blocks: [{ block_no: b, purpose, status: 'used', note: 'n' }] } as never)}) as r`)[0]!.r.blocks[0].result;
      expect(await imp('P')).toBe('added');
      expect(await imp('P')).toBe('unchanged');
      expect(await imp('Q')).toBe('conflict');
      expect((await tx`select purpose from cms.cms_key_reservations where block_no = ${b}`)[0]!.purpose).toBe('P');
    });
  });

  it('who may: cms_gen_writer reserves and closes, never loads id_blocks; cms_reader nothing', async () => {
    await inRollback(async (tx) => {
      const r = (await tx`select cms.cms_reserve_keys('{"kind":"file_key","prefix":"MC97","count":3,"purpose":"route B"}'::jsonb) as r`)[0]!.r;
      expect(r.reserved_by).toBe('cms_gen_writer');
      await expect(fails(tx, (sp) => sp`select cms.cms_import_key_blocks('{"blocks":[]}'::jsonb)`)).rejects.toThrow(/permission denied|cms_owner can load/);
      await expect(fails(tx, (sp) => sp`select 1 from cms.cms_key_reservations`)).rejects.toThrow(/permission denied/);
    }, writer);
    await expect(reader`select cms.cms_reserve_keys('{}'::jsonb)`).rejects.toThrow(/permission denied/);
    expect((await reader`select count(*)::int as n from cms.cms_key_reservations`)[0]!.n).toBeGreaterThanOrEqual(0);
  });
});
