// English (Grammar) E1: the Q41 curriculum sync from the Grammar sheet (plan docs/plan-2026-11-28-english-grammar.md §2).
//
// Reads the sheet's Topic map rows 2–194 only (the purple Reading rows 195–223 are F2 and never synced), compares them with
// the CMS, and writes the differences through the CMS's own audited functions: cms_save_curriculum (topics: create with a
// registry-reserved ID, rename, home class, class links) and cms_save_order (where a new or re-homed topic sits in its
// chapter for its home class). Nothing is deleted; topics and chapters are never removed.
import { readFileSync } from 'node:fs';
import type { Sql } from './db.ts';
import { readWorkbook, type Cell } from './xlsx.ts';

export const SHEET_REVISION = 'r30';
export const BY_LABEL = `grammar:sync ${SHEET_REVISION}`;
export const NEW_LINK_SOURCE = `Grammar sheet ${SHEET_REVISION}`;
export const NEW_LINK_EVIDENCE = 'Q41 sync (Sambit 28 Nov 2026): class tick on the Grammar sheet';
export const LAST_TOPIC_ROW = 194;

export interface SheetTopic {
  row: number; chapter_id: string; chapter: string; sheet_id: string; name: string; home: number; ticks: number[];
  ixl: string; ncert: string; dav: string; sub_skills: string; notes: string; strand: string;
}
const s = (c: Cell | undefined) => (c === null || c === undefined ? '' : String(c).trim());

/** Topic map rows 2–194 (by header name). Refuses a Reading row (RD-…, GC42–GC48) in that range. */
export async function readSheetTopics(path: string): Promise<{ topics: SheetTopic[]; sha256: string; reading_rows: number }> {
  const w = await readWorkbook(path);
  const rows = w.sheets.get('Topic map');
  if (!rows) throw new Error(`${path}: no "Topic map" tab`);
  const need = ['Chapter ID', 'Chapter', 'Topic ID', 'Topic', 'Home class', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'IXL classes', 'NCERT classes', 'DAV classes', 'Sub-skills', 'Notes', 'Strand'];
  const have = new Set(rows.flatMap((r) => Object.keys(r.values)));
  const missing = need.filter((h) => !have.has(h) && !['IXL classes', 'NCERT classes', 'DAV classes', 'Sub-skills', 'Notes'].includes(h));
  if (missing.length) throw new Error(`Topic map: missing column(s) ${missing.join(', ')}`);
  const topics: SheetTopic[] = [];
  let reading = 0;
  for (const r of rows) {
    const v = (h: string) => s(r.values[h]);
    const id = v('Topic ID');
    if (!id && !v('Topic')) continue;
    if (r.row > LAST_TOPIC_ROW) { reading++; continue; }
    if (/^RD-/.test(id) || /^GC4[2-8]$/.test(v('Chapter ID'))) throw new Error(`Topic map row ${r.row} (${id}) is a Reading row inside rows 2–${LAST_TOPIC_ROW}: refused (F2 is not synced)`);
    const ticks = [1, 2, 3, 4, 5, 6].filter((c) => v(`C${c}`) === '✓');
    topics.push({ row: r.row, chapter_id: v('Chapter ID'), chapter: v('Chapter'), sheet_id: id, name: v('Topic'), home: Number(v('Home class')), ticks,
      ixl: v('IXL classes'), ncert: v('NCERT classes'), dav: v('DAV classes'), sub_skills: v('Sub-skills'), notes: v('Notes'), strand: v('Strand') });
  }
  return { topics, sha256: w.sha256, reading_rows: reading };
}

/** docs/grammar/new-id-mapping-*.csv: topic rows old_id → new_id. */
export function readTopicMapping(path: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of readFileSync(path, 'utf8').split('\n').slice(1)) {
    const [kind, oldId, newId] = line.split(',');
    if (kind === 'topic' && oldId && newId) m.set(oldId, newId);
  }
  return m;
}

