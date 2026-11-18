// Importer checks beyond the JSON schema (design §8), in plain words, per key.
// Pure: the database is passed in as a Catalog snapshot.
import type { Answer, ChapterFile, ConceptRef, PlacementCode, Problem, Question } from './types.ts';
import { typedTimeProblems } from './typed-time.ts';

export interface TopicInfo { chapter_id: string; class: number; topic_kind: 'normal' | 'achievers'; taught_in_school: boolean; status: string }
export interface Catalog {
  ruleVersions: Set<string>;
  chapter: { chapter_id: string; subject: string } | null;
  topics: Map<string, TopicInfo>;
  typicalSets: Map<string, { class: number; status: string }>;
  patterns: Set<string>;                      // in the CMS
  concepts: Map<string, { class: number }>;
  misconceptions: Set<string>;
  insights: Map<string, { status: string }>;
  /** extracted book items (cms_source_items.ref_id); filled from Phase 4 */
  sourceItems: Set<string>;
  /** normalised stem → owner (file key or question ID) of OTHER questions' current versions */
  stems: Map<string, string>;
  /** file key → question ID already in the CMS */
  keyToQuestionId: Map<string, string>;
}

export const normaliseStem = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').replace(/[\s.?!]+$/, '').trim();

/** "ACHIEVERS" in a file means this chapter's Achievers row for the file's class (decision 4). */
export const resolveTopicId = (q: Question, file: ChapterFile) =>
  q.topic_id === 'ACHIEVERS' ? `ACH-${file.chapter_id}-${file.class}` : q.topic_id;

