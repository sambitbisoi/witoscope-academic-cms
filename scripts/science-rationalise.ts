// science:rationalise (Sambit, 16 Nov 2026; docs/plan-2026-11-16-q11-q18.md §3, decisions §8)
//
//   npm run science:rationalise -- [--dry-run] [--confirm-real]
//
// One transaction, as cms_owner (--dry-run rolls back):
//  1. split every content row's misconceptions text into numbered items (rules + scripts/lib/science-splits.json);
//  2. per open Science version: copy the misconception text to misconception_targeted_legacy, match it to an item of
//     its linked rows (exact / fuzzy / ambiguous → best proposed); if only an UNLINKED row has it, link that row as
//     supporting (decision 4); else propose a new item on the primary row (needs review, "from question");
//     then clear the free text;
//  3. ranks: one direct row → primary; several → a proposed primary (confirmed by Sambit in the Science review box);
//  4. tag wrong options whose own text states an item of a linked row; list the others;
//  5. Solution 1 under 60 characters → the reviewed draft from scripts/lib/science-solution-drafts.json (in place,
//     audited, stays Needs review); list the ones that never mention a wrong option (no drafts).
// Stops (rolls back, report kept) when anything outside Science changes, legacy text would be lost, unclear splits
// > 10% of rows with text, or > 25% of questions end unmatched. Report: .local-import/science-rationalise-*.{json,md}.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertCmsOwner, connect, targetUrl } from './lib/db.ts';
import { guardDiff, guardDigest } from './lib/science-guard.ts';
import { syncRowItems, type ItemSyncResult } from './lib/science-items-db.ts';
import { itemRef, matchItem, mentionsWrongOption, optionItem, proposePrimary, SHORT_SOLUTION, type Item } from '../shared/science-items.ts';
import { sha256Hex } from '../shared/sha256.ts';

const DRAFTS = new URL('./lib/science-solution-drafts.json', import.meta.url);
const BY = 'science:rationalise';
class Rollback extends Error { constructor(public result: Report) { super('rollback'); } }

interface QLine { question_id: string; text: string; misconception?: string | null; result?: string; proposal?: string; note?: string }
export interface Report {
  target: 'local' | 'real'; database: string; dry_run: boolean; import_id: number | null; stopped: string | null;
  items: ItemSyncResult | null;
  questions: { science_versions: number; open: number; skipped_not_open: string[]; with_text: number; none: number;
    matched_exact: QLine[]; matched_fuzzy: QLine[]; ambiguous: QLine[]; linked_supporting: QLine[]; unmatched_new_item: QLine[]; already_done: number };
  primary: { set_single: number; proposed: { question_id: string; primary: string; others: string[]; reason: string }[]; already: number };
  wrong_options: { tagged: { question_id: string; position: number; option: string; item: string }[]; untagged: { question_id: string; position: number; option: string }[] };
  solutions: { drafted: { question_id: string; before: string; after: string }[]; short_without_draft: { question_id: string; text: string; rows: string[] }[]; no_wrong_option: string[] };
  legacy: { copied: number; lost: string[] };
  guard: { changed: string[] };
  thresholds: { unclear_pct: number; unmatched_pct: number };
}