// ---------------------------------------------------------------- the CMS side
export interface DbLink { class: number; source: string; evidence: string | null }
export interface DbTopic { topic_id: string; chapter_id: string; class: number; name: string; status: string; topic_kind: string; links: DbLink[] }
export interface DbState { topics: Map<string, DbTopic>; chapters: Set<string>; order: Map<string, string[]>; reservedGT: [number, number][] }
export const orderKey = (cls: number, chapter: string) => `${cls}|${chapter}`;

export async function readDbState(sql: Sql): Promise<DbState> {
  const topics = await sql<DbTopic[]>`select t.topic_id, t.chapter_id, t.class, t.name, t.status, t.topic_kind,
      coalesce((select jsonb_agg(jsonb_build_object('class', c.class, 'source', c.source, 'evidence', c.evidence) order by c.class)
                  from cms.cms_topic_classes c where c.topic_id = t.topic_id), '[]') as links
    from cms.cms_topics t join cms.cms_chapters ch on ch.chapter_id = t.chapter_id where ch.subject = 'grammar'`;
  const chapters = await sql<{ chapter_id: string }[]>`select chapter_id from cms.cms_chapters where subject = 'grammar'`;
  // the sequenced core order per (class, chapter), as the CMS shows it: ordered rows first, then unordered core topics by ID
  const ord = await sql<{ class: number; chapter_id: string; ids: string[] }[]>`
    select t.class, t.chapter_id,
           array_agg(t.topic_id order by (o.position is null), o.position, t.topic_id) as ids
      from cms.cms_topics t join cms.cms_chapters ch on ch.chapter_id = t.chapter_id
      left join cms.cms_topic_order o on o.topic_id = t.topic_id and o.class = t.class and o.chapter_id = t.chapter_id
     where ch.subject = 'grammar' and t.topic_kind = 'normal'
     group by t.class, t.chapter_id`;
  const rsv = await sql<{ first_no: number; last_no: number }[]>`select first_no, last_no from cms.cms_key_reservations where kind = 'topic' and prefix = 'GT' and status = 'reserved'`;
  return {
    topics: new Map(topics.map((t) => [t.topic_id, { ...t, class: Number(t.class), links: (t.links as unknown as DbLink[]).map((l) => ({ ...l, class: Number(l.class) })) }])),
    chapters: new Set(chapters.map((c) => c.chapter_id)),
    order: new Map(ord.map((o) => [orderKey(Number(o.class), o.chapter_id), o.ids])),
    reservedGT: rsv.map((r) => [Number(r.first_no), Number(r.last_no)]),
  };
}

// ---------------------------------------------------------------- the plan (pure)
export interface TopicPlan {
  topic_id: string; sheet_id: string; row: number; action: 'create' | 'update' | 'unchanged';
  fields: Record<string, unknown>; changes: string[];
}
export interface OrderPlan { class: number; chapter_id: string; before: string[]; after: string[]; placed: string[] }
export interface SyncPlan { topics: TopicPlan[]; order: OrderPlan[]; problems: string[]; counts: Record<string, number> }

const sourceFor = (t: SheetTopic, cls: number) => {
  const has = (v: string) => { if (!v) return false; for (const part of v.split(/[,;]\s*/)) { const m = /^(\d)(?:\s*[–-]\s*(\d))?$/.exec(part.trim()); if (m && cls >= Number(m[1]) && cls <= Number(m[2] ?? m[1])) return true; } return false; };
  const src = [has(t.ncert) ? 'NCERT' : '', has(t.dav) ? 'DAV' : '', has(t.ixl) ? 'IXL' : ''].filter(Boolean);
  return src.length ? `${NEW_LINK_SOURCE}; ${src.join('; ')}` : NEW_LINK_SOURCE;
};

