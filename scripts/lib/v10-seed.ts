// Pure parsing of the v10 workbook's catalogue, rules and gold sheets (design §7).
// Every interpretation that is not a straight copy is marked [guess] and listed
// in docs/phase2-plan.md for Sambit's check.
import type { Answer, ConceptRef, Format, Question, WrongAnswer } from './chapter/types.ts';
import type { Cell } from './xlsx.ts';

export interface SeedProblem { level: 'error' | 'warning'; where: string; message: string }
type Rec = Record<string, Cell>;

/** Rows below the header row whose first cell is `firstHeader` (title and note rows above are skipped). */
export function table(raw: Cell[][] | undefined, firstHeader: string, sheet: string): { row: number; v: Rec }[] {
  if (!raw) throw new Error(`sheet "${sheet}" is missing`);
  const h = raw.findIndex((r) => String(r[0] ?? '').trim() === firstHeader);
  if (h < 0) throw new Error(`${sheet}: header row starting "${firstHeader}" not found`);
  const headers = raw[h]!.map((c) => String(c ?? '').trim());
  return raw.slice(h + 1)
    .map((r, i) => ({ row: h + 2 + i, v: Object.fromEntries(headers.map((k, j) => [k, r[j] ?? null])) as Rec }))
    .filter(({ v }) => Object.values(v).some((c) => c !== null && String(c).trim() !== ''));
}

const s = (c: Cell | undefined) => (c === null || c === undefined ? null : String(c).trim() || null);
const yes = (c: Cell | undefined) => /^yes\b/i.test(String(c ?? '').trim());
const draft = (c: Cell | undefined) => (/^draft/i.test(String(c ?? '')) ? 'draft' : 'active');
const list = (c: Cell | undefined, sep: RegExp) => (s(c) ?? '').split(sep).map((x) => x.trim()).filter(Boolean);
const SUBJECT = { M: 'math', S: 'science', G: 'grammar' } as const;

export const CONCEPT_RE = /G[1-6]-[A-Z]{2,4}-[CA]\d+/g;
export const MISC_RE = /G[1-6]-M-[A-Z]{2,4}\d+/g;
export const TOPIC_RE = /\b(?:MT|ST|GT)\d{4}\b/g;
const chapterOf = (c: Cell | undefined) => /^(MC|SC|GC)\d{2}\b/.exec(s(c) ?? '')?.[0] ?? null;
const topicOf = (c: Cell | undefined) => /^(?:MT|ST|GT)\d{4}\b/.exec(s(c) ?? '')?.[0] ?? null;
/** "Achievers (chapter level)" → that chapter's Achievers row for the class (decision 4). */
const topicOrAchievers = (c: Cell | undefined, chapterId: string | null, cls: number) =>
  topicOf(c) ?? (/^achievers\b/i.test(s(c) ?? '') && chapterId ? `ACH-${chapterId}-${cls}` : null);
const subjectOf = (chapterId: string) => SUBJECT[chapterId[0] as 'M' | 'S' | 'G'];

/** [guess] "Typed" (pre-decision-6) split by the correct answer's form. */
export function typedFormat(correct: string): Format {
  const c = correct.replace(/−/g, '-').trim();
  if (/^-?\d{1,3}(,\d{3})*$|^-?\d+$/.test(c)) return 'Typed-number';
  if (/^-?\d+\.\d+$/.test(c)) return 'Typed-decimal';
  if (/^-?(\d+\s+)?\d+\/\d+$/.test(c)) return 'Typed-fraction';
  return 'Typed-text';
}

export interface Seed {
  strategyTypes: { value: string; example: string | null; hint_1: string | null; sort: number | null; active: boolean }[];
  insights: Record<string, unknown>[];
  concepts: Record<string, unknown>[];
  conceptLinks: { from_concept: string; to_concept: string; kind: 'builds_on' | 'prerequisite'; flagged: boolean }[];
  prereqTopics: { concept_id: string; topic_id: string }[];
  misconceptions: Record<string, unknown>[];
  typicalSets: Record<string, unknown>[];
  setConcepts: { typical_set_id: string; concept_id: string; role: 'main' | 'other' }[];
  attributeDefs: Record<string, unknown>[];
  rubric: Record<string, unknown>[];
  calibration: Record<string, unknown>[];
  gold: { qid: string; class: number; chapter_id: string; subject: 'math' | 'science' | 'grammar'; question: Question;
          meta: { use: 'prompt_example' | 'test_only'; old_qid: string | null; final_reasoning: string | null; review_verdict: string | null; review_notes: string | null } }[];
  problems: SeedProblem[];
}

