// Q19 + Q22 (17 Nov 2026), local DB, rolled back: bulk override decisions; approval blockers agree with the approval rules.
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import { assertLocal, LOCAL_SUPERUSER_URL } from '../scripts/local-bootstrap.ts';

assertLocal(LOCAL_SUPERUSER_URL);
const su = postgres(LOCAL_SUPERUSER_URL, { max: 1, onnotice: () => {} });
afterAll(() => su.end());
class Done extends Error {}
async function asAdmin(fn: (tx: postgres.TransactionSql) => Promise<void>) {
  await su.begin(async (tx) => {
    const [a] = await tx`select value #>> '{}' as id from cms.cms_config where key = 'admin_user_id'`;
    await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: a!.id, role: 'authenticated' })}, true)`;
    await fn(tx);
    throw new Done();
  }).catch((e) => { if (!(e instanceof Done)) throw e; });
}
const sp = <T>(tx: postgres.TransactionSql, f: (s: postgres.TransactionSql) => Promise<T>) => tx.savepoint(f);

describe('Q19 bulk override decisions (local, rolled back)', () => {
  it('approve several in one call: one audit row each; a non-pending ID refuses the whole batch; decline needs a note', async () => {
    await asAdmin(async (tx) => {
      const vs = await tx`select v.version_id, v.question_id from cms.cms_question_versions v join cms.cms_questions q on q.question_id = v.question_id and q.current_version = v.version_no
        where q.subject = 'math' and q.bank = 'production' order by v.version_id limit 3`;
      if (vs.length < 3) return;
      const ids: number[] = [];
      for (const [i, v] of vs.entries()) {
        const [r] = await tx`insert into cms.cms_override_requests (question_id, version_id, field, reason, requested_by)
          values (${v.question_id}, ${v.version_id}, ${`zz-field-${i}`}, 'test reason', 'test') returning request_id`;
        ids.push(Number(r!.request_id));
      }
      await tx.unsafe('set local role authenticated');
      await expect(sp(tx, (s) => s`select cms.cms_decide_overrides(${ids}, false, '')`)).rejects.toThrow(/needs a note/);
      const [{ r }] = await sp(tx, (s) => s`select cms.cms_decide_overrides(${ids.slice(0, 2)}, true, 'bulk test') as r`) as unknown as [{ r: { decided: number } }];
      expect(r.decided).toBe(2);
      await expect(sp(tx, (s) => s`select cms.cms_decide_overrides(${ids}, true, null)`)).rejects.toThrow(/Not pending: .*approved.*Nothing was decided/);
      await tx.unsafe('reset role');
      const st = await tx`select request_id, status from cms.cms_override_requests where request_id = any(${ids}) order by 1`;
      expect(st.map((x) => x.status)).toEqual(['approved', 'approved', 'pending']);
      const aud = await tx`select count(*)::int as n from cms.cms_reviews where action = 'override_near_copy' and field_diff ->> 'request_id' = any(${ids.map(String)})`;
      expect(aud[0]!.n).toBe(2);
    });
  });
});

describe('Q22 approval blockers (local, rolled back)', () => {
  it('every reason the view lists does block approval; a version it does not list can be approved', async () => {
    await asAdmin(async (tx) => {
      const blocked = await tx`select distinct on (reason) question_id, version_no, reason from cms.cms_approval_blockers order by reason, question_id`;
      await tx.unsafe('set local role authenticated');
      for (const b of blocked) {
        await expect(sp(tx, (s) => s`select cms.cms_set_status(${b.question_id}, ${b.version_no}, 'approve', null)`), `${b.reason} ${b.question_id}`).rejects.toThrow(/can't be approved yet|near-copy/);
      }
      await tx.unsafe('reset role');
      const [free] = await tx`select q.question_id, v.version_no from cms.cms_questions q join cms.cms_question_versions v on v.question_id = q.question_id and v.version_no = q.current_version
        where q.bank = 'production' and q.retired_at is null and v.status in ('draft', 'in_review')
          and not exists (select 1 from cms.cms_approval_blockers b where b.question_id = q.question_id) order by q.question_id limit 1`;
      if (!free) return;
      await tx.unsafe('set local role authenticated');
      await sp(tx, (s) => s`select cms.cms_set_status(${free.question_id}, ${free.version_no}, 'approve', null)`);
    });
  });
});