export async function rationalise(sql: ReturnType<typeof connect>, opts: { dryRun: boolean; target: 'local' | 'real' }): Promise<Report> {
  const drafts = existsSync(DRAFTS) ? (JSON.parse(readFileSync(DRAFTS, 'utf8')) as { questions: Record<string, { text: string }> }).questions : {};
  const res: Report = {
    target: opts.target, database: new URL(targetUrl()).pathname.slice(1), dry_run: opts.dryRun, import_id: null, stopped: null, items: null,
    questions: { science_versions: 0, open: 0, skipped_not_open: [], with_text: 0, none: 0, matched_exact: [], matched_fuzzy: [], ambiguous: [], linked_supporting: [], unmatched_new_item: [], already_done: 0 },
    primary: { set_single: 0, proposed: [], already: 0 },
    wrong_options: { tagged: [], untagged: [] },
    solutions: { drafted: [], short_without_draft: [], no_wrong_option: [] },
    legacy: { copied: 0, lost: [] }, guard: { changed: [] }, thresholds: { unclear_pct: 0, unmatched_pct: 0 },
  };
  try {
    await sql.begin(async (tx) => {
      const pre = await guardDigest(tx as never);
      const [imp] = await tx`insert into cms.cms_imports (kind, file_path, file_hash, options) values ('science_rationalise', 'science:rationalise',
        ${sha256Hex(readFileSync(new URL('./lib/science-splits.json', import.meta.url), 'utf8') + JSON.stringify(drafts))}, ${tx.json({ target: opts.target, dry_run: opts.dryRun } as never)}) returning import_id`;
      const importId = Number(imp!.import_id);
      res.import_id = importId;

      // 1. items
      const rows = await tx<{ row_id: string; misconceptions: string | null; content: string; sort: number }[]>`select row_id, misconceptions, content, sort from cms.cms_content_rows order by row_id`;
      res.items = await syncRowItems(tx, rows, importId, BY);
      const rowById = new Map(rows.map((r) => [r.row_id, r]));
      const itemsOf = new Map<string, Item[]>();
      const allItems: Item[] = [];
      for (const it of await tx<Item[]>`select row_id, item_no, text, status from cms.cms_row_misconceptions where status <> 'retired' order by row_id, item_no`) {
        itemsOf.set(it.row_id, [...(itemsOf.get(it.row_id) ?? []), it]); allItems.push(it);
      }

      // 2–5. questions (current versions of Science questions)
      const versions = await tx<{ version_id: string; question_id: string; version_no: number; status: string; text: string; correct: string; misconception_targeted: string | null;
        misconception_targeted_legacy: string | null; misconception_row_id: string | null }[]>`
        select v.version_id, q.question_id, v.version_no, v.status, v.text, v.correct, v.misconception_targeted, v.misconception_targeted_legacy, v.misconception_row_id
          from cms.cms_questions q join cms.cms_question_versions v on v.question_id = q.question_id and v.version_no = q.current_version
         where q.subject = 'science' and q.retired_at is null order by q.question_id`;
      res.questions.science_versions = versions.length;
      const oldText = new Map(versions.map((v) => [v.question_id, v.misconception_targeted]));
      for (const v of versions) {
        if (!['draft', 'in_review'].includes(v.status)) { res.questions.skipped_not_open.push(`${v.question_id} (v${v.version_no} ${v.status})`); continue; }
        res.questions.open++;
        const vid = Number(v.version_id);
        const [{ s: before }] = await tx`select cms.cms_science_review_state(${vid}) as s` as unknown as [{ s: Record<string, unknown> }];
        const changes: Record<string, unknown> = {};
        const links = await tx<{ row_id: string; role: 'direct' | 'supporting'; rank: string }[]>`select row_id, role, rank from cms.cms_question_content_rows where version_id = ${vid}`;
        const bySort = (a: { row_id: string }, b: { row_id: string }) => (rowById.get(a.row_id)?.sort ?? 0) - (rowById.get(b.row_id)?.sort ?? 0);
        const direct = links.filter((l) => l.role === 'direct').sort(bySort);
        const supporting = links.filter((l) => l.role === 'supporting').sort(bySort);

        // legacy copy
        const text = v.misconception_targeted_legacy ?? v.misconception_targeted;
        if (v.misconception_targeted && !v.misconception_targeted_legacy) {
          await tx`update cms.cms_question_versions set misconception_targeted_legacy = misconception_targeted where version_id = ${vid}`;
          res.legacy.copied++;
        }

        // misconception match (direct rows first, then supporting)
        const linkedItems = [...direct, ...supporting].flatMap((l) => itemsOf.get(l.row_id) ?? []);
        let miscRow: string | null = v.misconception_row_id;
        let pendingNewItem: string | null = null;
        if (text) res.questions.with_text++; else res.questions.none++;
        if (v.misconception_row_id) res.questions.already_done++;
        else if (text) {
          const m = matchItem(text, linkedItems);
          const line: QLine = { question_id: v.question_id, text: v.text.slice(0, 90), misconception: text };
          if (m.kind === 'exact' || m.kind === 'fuzzy' || m.kind === 'ambiguous') {
            miscRow = m.best!.row_id;
            await tx`update cms.cms_question_versions set misconception_row_id = ${m.best!.row_id}, misconception_item_no = ${m.best!.item_no} where version_id = ${vid}`;
            line.result = `${itemRef(m.best!)} "${m.best!.text}"`;
            if (m.kind === 'ambiguous') line.note = `candidates: ${m.candidates.map((c) => `${itemRef(c.item)} (${c.score.toFixed(2)})`).join(', ')}`;
            if (m.kind === 'fuzzy') line.note = `score ${m.candidates[0]!.score.toFixed(2)}`;
            res.questions[m.kind === 'exact' ? 'matched_exact' : m.kind === 'fuzzy' ? 'matched_fuzzy' : 'ambiguous'].push(line);
          } else {
            const linkedIds = new Set(links.map((l) => l.row_id));
            const elsewhere = matchItem(text, allItems.filter((i) => !linkedIds.has(i.row_id)));
            if (elsewhere.kind === 'exact' || elsewhere.kind === 'fuzzy') {
              const it = elsewhere.best!;
              await tx`insert into cms.cms_question_content_rows (version_id, row_id, role, rank) values (${vid}, ${it.row_id}, 'supporting', 'context')`;
              await tx`update cms.cms_question_versions set misconception_row_id = ${it.row_id}, misconception_item_no = ${it.item_no} where version_id = ${vid}`;
              changes.link_added = { before: null, after: `${it.row_id} (supporting)` };
              miscRow = it.row_id;
              res.questions.linked_supporting.push({ ...line, result: `${itemRef(it)} "${it.text}"`, note: `${elsewhere.kind}; row ${it.row_id} linked as supporting` });
            } else {
              pendingNewItem = text; // after the primary is known
              res.questions.unmatched_new_item.push({ ...line, proposal: '', note: elsewhere.kind === 'ambiguous' ? `near: ${elsewhere.candidates.map((c) => itemRef(c.item)).join(', ')}` : undefined });
            }
          }
        }
        if (v.misconception_targeted) await tx`update cms.cms_question_versions set misconception_targeted = null where version_id = ${vid}`;

        // primary
        if (links.some((l) => l.rank === 'primary')) res.primary.already++;
        else if (direct.length) {
          const p = proposePrimary(direct.map((l) => ({ row_id: l.row_id, content: rowById.get(l.row_id)?.content ?? '', sort: rowById.get(l.row_id)?.sort ?? 0 })), { text: v.text, correct: v.correct }, miscRow);
          await tx`update cms.cms_question_content_rows set rank = 'primary', rank_proposed = ${direct.length > 1} where version_id = ${vid} and row_id = ${p.row_id}`;
          if (direct.length > 1) res.primary.proposed.push({ question_id: v.question_id, primary: p.row_id, others: direct.map((l) => l.row_id).filter((r) => r !== p.row_id), reason: p.reason });
          else res.primary.set_single++;
          if (pendingNewItem) {
            const [{ n }] = await tx`select coalesce(max(item_no), 0) + 1 as n from cms.cms_row_misconceptions where row_id = ${p.row_id}` as unknown as [{ n: number }];
            await tx`insert into cms.cms_row_misconceptions (row_id, item_no, text, status, source, proposed_by, split_note, import_id)
              values (${p.row_id}, ${n}, ${pendingNewItem}, 'needs_review', 'from question', ${v.question_id}, 'proposed from the question''s misconception text', ${importId})`;
            await tx`insert into cms.cms_reviews (target, target_table, target_id, action, field_diff, by_label, import_id, reason)
              values ('catalogue', 'cms_row_misconceptions', ${`${p.row_id} #${n}`}, 'create', ${tx.json({ text: { before: null, after: pendingNewItem }, source: 'from question', status: 'needs_review' } as never)}, ${BY}, ${importId}, ${`proposed from ${v.question_id}'s misconception (no item on its rows)`})`;
            await tx`update cms.cms_question_versions set misconception_row_id = ${p.row_id}, misconception_item_no = ${n} where version_id = ${vid}`;
            const u = res.questions.unmatched_new_item[res.questions.unmatched_new_item.length - 1]!;
            u.proposal = `new item ${p.row_id} #${n} (needs review), or clear it`;
            itemsOf.set(p.row_id, [...(itemsOf.get(p.row_id) ?? []), { row_id: p.row_id, item_no: n, text: pendingNewItem, status: 'needs_review' }]);
          }
        }

        // wrong options
        const opts = await tx<{ position: number; text: string; is_correct: boolean }[]>`select position, text, is_correct from cms.cms_version_options where version_id = ${vid} and part_label = '' order by position`;
        const tagged = new Set((await tx`select option_position from cms.cms_version_wrong_answers where version_id = ${vid} and mc_row_id is not null`).map((r) => Number(r.option_position)));
        const nowItems = [...direct, ...supporting, ...(changes.link_added ? [{ row_id: miscRow! }] : [])].flatMap((l) => (itemsOf.get(l.row_id) ?? []).filter((i) => i.status !== 'needs_review'));
        for (const o of opts.filter((x) => !x.is_correct)) {
          if (tagged.has(o.position)) continue;
          const it = optionItem(o.text, nowItems);
          if (!it) { res.wrong_options.untagged.push({ question_id: v.question_id, position: o.position, option: o.text }); continue; }
          const u = await tx`update cms.cms_version_wrong_answers set tag = 'misconception', mc_row_id = ${it.row_id}, mc_item_no = ${it.item_no} where version_id = ${vid} and part_label = '' and option_position = ${o.position}`;
          if (!u.count) await tx`insert into cms.cms_version_wrong_answers (version_id, part_label, value, option_position, tag, mc_row_id, mc_item_no) values (${vid}, '', ${o.text}, ${o.position}, 'misconception', ${it.row_id}, ${it.item_no})`;
          res.wrong_options.tagged.push({ question_id: v.question_id, position: o.position, option: o.text, item: itemRef(it) });
        }

        // Solution 1
        const [sol] = await tx<{ text: string }[]>`select text from cms.cms_version_solutions where version_id = ${vid} and slot = 1`;
        const st = sol?.text?.trim() ?? '';
        if (st.length < SHORT_SOLUTION) {
          const d = drafts[v.question_id];
          if (d && d.text.trim() !== st) {
            if (sol) await tx`update cms.cms_version_solutions set text = ${d.text.trim()} where version_id = ${vid} and slot = 1`;
            else await tx`insert into cms.cms_version_solutions (version_id, slot, text) values (${vid}, 1, ${d.text.trim()})`;
            res.solutions.drafted.push({ question_id: v.question_id, before: st, after: d.text.trim() });
          } else if (!d) res.solutions.short_without_draft.push({ question_id: v.question_id, text: st, rows: links.map((l) => `${l.row_id} (${l.role})`) });
        } else if (!mentionsWrongOption(st, opts.filter((o) => !o.is_correct))) res.solutions.no_wrong_option.push(v.question_id);

        const [{ s: after }] = await tx`select cms.cms_science_review_state(${vid}) as s` as unknown as [{ s: Record<string, unknown> }];
        for (const k of Object.keys(after)) if (JSON.stringify(after[k]) !== JSON.stringify(before[k])) changes[k] = { before: before[k], after: after[k] };
        if (v.misconception_targeted) changes.misconception_text = { before: v.misconception_targeted, after: null, kept_in: 'misconception_targeted_legacy' };
        if (Object.keys(changes).length) {
          await tx`insert into cms.cms_reviews (target, target_table, target_id, action, reason, field_diff, by_label, import_id)
            values ('question_version', 'cms_question_versions', ${`${v.question_id} v${v.version_no}`}, 'science_rationalise',
                    'Science rationalisation (16 Nov 2026): misconception item, primary row, wrong options, Solution 1', ${tx.json(changes as never)}, ${BY}, ${importId})`;
        }
      }

      // stop conditions
      for (const v of versions) {
        const t = oldText.get(v.question_id);
        if (!t) continue;
        const [x] = await tx`select misconception_targeted_legacy as l, misconception_targeted as m from cms.cms_question_versions where version_id = ${Number(v.version_id)}`;
        if (x!.l !== t && x!.m !== t) res.legacy.lost.push(v.question_id);
      }
      res.guard.changed = guardDiff(pre, await guardDigest(tx as never));
      const withText = res.items!.rows_with_text || 1;
      res.thresholds.unclear_pct = Math.round((1000 * res.items!.unclear.length) / withText) / 10;
      res.thresholds.unmatched_pct = Math.round((1000 * res.questions.unmatched_new_item.length) / (res.questions.science_versions || 1)) / 10;
      const stop = [
        res.guard.changed.length ? `rows outside Science changed: ${res.guard.changed.join(', ')}` : null,
        res.legacy.lost.length ? `misconception text would be lost: ${res.legacy.lost.join(', ')}` : null,
        res.thresholds.unclear_pct > 10 ? `unclear splits ${res.thresholds.unclear_pct}% > 10%` : null,
        res.thresholds.unmatched_pct > 25 ? `unmatched ${res.thresholds.unmatched_pct}% > 25%` : null,
      ].filter(Boolean);
      if (stop.length) { res.stopped = stop.join('; '); throw new Rollback(res); }

      await tx`update cms.cms_imports set finished_at = now(), result = 'ok', counts = ${tx.json(counts(res) as never)} where import_id = ${importId}`;
      if (opts.dryRun) throw new Rollback(res);
    });
  } catch (e) {
    if (e instanceof Rollback) return e.result;
    throw e;
  }
  return res;
}

