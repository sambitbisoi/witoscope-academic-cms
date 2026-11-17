// Q31 (S6, Round 2, 17 Nov 2026): review warnings for a Science question. They NEVER block approval; they are shown
// in the Edit Save box, the Science review box and the question page. Plus §10.7 of the Round 2 plan: setting and
// familiarity should agree (Bare ⇔ no setting).
import type { ScienceDerived } from './science-derive.ts';

export interface WarningRow {
  row_id: string; role: string; rank?: string | null; source?: string | null; chapter_role?: string | null; row_class?: number | null;
  safety?: string | null; question_use?: string | null;
}
export interface ScienceWarningInput {
  science_question_type?: number | null; has_irrelevant_info: boolean | null; has_hidden_idea?: boolean | null;
  reading: number | null; setting_familiarity?: string | null; setting_id?: string | null;
  /** the question's Level (written for class) */ level: number | null;
  rows: WarningRow[]; derived: Pick<ScienceDerived, 'markers' | 'markerList'>;
}

export function scienceWarnings(x: ScienceWarningInput): string[] {
  const out: string[] = [];
  const t = x.science_question_type ?? null;
  const m = x.derived.markers;
  if (t !== null && t <= 3 && m >= 2) out.push(`Type ${t} (School) has ${m} markers (${x.derived.markerList.join(', ')}): is it really type 4 or 5?`);
  if (t === 5 && m < 2) out.push(`Type 5 (Super Achiever) has ${m} marker${m === 1 ? '' : 's'}${m ? ` (${x.derived.markerList.join(', ')})` : ''}: it usually has 2 or more.`);
  if (t === 1 || t === 2) {
    const why = [x.has_irrelevant_info === true && 'irrelevant info', x.has_hidden_idea === true && 'a hidden idea', x.reading !== null && x.reading > 2 && `Reading ${x.reading}`]
      .filter((s): s is string => !!s);
    if (why.length) out.push(`Type ${t} with ${why.join(', ')}: a Fact or Basic question is usually plain.`);
  }
  if (t === 1) {
    const p = x.rows.find((r) => r.rank === 'primary');
    if (p && !(p.source === 'Book' && p.chapter_role === 'Core')) out.push(`Type 1 (Fact) but its primary row ${p.row_id} is ${p.source ?? '—'} · ${p.chapter_role ?? '—'} (a Fact usually comes from a Book · Core row).`);
  }
  if (x.level !== null) for (const r of x.rows) {
    if ((r.rank === 'primary' || r.rank === 'secondary') && r.row_class && r.row_class > x.level) out.push(`${r.rank === 'primary' ? 'Primary' : 'Secondary'} row ${r.row_id} is Class ${r.row_class}, above the question's Level ${x.level}.`);
  }
  for (const r of x.rows) {
    if (r.safety?.trim()) out.push(`Linked row ${r.row_id} has a safety note: check the question respects it.`);
    if (r.question_use === 'No questions') out.push(`Linked row ${r.row_id} is marked "No questions".`);
  }
  if (x.setting_familiarity && x.setting_familiarity !== 'Bare' && !x.setting_id) out.push(`Setting familiarity is ${x.setting_familiarity} but there is no setting (blank = bare).`);
  if (x.setting_familiarity === 'Bare' && x.setting_id) out.push(`Setting familiarity is Bare but a setting (${x.setting_id}) is set.`);
  return out;
}