export function planSync(sheet: SheetTopic[], db: DbState, mapping: Map<string, string>, expectTopics = 193): SyncPlan {
  const problems: string[] = [];
  if (sheet.length !== expectTopics) problems.push(`the sheet has ${sheet.length} topics in rows 2–${LAST_TOPIC_ROW}; expected ${expectTopics}`);
  const seen = new Set<string>();
  const plans: TopicPlan[] = [];
  const idOf = (t: SheetTopic) => (/^NEW-\d+$/.test(t.sheet_id) ? mapping.get(t.sheet_id) ?? null : t.sheet_id);
  for (const t of sheet) {
    const id = idOf(t);
    if (!id) { problems.push(`row ${t.row}: ${t.sheet_id} has no GT ID in the mapping file`); continue; }
    if (seen.has(id)) problems.push(`row ${t.row}: ${id} appears twice`); seen.add(id);
    if (!db.chapters.has(t.chapter_id)) problems.push(`row ${t.row}: chapter ${t.chapter_id} is not a Grammar chapter in the CMS (new chapters are not part of Q41)`);
    if (!(t.home >= 1 && t.home <= 6)) problems.push(`row ${t.row}: home class "${t.home}"`);
    if (!t.ticks.includes(t.home)) problems.push(`row ${t.row}: ${id} is not ticked for its home class ${t.home}`);
    if (!t.name) problems.push(`row ${t.row}: no topic name`);
    const cur = db.topics.get(id);
    const desiredLinks = t.ticks.map((c) => cur?.links.find((l) => l.class === c) ?? { class: c, source: sourceFor(t, c), evidence: NEW_LINK_EVIDENCE });
    if (!cur) {
      if (!/^NEW-/.test(t.sheet_id)) { problems.push(`row ${t.row}: ${id} is not in the CMS`); continue; }
      const n = Number(id.slice(2));
      if (!db.reservedGT.some(([a, z]) => n >= a && n <= z)) problems.push(`row ${t.row}: ${id} (${t.sheet_id}) is not in an open GT reservation; reserve first (npm run keys -- reserve --kind topic --prefix GT --count 9 --purpose "Q41 NEW-01…09")`);
      const flags: Record<string, string> = {}; if (t.ixl) flags.ixl = t.ixl; if (t.ncert) flags.ncert = t.ncert; if (t.dav) flags.dav = t.dav;
      plans.push({ topic_id: id, sheet_id: t.sheet_id, row: t.row, action: 'create', changes: [`create in ${t.chapter_id}, home ${t.home}, classes ${t.ticks.join(',')}`],
        fields: { topic_id: id, chapter_id: t.chapter_id, class: t.home, name: t.name, sub_skills: t.sub_skills || null, notes: t.notes || null,
          source_flags: flags, taught_in_school: !!(t.ncert || t.dav), classes: desiredLinks } });
      continue;
    }
    if (cur.status !== 'active') problems.push(`row ${t.row}: ${id} is ${cur.status} in the CMS`);
    if (cur.chapter_id !== t.chapter_id) problems.push(`row ${t.row}: ${id} is in ${cur.chapter_id} in the CMS, ${t.chapter_id} in the sheet (chapter moves are not part of Q41)`);
    const fields: Record<string, unknown> = {}; const changes: string[] = [];
    if (cur.name !== t.name) { fields.name = t.name; changes.push(`rename "${cur.name}" → "${t.name}"`); }
    if (cur.class !== t.home) { fields.class = t.home; changes.push(`home class ${cur.class} → ${t.home}`); }
    const have = cur.links.map((l) => l.class).sort(), want = [...t.ticks].sort();
    if (have.join() !== want.join()) { fields.classes = desiredLinks; changes.push(`classes ${have.join(',')} → ${want.join(',')}`); }
    plans.push({ topic_id: id, sheet_id: t.sheet_id, row: t.row, action: changes.length ? 'update' : 'unchanged', fields, changes });
  }
  for (const id of db.topics.keys()) if (!seen.has(id) && db.topics.get(id)!.status === 'active' && db.topics.get(id)!.topic_kind === 'normal')
    problems.push(`${id} is active in the CMS but not in the sheet (Q41 removes no topic)`);

  // order: every new or re-homed topic goes right after the topic above it in the sheet, in its home class and chapter
  const homeOf = new Map(plans.map((p) => [p.topic_id, Number(p.fields.class ?? db.topics.get(p.topic_id)?.class)]));
  const placed = plans.filter((p) => p.action === 'create' || p.fields.class !== undefined);
  const lists = new Map<string, OrderPlan>();
  const sheetIds = sheet.map(idOf);
  for (const p of placed) {
    const cls = homeOf.get(p.topic_id)!, ch = sheet.find((t) => t.row === p.row)!.chapter_id, key = orderKey(cls, ch);
    if (!lists.has(key)) {
      const cur = (db.order.get(key) ?? []).filter((x) => x !== p.topic_id && !placed.some((q) => q.topic_id === x));
      lists.set(key, { class: cls, chapter_id: ch, before: db.order.get(key) ?? [], after: cur, placed: [] });
    }
    const l = lists.get(key)!;
    // after the nearest sheet row above it in the same chapter whose topic is already in this list; otherwise first
    let at = -1;
    for (let i = sheetIds.indexOf(p.topic_id) - 1; i >= 0; i--) {
      if (sheet[i]!.chapter_id !== ch) continue;
      const k = l.after.indexOf(sheetIds[i]!); if (k >= 0) { at = k; break; }
    }
    l.after.splice(at + 1, 0, p.topic_id);
    l.placed.push(p.topic_id);
  }
  const order = [...lists.values()].filter((l) => l.before.join() !== l.after.join());
  const counts = {
    created: plans.filter((p) => p.action === 'create').length,
    renamed: plans.filter((p) => p.fields.name !== undefined && p.action === 'update').length,
    home_class: plans.filter((p) => p.fields.class !== undefined && p.action === 'update').length,
    class_links: plans.filter((p) => p.fields.classes !== undefined && p.action === 'update').length,
    unchanged: plans.filter((p) => p.action === 'unchanged').length,
    order_lists: order.length,
  };
  return { topics: plans, order, problems, counts };
}