export function parseSeed(sheets: Map<string, Cell[][]>, ruleVersion: string): Seed {
  const problems: SeedProblem[] = [];
  const err = (where: string, message: string) => problems.push({ level: 'error', where, message });
  const warn = (where: string, message: string) => problems.push({ level: 'warning', where, message });
  const t = (name: string, first: string) => table(sheets.get(name), first, name);

  // ---- Strategy Types
  const strategyTypes = t('Strategy Types', '#').map(({ v }) => ({
    value: s(v['Value'])!, example: s(v['Example (Class 3–6)']), hint_1: s(v['Kid-friendly hint 1']),
    sort: typeof v['#'] === 'number' ? v['#'] : null, active: yes(v['Active']),
  })).filter((x) => x.value);

  // ---- Insight Catalogue
  const insights = t('Insight Catalogue', 'Insight_ID').map(({ row, v }) => {
    const status = (s(v['Status']) ?? 'proposed').toLowerCase();
    if (!['proposed', 'active', 'merged', 'inactive'].includes(status)) err(`Insight Catalogue row ${row}`, `unknown status "${v['Status']}"`);
    return { insight_id: s(v['Insight_ID']), name: s(v['Name']), strategy_type: s(v['Strategy_type']), structure: s(v['Structure']),
      recognition_test: s(v['Recognition test']), includes: s(v['Includes']), excludes: s(v['Excludes']),
      parent_line: s(v['Parent line']), kid_hint: s(v['Kid hint']), status, merged_into: null };
  });

  // ---- Gold Concepts
  const concepts: Record<string, unknown>[] = [];
  const conceptLinks: Seed['conceptLinks'] = [];
  const prereqTopics: Seed['prereqTopics'] = [];
  const conceptMiscs = new Map<string, Set<string>>();
  for (const { row, v } of t('Gold Concepts', 'Concept_ID')) {
    const where = `Gold Concepts row ${row}`;
    const id = s(v['Concept_ID']);
    const chapterId = chapterOf(v['Chapter']);
    if (!id || !new RegExp(`^${CONCEPT_RE.source}$`).test(id)) { err(where, `concept ID "${id}" has the wrong form`); continue; }
    if (!chapterId) { err(where, `${id}: chapter "${v['Chapter']}" has no chapter ID`); continue; }
    const type = (s(v['Type']) ?? '').toLowerCase();
    concepts.push({
      concept_id: id, subject: subjectOf(chapterId), class: Number(v['Grade']), topic_id: topicOf(v['Topic']), name: s(v['Name']),
      type: type === 'core' || type === 'applied' ? type : null, description: s(v['Description']), includes: s(v['Includes']),
      excludes: s(v['Excludes']), example_question: s(v['Example question']), curriculum_tags: list(v['Curriculum tags'], /;/),
      status: 'draft', // v10: concept cards are drafts (yellow)
    });
    // Builds_on: "G5-MEN-C2 (Class 5, flagged)", "G5-DEC-C2, G5-DEC-C3", or a note with no ID.
    const bo = s(v['Builds_on']) ?? '';
    const ids = [...bo.matchAll(CONCEPT_RE)];
    ids.forEach((m, i) => {
      const tail = bo.slice(m.index! + m[0].length, ids[i + 1]?.index ?? bo.length);
      conceptLinks.push({ from_concept: id, to_concept: m[0], kind: 'builds_on', flagged: /flagged/i.test(tail) });
    });
    for (const m of (s(v['Prerequisite concepts (in gold set)']) ?? '').matchAll(CONCEPT_RE)) {
      conceptLinks.push({ from_concept: id, to_concept: m[0], kind: 'prerequisite', flagged: false });
    }
    for (const m of (s(v['Prerequisite topics']) ?? '').matchAll(TOPIC_RE)) prereqTopics.push({ concept_id: id, topic_id: m[0] });
    conceptMiscs.set(id, new Set((s(v['Misconceptions (ID: description)']) ?? '').match(MISC_RE) ?? []));
  }

  // ---- Misconceptions
  const misconceptions = t('Misconceptions', 'Misconception_ID').map(({ row, v }) => {
    const id = s(v['Misconception_ID']);
    const concept = s(v['Concept_ID']);
    if (id && concept && !conceptMiscs.get(concept)?.has(id)) warn(`Misconceptions row ${row}`, `${id} is not listed on concept ${concept} in Gold Concepts`);
    const root = s(v['Root prerequisite']);
    const rootId = root ? (root.match(CONCEPT_RE)?.[0] ?? null) : null;
    if (root && !rootId) warn(`Misconceptions row ${row}`, `${id}: root prerequisite "${root}" has no concept ID; left empty`);
    return { misconception_id: id, concept_id: concept, description: s(v['Description']), parent_description: s(v['Parent description']),
      root_prereq_concept: rootId, alias: null, status: draft(v['Status']) };
  });
  const miscIds = new Set(misconceptions.map((m) => m.misconception_id));
  for (const [c, ids] of conceptMiscs) for (const m of ids) if (!miscIds.has(m)) warn('Gold Concepts', `${c} lists ${m}, which is not on the Misconceptions sheet`);

  // ---- Typical Sets Catalogue
  const typicalSets: Record<string, unknown>[] = [];
  const setConcepts: Seed['setConcepts'] = [];
  for (const { row, v } of t('Typical Sets Catalogue', 'TypicalSetID')) {
    const id = s(v['TypicalSetID']);
    const chapterId = chapterOf(v['Chapter']);
    if (!id || !chapterId) { err(`Typical Sets Catalogue row ${row}`, `needs TypicalSetID and a chapter ID`); continue; }
    typicalSets.push({ typical_set_id: id, subject: subjectOf(chapterId), class: Number(v['Class']), chapter_id: chapterId,
      topic_id: topicOrAchievers(v['Topic'], chapterId, Number(v['Class'])), name: s(v['Name']), instruction_pattern: s(v['Instruction pattern']), variant_note: s(v['Variant note']),
      parent_visible: yes(v['Parent-visible']), status: draft(v['Status']) });
    // [guess] first concept listed is the main one, the rest are "other"
    ((s(v['Concepts']) ?? '').match(CONCEPT_RE) ?? []).forEach((c, i) => setConcepts.push({ typical_set_id: id, concept_id: c, role: i === 0 ? 'main' : 'other' }));
  }

  // ---- Rules: Question Attributes, Tagging Rubric, Calibration Cases
  const attributeDefs = t('Question Attributes', '#').filter(({ v }) => s(v['Attribute'])).map(({ v }) => ({
    rule_version: ruleVersion, attribute: s(v['Attribute']), group: s(v['Group']), meaning: s(v['Meaning']),
    values: s(v['Potential values']), needed_by_engine: yes(v['Needed by gap engine?']), sort: typeof v['#'] === 'number' ? v['#'] : null,
  }));
  const rubric = t('Tagging Rubric', 'Attribute').map(({ v }) => ({
    rule_version: ruleVersion, attribute: s(v['Attribute']), definition: s(v['Definition']), levels_anchors: s(v['Levels and anchors (gold QIDs)']),
    rules: s(v['Rules']), edge_cases: s(v['Edge cases']), calibration_case_ids: (s(v['Calibration cases']) ?? '').match(/CC-\d+/g) ?? [],
  }));
  const calibration = t('Calibration Cases', 'Case').map(({ v }) => ({
    case_id: s(v['Case']), rule_version: ruleVersion, question_id: s(v['QID']), attribute: s(v['Attribute']),
    first_value: s(v['First value']), final_value: s(v['Final value']), why_wrong: s(v['Why the first value was wrong']), rule: s(v['Rule it established']),
  }));

  // ---- Gold Questions + Gold Wrong Answers
  const wrongByQid = new Map<string, WrongAnswer[]>();
  for (const { row, v } of t('Gold Wrong Answers', 'QID')) {
    const qid = s(v['QID'])!;
    const w: WrongAnswer = { value: s(v['Wrong value']) ?? '', tag: s(v['Tag type']) as WrongAnswer['tag'] };
    if (!w.value) { err(`Gold Wrong Answers row ${row}`, `${qid}: wrong value is empty`); continue; }
    const m = s(v['Misconception_Ref']); if (m) w.misconception_id = m;
    const tc = s(v['Target_Concept']); if (tc) w.target_concept_id = tc;
    const why = s(v['Why']); if (why) w.why = why;
    wrongByQid.set(qid, [...(wrongByQid.get(qid) ?? []), w]);
  }

  const gold: Seed['gold'] = [];
  for (const { row, v } of t('Gold Questions', 'QID')) {
    const where = `Gold Questions row ${row}`;
    const qid = s(v['QID']);
    const chapterId = chapterOf(v['Chapter (Class View)']);
    const topicId = topicOrAchievers(v['Topic (Class View)'], chapterId, Number(v['Class']));
    if (!qid || !/^G[1-6]-\d{3}(-[a-z])?$/.test(qid)) { err(where, `QID "${qid}" has the wrong form`); continue; }
    if (!chapterId || !topicId) { err(where, `${qid}: needs a chapter and topic ID`); continue; }
    const rawFormat = s(v['Format']) ?? '';
    const correct = s(v['Correct answer']) ?? '';
    let format: Format;
    if (rawFormat === 'Typed' || rawFormat === 'Multi-part (typed)') {
      format = typedFormat(correct);
      if (rawFormat !== 'Typed') warn(where, `${qid}: "${rawFormat}" row kept as its own gold question with format ${format} [guess]`);
    } else if (['MCQ-4', 'MCQ-3', 'True/False'].includes(rawFormat)) format = rawFormat as Format;
    else { err(where, `${qid}: unknown format "${rawFormat}"`); continue; }

    let options = list(v['Options (separated by |)'], /\|/);
    if (format === 'True/False' && !options.length) options = ['True', 'False'];
    const answer: Answer = { format, correct, accepted: list(v['Accepted equivalents'], /\|/), wrong_answers: wrongByQid.get(qid) ?? [] };
    if (options.length) answer.options = options;

    const concepts: ConceptRef[] = [];
    for (const i of [1, 2, 3]) {
      const c = s(v[`Concept ${i}`]);
      if (c) concepts.push({ concept_id: c, involvement: Number(v[`Inv ${i}`]) as ConceptRef['involvement'] });
    }
    const opt = <T>(x: T | null) => (x === null ? undefined : x);
    const sol2 = s(v['Solution 2']);
    const question: Question = {
      key: qid, topic_id: topicId, typical_set_id: s(v['TypicalSetID'])!, clone_batch_id: s(v['CloneBatchID'])!, locale: 'IN',
      text: s(v['Question text'])!,
      ...(s(v['Figure / table (describe)']) ? { figure: { description: s(v['Figure / table (describe)'])!, image_status: 'needs_image' as const } } : {}),
      answer, concepts,
      signature: {
        math_difficulty: s(v['Math difficulty (bare math)']) as Question['signature']['math_difficulty'],
        is_pure_fact: yes(v['IsPureFact']), reading: Number(v['Reading (1–5)']), has_irrelevant_info: yes(v['Has_Irrelevant_Info']),
        steps: Number(v['Steps (1–20)']), working_memory: Number(v['WorkingMemory (1–5)']), inhibition: Number(v['Inhibition (0–3)']),
        visual: Number(v['Visual (0–3)']), strategy: Number(v['Strategy (0–3)']),
        strategy_type: opt(s(v['Strategy_type'])), strategy_type_2: opt(s(v['Strategy_type_2'])),
        strategy_other_note: opt(s(v['Strategy_other_note'])), insight_id: opt(s(v['Insight_ID'])),
      },
      duration_s: Number(v['Expected duration (s)']) as Question['duration_s'],
      solutions: { school: s(v['Solution 1 (school method)']) ?? '' },
      hints: [v['Hint 1'], v['Hint 2'], v['Hint 3']].map(s).filter((h): h is string => !!h),
      tagging: { tagged_by: 'human' },
    };
    if (sol2) {
      const type = s(v['Solution 2 type']);
      if (type !== 'Smarter way' && type !== 'Another way') err(where, `${qid}: Solution 2 has no valid type ("${type}")`);
      question.solutions.second = { text: sol2, type: type as 'Smarter way', ...(s(v['Solution 2 strategy']) ? { strategy: s(v['Solution 2 strategy'])! } : {}) };
    }
    for (const k of Object.keys(question.signature) as (keyof Question['signature'])[]) if (question.signature[k] === undefined) delete question.signature[k];
    const use = s(v['Use']);
    if (use !== 'Prompt example' && use !== 'Test only') { err(where, `${qid}: Use must be "Prompt example" or "Test only"`); continue; }
    const recheck = s(v['Please re-check']);
    gold.push({
      qid, class: Number(v['Class']), chapter_id: chapterId, subject: subjectOf(chapterId), question,
      meta: { use: use === 'Prompt example' ? 'prompt_example' : 'test_only', old_qid: s(v['Old QID']),
        final_reasoning: s(v['Why (final reasoning)']), review_verdict: s(v['Your verdict']),
        review_notes: [s(v['Your notes']), recheck && `Please re-check: ${recheck}`].filter(Boolean).join('\n') || null },
    });
  }
  for (const qid of wrongByQid.keys()) if (!gold.some((g) => g.qid === qid)) warn('Gold Wrong Answers', `${qid} is not on Gold Questions`);

  return { strategyTypes, insights, concepts, conceptLinks, prereqTopics, misconceptions, typicalSets, setConcepts, attributeDefs, rubric, calibration, gold, problems };
}
