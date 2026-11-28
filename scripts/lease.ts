// Q38 PR 2: the CMS work lease ("one CMS writer at a time", plan §10) by hand.
//   npm run lease -- status
//   npm run lease -- take --holder "CMS session 28 Nov (Claude)" [--minutes 120] [--note "PR 3 key reservations"]
//   npm run lease -- renew --holder "…" [--minutes 120]
//   npm run lease -- release --holder "…" [--force]           (--force: cms_owner only; audited as forced)
// Real project: npx tsx --env-file=.env.real scripts/lease.ts …
// While a session holds the lease, run its scripts with CMS_LEASE_HOLDER="<the same holder>" so gen:import / gen:rollback
// work under it (and leave it held); every other writer is refused until it is released or expires.
import { connect } from './lib/db.ts';

const [cmd, ...rest] = process.argv.slice(2);
const opt = (n: string) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] ?? null : null; };
const holder = opt('--holder'), minutes = Number(opt('--minutes') ?? 15);
if (!cmd || !['status', 'take', 'renew', 'release'].includes(cmd) || (cmd !== 'status' && !holder)) {
  console.error('usage: npm run lease -- status | take --holder "…" [--minutes N] [--note "…"] | renew --holder "…" [--minutes N] | release --holder "…" [--force]');
  process.exit(1);
}
const sql = connect();
const show = (l: Record<string, unknown>) => (l.live ? `held by ${l.holder} (${l.kind}, ${l.taken_by}) since ${l.taken_at}, expires ${l.expires_at}${l.note ? ` · ${l.note}` : ''}`
  : l.holder ? `free (the lease of ${l.holder} expired at ${l.expires_at})` : 'free');
try {
  if (cmd === 'status') console.log(show((await sql`select cms.cms_lease_state() as r`)[0]!.r));
  if (cmd === 'take') { const r = (await sql`select cms.cms_take_lease(${sql.json({ holder, kind: 'cms_session', minutes, note: opt('--note') } as never)}) as r`)[0]!.r; console.log(`${r.taken}: ${show(r.lease)}`); }
  if (cmd === 'renew') console.log(`renewed: ${show((await sql`select cms.cms_heartbeat_lease(${holder}, ${minutes}) as r`)[0]!.r)}`);
  if (cmd === 'release') { const r = (await sql`select cms.cms_release_lease(${holder}, ${rest.includes('--force')}) as r`)[0]!.r; console.log(r.released ? 'released' : `not released: ${show(r.lease)}`); }
} catch (e) { console.error(`lease ${cmd} failed: ${(e as Error).message}`); process.exitCode = 1; }
finally { await sql.end(); }