const NO_WRITING = /\b(without writing|no writing|don'?t write|do not write|in your head|mentally)\b/i;
const OPTION_COUNT: Partial<Record<Answer['format'], number>> = { 'MCQ-4': 4, 'MCQ-3': 3, 'True/False': 2 };

/**
 * @param opts.gold the v10 gold set: keys are gold QIDs (G6-001), not chapter keys,
 *                  and they have no file-key / question_id mapping or bank-stem duplicates.
 */
export function checkFile(file: ChapterFile, cat: Catalog, opts: { gold?: boolean } = {}): Problem[] {
  const out: Problem[] = [];
  const err = (key: string, message: string, code?: PlacementCode) => out.push({ level: 'error', key, message, ...(code ? { code } : {}) });
  const warn = (key: string, message: string) => out.push({ level: 'warning', key, message });

  // ---- file level
  if (!cat.ruleVersions.has(file.attribute_version)) err('file', `attribute version ${file.attribute_version} is not loaded in the CMS (loaded: ${[...cat.ruleVersions].join(', ') || 'none'})`);
  if (!cat.chapter) err('file', `chapter ${file.chapter_id} is not in the CMS (import the topic lists first)`);
  else if (cat.chapter.subject !== file.subject) err('file', `chapter ${file.chapter_id} is ${cat.chapter.subject}, but the file says ${file.subject}`);

  const filePatterns = new Map((file.patterns ?? []).map((p) => [p.pattern_id, p]));
  // Q21 decision 8 (17 Nov 2026): a pattern that can't be placed holds only the questions that use it (they go to Held out)
  const unplaceablePatterns = new Map<string, { message: string; code: PlacementCode }>();
  for (const p of file.patterns ?? []) {
    const ptopic = p.topic_id === 'ACHIEVERS' ? `ACH-${file.chapter_id}-${file.class}` : p.topic_id;
    const t = cat.topics.get(ptopic);
    const hold = (message: string, code: PlacementCode) => { err(`pattern ${p.pattern_id}`, message, code); if (!unplaceablePatterns.has(p.pattern_id)) unplaceablePatterns.set(p.pattern_id, { message, code }); };
    if (!t) hold(`topic ${ptopic} does not exist`, p.topic_id === 'ACHIEVERS' ? 'achievers_missing' : 'topic_missing');
    if (!cat.typicalSets.has(p.typical_set_id)) hold(`typical set ${p.typical_set_id} does not exist`, 'typical_set_missing');
    for (const m of p.target_misconceptions ?? []) if (!cat.misconceptions.has(m)) hold(`misconception ${m} does not exist`, 'misconception_missing');
  }

  // ---- per question
  const keys = new Map<string, number>();
  const stemsInFile = new Map<string, string>();
  file.questions.forEach((q, i) => {
    const k = q.key;
    if (keys.has(k)) err(k, `key appears twice in this file (questions ${keys.get(k)! + 1} and ${i + 1})`);
    keys.set(k, i);
    if (!opts.gold && !k.startsWith(`${file.chapter_id}-`)) err(k, `key must start with ${file.chapter_id}-`);

    const known = opts.gold ? undefined : cat.keyToQuestionId.get(k);
    if (q.question_id && !known && !opts.gold) err(k, `question_id ${q.question_id} given, but this key has never been imported; leave question_id out on first import`);
    if (q.question_id && known && q.question_id !== known) err(k, `question_id ${q.question_id} does not match ${known}, the ID this key already has`);

    // topic
    const topicId = resolveTopicId(q, file);
    const topic = cat.topics.get(topicId);
    if (q.topic_id === 'ACHIEVERS' && file.subject !== 'math') {
      err(k, `topic ACHIEVERS is Math only for now; ${file.subject} has no Achiever rule yet`);
    } else if (!topic) {
      if (q.topic_id === 'ACHIEVERS') err(k, `topic ACHIEVERS: there is no Achievers row ${topicId} for ${file.chapter_id} class ${file.class}`, 'achievers_missing');
      else err(k, `topic ${topicId} does not exist`, 'topic_missing');
    } else {
      if (topic.chapter_id !== file.chapter_id) err(k, `topic ${topicId} belongs to chapter ${topic.chapter_id}, not ${file.chapter_id}`, 'topic_chapter');
      if (topic.status !== 'active') err(k, `topic ${topicId} is ${topic.status}`, 'topic_retired');
      if (topic.class !== file.class) err(k, `topic ${topicId} is class ${topic.class}, but the file is class ${file.class}`, 'topic_class');
    }
    const isAchievers = topic?.topic_kind === 'achievers';

    // typical set and pattern
    const set = cat.typicalSets.get(q.typical_set_id);
    if (!set) err(k, `typical set ${q.typical_set_id} does not exist`, 'typical_set_missing');
    else if (topic && set.class !== topic.class) err(k, `typical set ${q.typical_set_id} is class ${set.class}, but topic ${topicId} is class ${topic.class}`, 'typical_set_class');
    if (q.pattern_id && !cat.patterns.has(q.pattern_id) && !filePatterns.has(q.pattern_id)) err(k, `pattern ${q.pattern_id} does not exist (not in the CMS or in this file's patterns)`, 'pattern_missing');
    const badPattern = q.pattern_id ? unplaceablePatterns.get(q.pattern_id) : undefined;
    if (badPattern) err(k, `pattern ${q.pattern_id} can't be placed: ${badPattern.message}`, badPattern.code);

    // concepts and wrong answers, question and parts
    const conceptCheck = (where: string, concepts: ConceptRef[]) => {
      for (const c of concepts) if (!cat.concepts.has(c.concept_id)) err(k, `${where}concept ${c.concept_id} does not exist`, 'concept_missing');
      if (!concepts.some((c) => c.involvement === 1)) err(k, `${where}needs at least one concept at involvement 1.0`);
    };
    const answerCheck = (where: string, a: Answer) => {
      for (const w of a.wrong_answers ?? []) {
        if (w.misconception_id && !cat.misconceptions.has(w.misconception_id)) err(k, `${where}misconception ${w.misconception_id} does not exist`, 'misconception_missing');
        if (w.target_concept_id && !cat.concepts.has(w.target_concept_id)) err(k, `${where}target concept ${w.target_concept_id} does not exist`, 'concept_missing');
      }
      const need = OPTION_COUNT[a.format];
      if (need !== undefined) {
        const opts = a.options ?? [];
        if (opts.length !== need) err(k, `${where}${a.format} needs ${need} options, found ${opts.length}`);
        if (new Set(opts).size !== opts.length) err(k, `${where}options repeat a value`);
        if (!opts.includes(a.correct)) err(k, `${where}correct answer "${a.correct}" is not one of the options`);
        // Q33 (rules v11 → v12, Sambit 17 Nov 2026): wrong options are tagged "where confident". An untagged wrong option is
        // valid and never blocks an import or approval (it was an error under v11).
        for (const w of a.wrong_answers ?? []) if (!opts.includes(w.value)) warn(k, `${where}wrong answer "${w.value}" is not one of the options`);
        if ((a.wrong_answers ?? []).some((w) => w.value === a.correct)) err(k, `${where}the correct answer is also tagged as wrong`);
      } else if (a.format === 'Typed-time') {
        // Q36: answer h:mm; the child types two boxes hh : mm, checked numerically per box
        const t = typedTimeProblems(a);
        for (const m of t.errors) err(k, `${where}${m}`);
        for (const m of t.warnings) warn(k, `${where}${m}`);
      } else if (a.options?.length) {
        warn(k, `${where}${a.format} has options; they are ignored for typed answers`);
      }
    };
    conceptCheck('', q.concepts);
    answerCheck('', q.answer);
    const isMulti = q.answer.format === 'Multi-part';
    if (isMulti && !(q.parts && q.parts.length >= 2)) err(k, 'Multi-part needs at least two parts');
    if (!isMulti && q.parts?.length) err(k, `parts are only allowed when the format is Multi-part (format is ${q.answer.format})`);
    const labels = new Set<string>();
    for (const p of q.parts ?? []) {
      if (labels.has(p.part_label)) err(k, `part ${p.part_label} appears twice`);
      labels.add(p.part_label);
      if (p.answer.format === 'Multi-part') err(k, `part ${p.part_label}: a part cannot itself be Multi-part`);
      conceptCheck(`part ${p.part_label}: `, p.concepts);
      answerCheck(`part ${p.part_label}: `, p.answer);
    }

    // signature
    const s = q.signature;
    if (s.insight_id) {
      const ins = cat.insights.get(s.insight_id);
      if (!ins) err(k, `insight ${s.insight_id} does not exist`);
      else if (ins.status === 'merged' || ins.status === 'inactive') warn(k, `insight ${s.insight_id} is ${ins.status}`);
    }
    if (s.strategy >= 2 && !s.strategy_type) warn(k, `strategy ${s.strategy} needs a strategy_type`);
    if ((s.strategy_type === 'Other' || s.strategy_type_2 === 'Other') && !s.strategy_other_note) warn(k, 'strategy type "Other" needs strategy_other_note');
    if ((s.strategy === 2 || s.strategy === 3) && topic?.taught_in_school && !isAchievers) warn(k, `strategy ${s.strategy} on a topic taught in school (NCERT/DAV); check it isn't a School question`);
    const second = q.solutions.second;
    if (second?.strategy === 'Smart calculation' && second.type === 'Another way') warn(k, 'solution 2 uses Smart calculation, so its type should be "Smarter way", not "Another way" (v10 rule)');
    if (s.visual >= 2 && !q.figure) warn(k, `visual ${s.visual} but the question has no figure`);
    if (s.working_memory >= 4 && !NO_WRITING.test(q.text)) warn(k, `working memory ${s.working_memory} but the text doesn't say to work without writing`);

    // source refs: internal links to extracted book items. Until Phase 4 (sources) a
    // missing item is a warning, not an error (Sambit, 9 Nov 2026).
    for (const r of q.source_refs ?? []) {
      if (!cat.sourceItems.has(r.ref_id)) warn(k, `source ref ${r.ref_id} is not in the CMS yet (sources arrive in Phase 4)`);
    }

    // duplicate stems
    const stem = normaliseStem(q.text);
    const inFile = stemsInFile.get(stem);
    if (inFile) warn(k, `same question text as ${inFile} in this file`);
    else stemsInFile.set(stem, k);
    const owner = cat.stems.get(stem);
    if (!opts.gold && owner && owner !== k && owner !== known) warn(k, `same question text as ${owner} already in the bank`);
  });
  return out;
}
