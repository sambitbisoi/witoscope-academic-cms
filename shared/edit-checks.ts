// T1 (17 Nov 2026): checks for the question editor, by subject.
//   Math / Grammar: exactly the chapter-file checks (checkFile), as before.
//   Science: no typical set, pattern or concepts. Wrong-option tags are optional, but a misconception tag must be an
//   item (active or needs review) of one of the question's own content rows (0035 rules). The Science signature may be
//   unset; a value that is set must be in range.
//   Q32 (0041): Science wrong options may use Math's 9 tags; a concept error needs a target row from the linked rows.
//   Untagged is valid. Q26: the Science question attributes may be unset (the type is required only to approve).
import { checkFile, type Catalog } from './checks.ts';
import { SETTING_FAMILIARITY, type Answer, type ChapterFile, type Problem, type Question } from './types.ts';

export interface RowItemRef { row_id: string; item_no: number; text: string; status: string }
export interface EditCheckContext {
  subject: string; ruleVersion: string; cls: number; chapterId: string; catalog: Catalog;
  /** Science: the question's linked content rows and their misconception items */
  linkedRows?: string[]; rowItems?: RowItemRef[];
  /** Science (Q28): the settings a Science question may use (Science settings, not retired) */
  settings?: Set<string>;
}

const OPTION_COUNT: Partial<Record<Answer['format'], number>> = { 'MCQ-4': 4, 'MCQ-3': 3, 'True/False': 2 };
const SCIENCE_FORMATS: Answer['format'][] = ['MCQ-4', 'MCQ-3', 'True/False', 'Typed-number', 'Typed-decimal', 'Typed-fraction', 'Typed-text'];

export function checkEdit(q: Question, ctx: EditCheckContext): Problem[] {
  if (ctx.subject !== 'science') {
    const file: ChapterFile = { file_schema: 'cms-chapter/1.0', attribute_version: ctx.ruleVersion, subject: ctx.subject as 'math',
      class: ctx.cls, chapter_id: ctx.chapterId, generated: { by: 'CMS editor', date: new Date().toISOString().slice(0, 10) }, questions: [q] };
    return checkFile(file, ctx.catalog, { gold: true }).filter((p) => p.key !== 'file' || p.level === 'error');
  }
  return checkScience(q, ctx);
}

function checkScience(q: Question, ctx: EditCheckContext): Problem[] {
  const out: Problem[] = [];
  const err = (message: string) => out.push({ level: 'error', key: q.key, message });
  const warn = (message: string) => out.push({ level: 'warning', key: q.key, message });
  if (!q.text.trim()) err('question text is empty');
  const topic = ctx.catalog.topics.get(q.topic_id);
  if (!topic) err(`topic ${q.topic_id} does not exist`);
  else if (topic.status !== 'active') err(`topic ${q.topic_id} is ${topic.status}`);

  const a = q.answer;
  if (!SCIENCE_FORMATS.includes(a.format)) err(`format ${a.format} is not used for Science`);
  const need = OPTION_COUNT[a.format];
  const linked = new Set(ctx.linkedRows ?? []);
  const items = new Map((ctx.rowItems ?? []).map((i) => [`${i.row_id} #${i.item_no}`, i]));
  if (need !== undefined) {
    const opts = a.options ?? [];
    if (opts.length !== need) err(`${a.format} needs ${need} options, found ${opts.length}`);
    if (opts.some((o) => !o.trim())) err('an option is empty');
    if (new Set(opts).size !== opts.length) err('options repeat a value');
    if (!opts.includes(a.correct)) err(`correct answer "${a.correct}" is not one of the options`);
  } else if (!a.correct.trim()) err('the correct answer is empty');
  for (const w of a.wrong_answers ?? []) {
    if (w.value === a.correct) err('the correct answer is also tagged as wrong');
    if (need !== undefined && !(a.options ?? []).includes(w.value)) warn(`wrong answer "${w.value}" is not one of the options`);
    if (w.tag === 'misconception' && !w.mc && !w.misconception_id) err(`wrong option "${w.value}": choose a misconception item of its content rows, or none`);
    if (w.tag === 'concept_error' && !w.target_row_id && !w.target_concept_id) err(`wrong option "${w.value}": a concept error needs a target row from its content rows`);
    if (w.target_row_id) {
      if (w.tag !== 'concept_error') err(`wrong option "${w.value}": a target row goes only with a concept error`);
      else if (!linked.has(w.target_row_id)) err(`wrong option "${w.value}": ${w.target_row_id} is not one of this question's content rows`);
    }
    if (w.mc) {
      const ref = `${w.mc.row_id} #${w.mc.item_no}`;
      const it = items.get(ref);
      if (!linked.has(w.mc.row_id)) err(`wrong option "${w.value}": ${ref} is not an item of this question's content rows`);
      else if (!it) err(`wrong option "${w.value}": ${ref} does not exist`);
      else if (it.status === 'retired') err(`wrong option "${w.value}": ${ref} is retired`);
      else if (it.status === 'needs_review') warn(`wrong option "${w.value}": ${ref} still needs review (approval waits for it)`);
    }
  }
  const sc = q.science;
  if (sc) {
    const range = (label: string, v: number | null, min: number, max: number) => {
      if (v !== null && (!Number.isInteger(v) || v < min || v > max)) err(`${label} must be a whole number from ${min} to ${max}`);
    };
    range('Reading', sc.reading, 1, 5); range('Steps', sc.steps, 1, 20); range('Inhibition', sc.inhibition, 0, 3); range('Visual', sc.visual, 0, 3);
    range('Science question type', sc.science_question_type ?? null, 1, 5);
    if (sc.setting_familiarity && !SETTING_FAMILIARITY.includes(sc.setting_familiarity)) err(`setting familiarity "${sc.setting_familiarity}" is not one of ${SETTING_FAMILIARITY.join(', ')}`);
    if (sc.setting_id && ctx.settings && !ctx.settings.has(sc.setting_id)) err(`setting ${sc.setting_id} is not a Science setting`);
  }
  if (q.figure && !q.figure.description.trim()) err('the figure needs a description');
  return out;
}

/** Science: the attribute fields still unset (approval waits until all are set; the database clears the flag). */
export const scienceAttributesMissing = (q: Question) => {
  const sc = q.science;
  if (!sc) return [];
  return ([['Reading', sc.reading], ['Steps', sc.steps], ['Inhibition', sc.inhibition], ['Visual', sc.visual], ['Irrelevant info', sc.has_irrelevant_info]] as const)
    .filter(([, v]) => v === null).map(([k]) => k);
};
