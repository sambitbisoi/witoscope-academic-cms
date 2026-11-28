// Q38 PR 3 (plan §0.2 / Q9, Sambit 23 Nov 2026): the CMS text wins; QuestionBank is re-synced from a CMS export.
//
//   npm run export:bank-sync [-- --out <dir>]                          local database
//   npx tsx --env-file=.env.real.reader scripts/export-bank-sync.ts    real project, as cms_reader (read-only)
//
// Compares every QuestionBank chapter file key (QuestionBank/*/(MC|SC|GC)##-C#.json; our own questions, *.book.json never
// opened) with the CURRENT CMS version of the question holding that key, field by field: text, hints, solutions.
// Writes, per bank file that needs a change, <out>/<folder>/<file>.sync.json with the CMS values to write back
// (keys never change: a bank key the CMS holds under another key is listed as a rename for the QuestionBank session,
// not rewritten). It never edits QuestionBank; applying the sync files is the QuestionBank session's step (plan §12, item 4).
// Our own question wording only; nothing book-derived.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { connect, targetUrl } from './lib/db.ts';
import { QB_DIR } from './lib/id-blocks.ts';

const args = process.argv.slice(2);
const opt = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] ?? null : null; };
const norm = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim();
const url = targetUrl(), host = new URL(url).hostname;
const target = host === '127.0.0.1' || host === 'localhost' ? (new URL(url).pathname === '/cms_rehearsal' ? 'rehearsal' : 'local') : 'real';
const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '');
const out = resolve((opt('--out') ?? join(import.meta.dirname, '..', '.local-import', `bank-sync-${target}-${stamp}`)).replace(/^~/, homedir()));

interface BankQ { key: string; text?: string; hints?: string[]; solutions?: Record<string, string> }
const files: { folder: string; file: string; questions: BankQ[] }[] = [];
for (const d of readdirSync(QB_DIR, { withFileTypes: true }).filter((x) => x.isDirectory() && !x.name.startsWith('_'))) {
  for (const f of readdirSync(join(QB_DIR, d.name)).filter((n) => /^(MC|SC|GC)\d{2}-C\d\.json$/.test(n))) {
    try { files.push({ folder: d.name, file: f, questions: JSON.parse(readFileSync(join(QB_DIR, d.name, f), 'utf8')).questions ?? [] }); } catch { /* skip */ }
  }
}
const keys = [...new Set(files.flatMap((f) => f.questions.map((q) => q.key)))];

const sql = connect();
type Cur = { file_key: string; question_id: string; version_no: number; status: string; text: string; t1: string; hints: string[]; solutions: { slot: number; type: string | null; text: string }[] };
const cur = await sql.begin('read only', async (tx) => tx<Cur[]>`
  select q.file_key, q.question_id, v.version_no, v.status, v.text, v1.text as t1,
         coalesce((select array_agg(h.text order by h.level) from cms.cms_version_hints h where h.version_id = v.version_id), '{}') as hints,
         coalesce((select jsonb_agg(jsonb_build_object('slot', s.slot, 'type', s.type, 'text', s.text) order by s.slot) from cms.cms_version_solutions s where s.version_id = v.version_id), '[]') as solutions
    from cms.cms_questions q
    join cms.cms_question_versions v on v.question_id = q.question_id and v.version_no = q.current_version
    join cms.cms_question_versions v1 on v1.question_id = q.question_id and v1.version_no = 1
   where q.file_key = any(${keys})`);
// a bank key whose question the CMS holds under another key (same text as some CMS question's v1): a rename, listed only
const byText = await sql.begin('read only', async (tx) => tx<{ file_key: string; t: string }[]>`
  select q.file_key, v1.text as t from cms.cms_questions q join cms.cms_question_versions v1 on v1.question_id = q.question_id and v1.version_no = 1
   where q.subject = 'math' and q.file_key is not null`);
await sql.end();
const cms = new Map(cur.map((c) => [c.file_key, c]));
const keyOfText = new Map(byText.map((r) => [norm(r.t), r.file_key]));

const tally = { bank_keys: keys.length, unchanged: 0, text: 0, hints: 0, solutions: 0, not_in_cms: 0, renames: 0, files_to_sync: 0 };
const renames: { bank_key: string; cms_key: string; file: string }[] = [], notInCms: string[] = [];
mkdirSync(out, { recursive: true });
for (const f of files) {
  const changes: Record<string, unknown>[] = [];
  for (const q of f.questions) {
    const c = cms.get(q.key);
    if (!c) {   // the CMS has no question under this key: a rename (it holds the same question under another key) or not imported
      const other = keyOfText.get(norm(q.text));
      if (other) { renames.push({ bank_key: q.key, cms_key: other, file: `${f.folder}/${f.file}` }); tally.renames++; } else { notInCms.push(q.key); tally.not_in_cms++; }
      continue;
    }
    const diff: string[] = [];
    if (norm(q.text) !== norm(c.text)) diff.push('text');
    const bh = (q.hints ?? []).map(norm), ch = c.hints.map(norm);
    if (JSON.stringify(bh) !== JSON.stringify(ch)) diff.push('hints');
    const bs = Object.values(q.solutions ?? {}).map(norm).sort(), cs = c.solutions.map((s) => norm(s.text)).sort();
    if (JSON.stringify(bs) !== JSON.stringify(cs)) diff.push('solutions');
    if (!diff.length) { tally.unchanged++; continue; }
    for (const d of diff) tally[d as 'text' | 'hints' | 'solutions']++;
    changes.push({ key: q.key, question_id: c.question_id, cms_version: c.version_no, cms_status: c.status, fields: diff,
      ...(diff.includes('text') ? { text: c.text } : {}), ...(diff.includes('hints') ? { hints: c.hints } : {}),
      ...(diff.includes('solutions') ? { solutions: c.solutions } : {}) });
  }
  if (!changes.length) continue;
  tally.files_to_sync++;
  mkdirSync(join(out, f.folder), { recursive: true });
  writeFileSync(join(out, f.folder, f.file.replace(/\.json$/, '.sync.json')), JSON.stringify({ file_schema: 'bank-sync/1', target, generated_at: new Date().toISOString(),
    bank_file: `${f.folder}/${f.file}`, rule: 'CMS wins (Q9); keys never change', changes }, null, 1) + '\n');
}
writeFileSync(join(out, 'summary.json'), JSON.stringify({ target, generated_at: new Date().toISOString(), tally, renames, bank_keys_not_in_cms: notInCms }, null, 1) + '\n');
console.log(`export:bank-sync from ${target}: ${tally.bank_keys} bank keys · ${tally.unchanged} unchanged · to write back: text ${tally.text}, hints ${tally.hints}, solutions ${tally.solutions} · `
  + `${tally.files_to_sync} bank files · renames ${renames.map((r) => `${r.bank_key} → ${r.cms_key}`).join(', ') || 'none'} · not in CMS ${notInCms.join(', ') || 'none'}`);
console.log(`Sync files (our own wording; QuestionBank is not touched): ${out.replace(homedir(), '~')}`);
