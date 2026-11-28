// English E1 (0053): topic / Grammar-concept reservations, reserved topic IDs in cms_save_curriculum, home class, audit
// label, and the sync against THIS repo's local database (rolled back).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, type Sql } from '../scripts/lib/db.ts';
import { applyOrder, applyTopic, planSync, readDbState, type SheetTopic } from '../scripts/lib/grammar-sync.ts';
import { assertLocal, LOCAL_CMS_OWNER_URL } from '../scripts/local-bootstrap.ts';

assertLocal(LOCAL_CMS_OWNER_URL);
const sql = connect(LOCAL_CMS_OWNER_URL);
let admin = '';
beforeAll(async () => { admin = (await sql`select value #>> '{}' as v from cms.cms_config where key = 'admin_user_id'`)[0]!.v; });
afterAll(async () => { await sql.end(); });
class Done extends Error {}
async function inRollback(fn: (tx: postgres.TransactionSql) => Promise<void>) {
  await sql.begin(async (tx) => { await fn(tx); throw new Done(); }).catch((e) => { if (!(e instanceof Done)) throw e; });
}
const fails = (tx: postgres.TransactionSql, q: (sp: postgres.TransactionSql) => Promise<unknown>) => tx.savepoint(q as never);
const asAdmin = (tx: postgres.TransactionSql) => tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: admin, role: 'authenticated' })}, true)`;
const reserve = async (tx: postgres.TransactionSql, p: Record<string, unknown>) => (await tx`select cms.cms_reserve_keys(${tx.json({ purpose: 'test', ...p } as never)}) as r`)[0]!.r;
const save = async (tx: postgres.TransactionSql, p: Record<string, unknown>) => (await tx`select cms.cms_save_curriculum(${tx.json(p as never)}) as r`)[0]!.r;
// the highest GT number stored or reserved (the next reservation starts after it)
const maxGT = async (tx: postgres.TransactionSql) => Number((await tx`select greatest((select max(substr(topic_id, 3)::int) from cms.cms_topics where topic_id ~ '^GT[0-9]{4}$'),
  (select max(last_no) from cms.cms_key_reservations where kind = 'topic' and prefix = 'GT')) as n`)[0]!.n);
const gt = (n: number) => `GT${String(n).padStart(4, '0')}`;

describe('0053 registry kinds', () => {
  it('topic IDs: next after every stored or reserved one; never reused; prefix GT/MT/ST only', async () => {
    await inRollback(async (tx) => {
      const top = await maxGT(tx);
      const a = await reserve(tx, { kind: 'topic', prefix: 'GT', count: 9 });
      expect([a.first, a.last, a.count]).toEqual([gt(top + 1), gt(top + 9), 9]);
      const b = await reserve(tx, { kind: 'topic', prefix: 'GT', count: 2 });
      expect(b.first).toBe(gt(top + 10));
      await expect(fails(tx, (sp) => sp`select cms.cms_reserve_keys('{"kind":"topic","prefix":"XT","count":1,"purpose":"x"}'::jsonb)`)).rejects.toThrow(/GT, MT or ST/);
      await expect(fails(tx, (sp) => sp`select cms.cms_reserve_keys('{"kind":"topic","prefix":"GT","count":101,"purpose":"x"}'::jsonb)`)).rejects.toThrow(/1 to 100/);
    });
  });
  it('Grammar concept numbers: per Grammar topic, C01–C99; refused for a non-Grammar topic', async () => {
    await inRollback(async (tx) => {
      const r = await reserve(tx, { kind: 'grammar_concept', prefix: 'GT0049', count: 3 });
      expect([r.first, r.last]).toEqual(['GT0049-C01', 'GT0049-C03']);   // no Grammar concepts are stored yet (E2)
      expect((await reserve(tx, { kind: 'grammar_concept', prefix: 'GT0049', count: 1 })).first).toBe('GT0049-C04');
      const [{ mt }] = await tx`select min(topic_id) as mt from cms.cms_topics where topic_id like 'MT%'` as unknown as [{ mt: string }];
      await expect(fails(tx, (sp) => sp`select cms.cms_reserve_keys(${sp.json({ kind: 'grammar_concept', prefix: mt.replace('MT', 'GT').slice(0, 2) + '9999', count: 1, purpose: 'x' } as never)})`)).rejects.toThrow(/per Grammar topic/);
    });
  });
});

describe('0053 cms_save_curriculum', () => {
  it('create takes a reserved topic ID (and closes the reservation once all exist); refuses an unreserved one; plain create skips reserved numbers', async () => {
    await inRollback(async (tx) => {
      await asAdmin(tx);
      const top = await maxGT(tx);
      const r = await reserve(tx, { kind: 'topic', prefix: 'GT', count: 2 });
      const f = (id?: string) => ({ kind: 'topic', action: 'create', fields: { ...(id ? { topic_id: id } : {}), chapter_id: 'GC28', class: 3, name: `Test topic ${id ?? 'plain'}`,
        classes: [{ class: 3, source: 'test' }] }, by_label: 'test label' });
      await expect(fails(tx, (sp) => sp`select cms.cms_save_curriculum(${sp.json(f(gt(top + 5)) as never)})`)).rejects.toThrow(/not in an open GT reservation/);
      expect((await save(tx, f(gt(top + 2)))).id).toBe(gt(top + 2));
      expect((await tx`select status from cms.cms_key_reservations where reservation_id = ${r.reservation_id}`)[0]!.status).toBe('reserved');
      expect((await save(tx, f(gt(top + 1)))).id).toBe(gt(top + 1));
      expect((await tx`select status from cms.cms_key_reservations where reservation_id = ${r.reservation_id}`)[0]!.status).toBe('used');
      await expect(fails(tx, (sp) => sp`select cms.cms_save_curriculum(${sp.json(f(gt(top + 1)) as never)})`)).rejects.toThrow(/not in an open GT reservation|already exists/);
      await reserve(tx, { kind: 'topic', prefix: 'GT', count: 3 });   // GT top+3 … top+5 held: a plain create jumps past them
      expect((await save(tx, f())).id).toBe(gt(top + 6));
      const [a] = await tx`select by_label from cms.cms_reviews where target_table = 'cms_topics' and target_id = ${gt(top + 2)} order by review_id desc limit 1`;
      expect(a!.by_label).toBe('test label');
    });
  });
  it('update changes the home class (audited before → after); an Achievers row keeps its class; without by_label the audit says Sambit', async () => {
    await inRollback(async (tx) => {
      await asAdmin(tx);
      await save(tx, { kind: 'topic', action: 'update', id: 'GT0026', fields: { class: 3 }, reason: 'test' });
      expect((await tx`select class from cms.cms_topics where topic_id = 'GT0026'`)[0]!.class).toBe(3);
      const [a] = await tx`select by_label, field_diff from cms.cms_reviews where target_table = 'cms_topics' and target_id = 'GT0026' order by review_id desc limit 1`;
      expect(a!.by_label).toBe('Sambit');
      expect(JSON.stringify(a!.field_diff)).toContain('"class"');
      await expect(fails(tx, (sp) => sp`select cms.cms_save_curriculum('{"kind":"topic","action":"update","id":"GT0026","fields":{"class":7}}'::jsonb)`)).rejects.toThrow(/1–6/);
      const [ach] = await tx`select topic_id from cms.cms_topics where topic_kind = 'achievers' limit 1`;
      if (ach) await expect(fails(tx, (sp) => sp`select cms.cms_save_curriculum(${sp.json({ kind: 'topic', action: 'update', id: ach.topic_id, fields: { class: 2 } } as never)})`)).rejects.toThrow(/Achievers row keeps/);
    });
  });
  it('0053 re-created cms_save_curriculum with only the planned edits (body re-derived from 0052)', async () => {
    const dir = join(import.meta.dirname, '..', 'db', 'migrations');
    const body = (file: string) => new RegExp('create (?:or replace )?function cms\\.cms_save_curriculum\\([^]*?\\bas \\$function\\$([^]*?)\\$function\\$;', 'i').exec(readFileSync(join(dir, file), 'utf8'))![1]!;
    const live = (await sql`select prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'cms' and p.proname = 'cms_save_curriculum'`)[0]!.prosrc as string;
    expect(live).toBe(body('0053_registry_topics.sql'));
    const back = live
      .replace(/ {8}if coalesce\(btrim\(f ->> 'topic_id'\), ''\) <> '' then[^]*? {8}else\n {10}(select coalesce\(max\(substr\(x\.topic_id, 3\)::int\), 0\) \+ 1 into n[^\n]*\n) {10}n := cms\.cms_next_free_in[^\n]*\n {10}(rid := pre[^\n]*\n) {8}end if;\n/, (_m, a: string, b: string) => `        ${a}        ${b}`)
      .replace(/ {6}if pre is not null then perform cms\.cms_close_used_topic_reservations\(pre\); end if;[^\n]*\n/, '')
      .replace(/ {8}class = case when f \? 'class' then \(f ->> 'class'\)::int else x\.class end,[^\n]*\n/, '')
      .replace(/ {6}if f \? 'class' and [^\n]*\n {6}if f \? 'class' and [^\n]*\n/, '')
      .replace(/coalesce\(nullif\(btrim\(p ->> 'by_label'\), ''\), 'Sambit'\)\);[^\n]*/, "'Sambit');");
    expect(back).toBe(body('0052_key_registry.sql'));
  });
});

describe('grammar:sync against the local catalogue', () => {
  it('a sheet equal to the CMS is all unchanged; a rename, a home class, a class tick and a reserved NEW topic are planned, applied, and then unchanged', async () => {
    await inRollback(async (tx) => {
      const db = await readDbState(tx as unknown as Sql);
      const active = [...db.topics.values()].filter((t) => t.status === 'active' && t.topic_kind === 'normal').sort((a, b) => a.topic_id.localeCompare(b.topic_id));
      const sheet: SheetTopic[] = active.map((t, i) => ({ row: i + 2, chapter_id: t.chapter_id, chapter: '', sheet_id: t.topic_id, name: t.name, home: t.class,
        ticks: t.links.map((l) => l.class).sort(), ixl: '', ncert: '', dav: '', sub_skills: '', notes: '', strand: '' }));
      const same = planSync(sheet, db, new Map(), sheet.length);
      expect(same.problems).toEqual([]);
      expect(same.counts.unchanged).toBe(sheet.length);
      const top = await maxGT(tx);
      await reserve(tx, { kind: 'topic', prefix: 'GT', count: 1 });
      const s2 = sheet.map((t) => t.sheet_id === 'GT0062' ? { ...t, name: 'Renamed in test' } : t.sheet_id === 'GT0026' ? { ...t, home: 3, ticks: [...new Set([3, ...t.ticks])].sort() } : t);
      const i28 = s2.findIndex((t) => t.chapter_id === 'GC28');
      s2.splice(i28 + 1, 0, { row: 9999, chapter_id: 'GC28', chapter: '', sheet_id: 'NEW-01', name: 'Test new topic', home: 3, ticks: [2, 3, 4], ixl: '', ncert: '3–4', dav: '', sub_skills: 's', notes: 'n', strand: '' });
      const plan = planSync(s2, await readDbState(tx as unknown as Sql), new Map([['NEW-01', gt(top + 1)]]), s2.length);
      expect(plan.problems).toEqual([]);
      expect(plan.counts).toMatchObject({ created: 1, renamed: 1, home_class: 1, class_links: 1 });
      const created = plan.topics.find((p) => p.action === 'create')!;
      expect((created.fields.classes as { class: number; source: string }[]).map((l) => `${l.class}:${l.source}`)).toEqual(['2:Grammar sheet r30', '3:Grammar sheet r30; NCERT', '4:Grammar sheet r30; NCERT']);
      for (const p of plan.topics) await applyTopic(tx as unknown as Sql, admin, p);
      for (const o of plan.order) await applyOrder(tx as unknown as Sql, admin, o);
      const again = planSync(s2, await readDbState(tx as unknown as Sql), new Map([['NEW-01', gt(top + 1)]]), s2.length);
      expect(again.problems).toEqual([]);
      expect(again.counts).toMatchObject({ created: 0, renamed: 0, home_class: 0, class_links: 0, order_lists: 0, unchanged: s2.length });
      const labels = await tx`select distinct by_label from cms.cms_reviews where target_table = 'cms_topics' and target_id in ${tx([gt(top + 1), 'GT0062', 'GT0026'])}`;
      expect(labels.map((l) => l.by_label)).toEqual(['grammar:sync r30']);
    });
  });
});