export const counts = (r: Report) => ({
  rows_with_text: r.items?.rows_with_text, rows_split: r.items?.rows_split, rows_whole: r.items?.rows_whole, unclear_splits: r.items?.unclear.length,
  items_created: r.items?.items_created, items_updated: r.items?.updated.length, items_retired: r.items?.retired.length,
  science_questions: r.questions.science_versions, open: r.questions.open, with_text: r.questions.with_text, no_misconception: r.questions.none,
  matched_exact: r.questions.matched_exact.length, matched_fuzzy: r.questions.matched_fuzzy.length, ambiguous: r.questions.ambiguous.length,
  linked_supporting: r.questions.linked_supporting.length, unmatched_new_item: r.questions.unmatched_new_item.length, already_done: r.questions.already_done,
  primary_single: r.primary.set_single, primary_proposed: r.primary.proposed.length, primary_already: r.primary.already,
  wrong_tagged: r.wrong_options.tagged.length, wrong_untagged: r.wrong_options.untagged.length,
  solutions_drafted: r.solutions.drafted.length, solutions_short_without_draft: r.solutions.short_without_draft.length, solutions_no_wrong_option: r.solutions.no_wrong_option.length,
  legacy_copied: r.legacy.copied,
});

export function markdown(r: Report): string {
  const c = counts(r);
  const L: string[] = [];
  L.push(`# science:rationalise · ${r.target.toUpperCase()} (${r.database})${r.dry_run ? ' · DRY RUN (rolled back)' : ''}${r.stopped ? ' · STOPPED' : ''}`, '');
  if (r.stopped) L.push(`**Stopped:** ${r.stopped}`, '');
  L.push('| Count | Value |', '|---|---|', ...Object.entries(c).map(([k, v]) => `| ${k.replace(/_/g, ' ')} | ${v} |`), '');
  L.push(`Thresholds: unclear splits ${r.thresholds.unclear_pct}% (stop > 10%) · unmatched ${r.thresholds.unmatched_pct}% (stop > 25%) · outside Science changed: ${r.guard.changed.length ? r.guard.changed.join(', ') : 'nothing'} · legacy lost: ${r.legacy.lost.length}`, '');
  const sec = (title: string, head: string, rows: string[]) => { L.push(`## ${title} (${rows.length})`, ''); if (rows.length) L.push(head, head.replace(/[^|]+/g, '---'), ...rows); L.push(''); };
  sec('Unclear splits', '| Row | Text | Items | Note |', (r.items?.unclear ?? []).map((u) => `| ${u.row_id} | ${u.text} | ${u.items.map((x, i) => `#${i + 1} ${x}`).join('<br>')} | ${u.note} |`));
  sec('Ambiguous misconceptions (best item set; please check)', '| Question | Misconception (legacy) | Set to | Candidates |', r.questions.ambiguous.map((q) => `| ${q.question_id} | ${q.misconception} | ${q.result} | ${q.note ?? ''} |`));
  sec('Matched only on an unlinked row → that row linked as supporting', '| Question | Misconception (legacy) | Item | Note |', r.questions.linked_supporting.map((q) => `| ${q.question_id} | ${q.misconception} | ${q.result} | ${q.note ?? ''} |`));
  sec('Unmatched → proposed new item (needs review) or clear', '| Question | Misconception (legacy) | Proposal | Note |', r.questions.unmatched_new_item.map((q) => `| ${q.question_id} | ${q.misconception} | ${q.proposal} | ${q.note ?? ''} |`));
  sec('Fuzzy matches (set)', '| Question | Misconception (legacy) | Item | Score |', r.questions.matched_fuzzy.map((q) => `| ${q.question_id} | ${q.misconception} | ${q.result} | ${q.note ?? ''} |`));
  sec('Primary row proposals (confirm in the Science review box)', '| Question | Proposed primary | Other direct rows | Why |', r.primary.proposed.map((p) => `| ${p.question_id} | ${p.primary} | ${p.others.join(', ')} | ${p.reason} |`));
  sec('Solution 1 drafted (in place, audited; stays Needs review)', '| Question | Before | After |', r.solutions.drafted.map((s) => `| ${s.question_id} | ${s.before} | ${s.after} |`));
  sec('Solution 1 short, no draft yet', '| Question | Text | Rows |', r.solutions.short_without_draft.map((s) => `| ${s.question_id} | ${s.text} | ${s.rows.join(', ')} |`));
  L.push(`## Solution 1 never mentions a wrong option (listed only, ${r.solutions.no_wrong_option.length})`, '', r.solutions.no_wrong_option.join(', ') || '—', '');
  sec('Wrong options tagged', '| Question | Option | Text | Item |', r.wrong_options.tagged.map((w) => `| ${w.question_id} | ${String.fromCharCode(64 + w.position)} | ${w.option} | ${w.item} |`));
  L.push(`## Wrong options left untagged (${r.wrong_options.untagged.length})`, '', r.wrong_options.untagged.map((w) => `${w.question_id} ${String.fromCharCode(64 + w.position)}`).join(', ') || '—', '');
  if (r.items?.updated.length) sec('Items updated in place', '| Item | Before | After | Questions |', r.items.updated.map((u) => `| ${u.ref} | ${u.before} | ${u.after} | ${u.questions.join(', ') || '—'} |`));
  if (r.questions.skipped_not_open.length) L.push(`Not open (left alone): ${r.questions.skipped_not_open.join(', ')}`, '');
  return L.join('\n');
}

if (import.meta.filename === process.argv[1]) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const host = new URL(targetUrl()).hostname;
  const target = host === '127.0.0.1' || host === 'localhost' ? 'local' as const : 'real' as const;
  if (target === 'real' && !dryRun && !args.includes('--confirm-real')) { console.error('Refused: a real run needs --confirm-real (after a clean dry run).'); process.exit(1); }
  const sql = connect();
  try {
    await assertCmsOwner(sql);
    const r = await rationalise(sql, { dryRun, target });
    const dir = join(import.meta.dirname, '..', '.local-import'); mkdirSync(dir, { recursive: true });
    const base = join(dir, `science-rationalise-${target}${dryRun ? '-dry-run' : ''}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}`);
    writeFileSync(`${base}.json`, JSON.stringify(r, null, 2) + '\n');
    writeFileSync(`${base}.md`, markdown(r) + '\n');
    console.log(JSON.stringify(counts(r), null, 1));
    console.log(`${r.stopped ? `STOPPED: ${r.stopped}\n` : ''}Report: ${base}.md`);
    if (r.stopped) process.exitCode = 2;
  } finally { await sql.end(); }
}