// ---------------------------------------------------------------- apply (one topic per unit; then the order lists)
export interface ApplyResult { topic_id: string; action: string; result: string }
export async function applyTopic(sql: Sql, adminId: string, p: TopicPlan): Promise<ApplyResult> {
  if (p.action === 'unchanged') return { topic_id: p.topic_id, action: 'unchanged', result: 'unchanged' };
  await sql`select set_config('request.jwt.claims', ${JSON.stringify({ sub: adminId, role: 'authenticated' })}, true)`;
  const payload = p.action === 'create'
    ? { kind: 'topic', action: 'create', fields: p.fields, reason: `Q41: ${p.sheet_id} from the Grammar sheet ${SHEET_REVISION} (row ${p.row})`, by_label: BY_LABEL }
    : { kind: 'topic', action: 'update', id: p.topic_id, fields: p.fields, reason: `Q41: ${p.changes.join('; ')} (Grammar sheet ${SHEET_REVISION}, row ${p.row})`, by_label: BY_LABEL };
  const [r] = await sql`select cms.cms_save_curriculum(${sql.json(payload as never)}) as r`;
  const got = (r!.r as { id?: string }).id;
  if (p.action === 'create' && got && got !== p.topic_id) throw new Error(`created ${got}, expected ${p.topic_id}`);
  return { topic_id: p.topic_id, action: p.action, result: p.changes.join('; ') };
}
export async function applyOrder(sql: Sql, adminId: string, o: OrderPlan): Promise<void> {
  await sql`select set_config('request.jwt.claims', ${JSON.stringify({ sub: adminId, role: 'authenticated' })}, true)`;
  await sql`select cms.cms_save_order(${sql.json({ subject: 'grammar', class: o.class, lists: [{ level: 'topic', parent_id: o.chapter_id, ids: o.after }] } as never)})`;
}
