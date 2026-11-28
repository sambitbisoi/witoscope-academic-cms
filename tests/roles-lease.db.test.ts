// Q38 PR 2 (plan §8, §10): cms_reader / cms_gen_writer and the work lease, against THIS repo's local database.
// Each lease test runs in a rolled-back transaction; the role tests use their own logins (0051 grants, 02-cms-roles.sql).
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import { CMS_ROLES, connect, takeLease } from '../scripts/lib/db.ts';
import { assertLocal, LOCAL_CMS_GEN_WRITER_URL, LOCAL_CMS_OWNER_URL, LOCAL_CMS_READER_URL } from '../scripts/local-bootstrap.ts';

assertLocal(LOCAL_CMS_OWNER_URL);
const owner = connect(LOCAL_CMS_OWNER_URL);
const reader = connect(LOCAL_CMS_READER_URL);
const writer = connect(LOCAL_CMS_GEN_WRITER_URL);
afterAll(async () => { await Promise.all([owner.end(), reader.end(), writer.end()]); });
class Done extends Error {}
async function inRollback(conn: postgres.Sql, fn: (tx: postgres.TransactionSql) => Promise<void>) {
  await conn.begin(async (tx) => { await fn(tx); throw new Done(); }).catch((e) => { if (!(e instanceof Done)) throw e; });
}
const fails = (tx: postgres.TransactionSql, q: (sp: postgres.TransactionSql) => Promise<unknown>) => tx.savepoint(q as never);

describe('roles', () => {
  it('connect() accepts the three CMS roles only', () => {
    expect(CMS_ROLES).toEqual(['cms_owner', 'cms_reader', 'cms_gen_writer']);
    expect(() => connect('postgres://service_role:x@db.example.com:5432/postgres')).toThrow(/Refusing to connect as "service_role"/);
    expect(() => connect('postgres://postgres.abc:x@pooler.example.com:5432/postgres')).toThrow(/Refusing/);
  });

  it('cms_reader sees every row (BYPASSRLS + SELECT) and can write nothing', async () => {
    const [o] = await owner`select count(*)::int as n from cms.cms_questions`;
    const [r] = await reader`select count(*)::int as n from cms.cms_questions`;
    expect(r!.n).toBe(o!.n);
    expect((await reader`select count(*)::int as n from cms.cms_config`)[0]!.n).toBeGreaterThan(0);
    expect((await reader`select count(*)::int as n from cms.cms_question_list`)[0]!.n).toBeGreaterThanOrEqual(0);   // views (security_invoker) too
    await expect(reader`insert into cms.cms_config (key, value) values ('zz_reader', '1')`).rejects.toThrow(/read-only transaction|permission denied/);
    await expect(reader.begin('read write', (tx) => tx`insert into cms.cms_config (key, value) values ('zz_reader', '1')`)).rejects.toThrow(/permission denied/);
    await expect(reader`select cms.cms_take_lease('{"holder":"r","kind":"script"}'::jsonb)`).rejects.toThrow(/permission denied/);
    await expect(reader`select cms.cms_gen_open_run('{}'::jsonb)`).rejects.toThrow(/permission denied/);
    await expect(reader`select nextval('cms.cms_sq_seq')`).rejects.toThrow(/read-only|permission denied/);
    // even with the read-only default switched off in the session, nothing can be written: no table right, no function
    await reader.begin('read write', async (tx) => {   // BEGIN READ WRITE: the read-only default is off for this transaction
      expect((await tx`select current_setting('transaction_read_only') as ro`)[0]!.ro).toBe('off');
      for (const q of ["insert into cms.cms_config (key, value) values ('zz_reader', '1')", "update cms.cms_config set note = note where key = 'admin_user_id'",
                       "delete from cms.cms_reviews where false", "select cms.cms_set_status('MQ000001', 1, 'approve', null)", "select cms.cms_apply_save('{}'::jsonb)",
                       "select cms.cms_approve_questions(array['MQ000001'], null)", "select cms.cms_gen_import_batch('{}'::jsonb)", "select cms.cms_gen_open_run('{}'::jsonb)",
                       "select cms.cms_add_questions('{}'::jsonb)", "select cms.cms_save_curriculum('{}'::jsonb)", "select nextval('cms.cms_sq_seq')"])
        await expect(tx.savepoint((sp) => sp.unsafe(q)), q).rejects.toThrow(/permission denied/);
    });
    const [p] = await reader`select rolbypassrls, rolsuper, rolcreaterole from pg_roles where rolname = current_user`;
    expect(p).toEqual({ rolbypassrls: true, rolsuper: false, rolcreaterole: false });
  });

  it('EXECUTE: no cms function is usable by PUBLIC or cms_reader; cms_gen_writer has exactly the import + lease functions; new functions start closed', async () => {
    const execBy = async (role: string) => (await owner`select p.oid::regprocedure::text as f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'cms' and has_function_privilege(${role}, p.oid, 'execute') order by 1`).map((r) => r.f as string);
    expect(await execBy('cms_reader')).toEqual([]);
    expect((await owner`select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'cms' and (p.proacl is null or p.proacl::text ~ '(^|,|\\{)=X')`)[0]!.n).toBe(0);
    expect(await execBy('cms_gen_writer')).toEqual(['cms.cms_close_keys(jsonb)', 'cms.cms_gen_close_run(jsonb)', 'cms.cms_gen_config()', 'cms.cms_gen_import_batch(jsonb)', 'cms.cms_gen_open_run(jsonb)',
      'cms.cms_gen_set_briefs(jsonb)', 'cms.cms_heartbeat_lease(text,integer)', 'cms.cms_lease_state()', 'cms.cms_release_lease(text,boolean)', 'cms.cms_reserve_keys(jsonb)', 'cms.cms_take_lease(jsonb)']);   // + 0052 reserve / close
    await inRollback(owner, async (tx) => {   // a function a future migration forgets to revoke stays closed
      await tx`create function cms.cms_zz_probe() returns int language sql set search_path = '' as $$ select 1 $$`;
      const [r] = await tx`select has_function_privilege('cms_reader', 'cms.cms_zz_probe()', 'execute') as reader, has_function_privilege('cms_gen_writer', 'cms.cms_zz_probe()', 'execute') as writer,
                                  has_function_privilege('anon', 'cms.cms_zz_probe()', 'execute') as anon`;
      expect(r).toEqual({ reader: false, writer: false, anon: false });
    });
  });

  it('neither role has any table right outside schema cms beyond what every login has (cms_owner as the baseline)', async () => {
    // e.g. extensions.pg_stat_statements is readable by every role (own queries only); the CMS grants nothing outside cms
    for (const role of ['cms_reader', 'cms_gen_writer']) {
      const rows = await owner`select n.nspname, c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind in ('r', 'v', 'm', 'p', 'f') and n.nspname not in ('cms', 'pg_catalog', 'information_schema')
          and (has_table_privilege(${role}, c.oid, 'select') or has_table_privilege(${role}, c.oid, 'insert') or has_table_privilege(${role}, c.oid, 'update') or has_table_privilege(${role}, c.oid, 'delete'))
          and not has_table_privilege('cms_owner', c.oid, 'select')`;
      expect(rows, role).toEqual([]);
      const [s] = await owner`select has_schema_privilege(${role}, 'auth', 'usage') as auth, has_schema_privilege(${role}, 'public', 'create') as pub`;
      expect(s, role).toEqual({ auth: false, pub: false });
    }
  });

  it('cms_gen_writer: no table rights; may call the generation import functions and the lease only', async () => {
    await expect(writer`select count(*) from cms.cms_questions`).rejects.toThrow(/permission denied/);
    await expect(writer`select count(*) from cms.cms_config`).rejects.toThrow(/permission denied/);
    expect((await writer`select cms.cms_gen_config() as c`)[0]!.c.batch_size).toBeGreaterThan(0);
    await inRollback(writer, async (tx) => {
      await expect(fails(tx, (sp) => sp`select cms.cms_gen_open_run('{}'::jsonb)`)).rejects.toThrow(/needs subject math or science/);   // past the caller check
      for (const f of ['cms_gen_rollback', 'cms_gen_place_held'])
        await expect(fails(tx, (sp) => sp.unsafe(`select cms.${f}('{}'::jsonb)`))).rejects.toThrow(/permission denied/);
      await expect(fails(tx, (sp) => sp`select cms.cms_approve_questions(${['MQ000001']}::text[], null)`)).rejects.toThrow(/permission denied/);
      await expect(fails(tx, (sp) => sp`select cms.cms_set_status('MQ000001', 1, 'approve', null)`)).rejects.toThrow(/permission denied/);
      await expect(fails(tx, (sp) => sp`select cms.cms_apply_save('{}'::jsonb)`)).rejects.toThrow(/permission denied/);
      for (const f of ['cms_add_questions', 'cms_save_curriculum', 'cms_save_science_review', 'cms_place_held_out', 'cms_set_image'])
        await expect(fails(tx, (sp) => sp.unsafe(`select cms.${f}('{}'::jsonb)`))).rejects.toThrow(/permission denied|does not exist/);
    });
    // forged admin claims don't make a cms_gen_writer login the admin: it still can't force a release
    const [{ value: adminId }] = await owner`select value #>> '{}' as value from cms.cms_config where key = 'admin_user_id'` as unknown as [{ value: string }];
    await inRollback(writer, async (tx) => {
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: adminId, role: 'authenticated' })}, true)`;
      await tx`select cms.cms_take_lease('{"holder":"someone","kind":"script"}'::jsonb)`;
      await expect(fails(tx, (sp) => sp`select cms.cms_release_lease('me', true)`)).rejects.toThrow(/force/);
      await expect(fails(tx, (sp) => sp`select taken_by from cms.cms_work_lease`)).rejects.toThrow(/permission denied/);
      expect((await tx`select cms.cms_lease_state() as r`)[0]!.r.taken_by).toBe('cms_gen_writer');
    });
  });
});

describe('work lease', () => {
  const take = (tx: postgres.TransactionSql, holder: string, extra: Record<string, unknown> = {}) =>
    tx`select cms.cms_take_lease(${tx.json({ holder, kind: 'gen_import', ...extra } as never)}) as r`.then((x) => x[0]!.r);
  it('one holder at a time: take, renew, busy, release (audited), then free', async () => {
    await inRollback(owner, async (tx) => {
      expect((await tx`select cms.cms_lease_state() as r`)[0]!.r.live).toBe(false);
      expect((await take(tx, 'A', { note: 'import C5X' })).taken).toBe('new');
      expect((await take(tx, 'A')).taken).toBe('renewed');
      await expect(fails(tx, (sp) => take(sp, 'B'))).rejects.toMatchObject({ code: '55P03', message: expect.stringMatching(/busy: A \(gen_import\)/) });
      expect((await tx`select cms.cms_heartbeat_lease('A') as r`)[0]!.r.holder).toBe('A');
      await expect(fails(tx, (sp) => sp`select cms.cms_heartbeat_lease('B')`)).rejects.toThrow(/Lost the work lease/);
      expect((await tx`select cms.cms_release_lease('B') as r`)[0]!.r.released).toBe(false);   // not B's
      expect((await tx`select cms.cms_release_lease('A') as r`)[0]!.r.released).toBe(true);
      expect((await take(tx, 'B')).taken).toBe('new');
      const audit = await tx`select action, by_label from cms.cms_reviews where target = 'lease' order by review_id desc limit 3`;
      expect(audit.map((a) => `${a.action} ${a.by_label}`)).toEqual(['lease_take B', 'lease_release A', 'lease_take A']);
    });
  });
  it('an expired lease is taken over (audited); a forced release is for cms_owner / the admin only', async () => {
    await inRollback(owner, async (tx) => {
      await take(tx, 'A');
      await tx`update cms.cms_work_lease set expires_at = now() - interval '1 minute'`;
      expect((await tx`select cms.cms_lease_state() as r`)[0]!.r.live).toBe(false);
      expect((await take(tx, 'B')).taken).toBe('takeover');
      expect((await tx`select action from cms.cms_reviews where target = 'lease' order by review_id desc limit 1`)[0]!.action).toBe('lease_takeover');
      expect((await tx`select cms.cms_release_lease('Sambit', true) as r`)[0]!.r.released).toBe(true);
    });
    await inRollback(writer, async (tx) => {
      expect((await take(tx, 'W')).taken).toBe('new');
      await expect(fails(tx, (sp) => take(sp, 'X'))).rejects.toThrow(/busy/);
      await expect(fails(tx, (sp) => sp`select cms.cms_release_lease('X', true)`)).rejects.toThrow(/force/);
      expect((await tx`select cms.cms_release_lease('W') as r`)[0]!.r.released).toBe(true);
    });
  });
  it('takeLease: the heartbeat renews the lease on its own connection while a long transaction runs elsewhere; a lost lease is noticed', async () => {
    const lease = await takeLease({ kind: 'script', holder: 'zz heartbeat test', minutes: 1, beatMs: 400, url: LOCAL_CMS_OWNER_URL, log: () => {} });
    try {
      const [a] = await owner`select heartbeat_at, expires_at from cms.cms_work_lease`;
      await owner`select pg_sleep(1.5)`;   // a "long batch" on another connection
      const [b] = await owner`select heartbeat_at, expires_at, holder from cms.cms_work_lease`;
      expect(b!.holder).toBe('zz heartbeat test');
      expect(new Date(b!.expires_at).getTime()).toBeGreaterThan(new Date(a!.expires_at).getTime());
      expect(new Date(b!.heartbeat_at).getTime()).toBeGreaterThan(new Date(a!.heartbeat_at).getTime());
      await owner`select cms.cms_release_lease('Sambit', true)`;   // someone forces it away
      await new Promise((r) => setTimeout(r, 1000));
      expect(lease.lost).toBe(true);
    } finally { await lease.release(); }
    expect((await owner`select cms.cms_lease_state() as r`)[0]!.r.live).toBe(false);
    await owner`delete from cms.cms_reviews where target = 'lease' and by_label in ('zz heartbeat test', 'Sambit') and at > now() - interval '1 minute'`;
  });

  it('bad input is refused', async () => {
    await inRollback(owner, async (tx) => {
      await expect(fails(tx, (sp) => sp`select cms.cms_take_lease('{"kind":"gen_import"}'::jsonb)`)).rejects.toThrow(/holder/);
      await expect(fails(tx, (sp) => take(sp, 'A', { kind: 'other' }))).rejects.toThrow(/kind/);
      await expect(fails(tx, (sp) => take(sp, 'A', { minutes: 500 }))).rejects.toThrow(/1 to 240/);
    });
  });
});
