// Shared types (scripts, web app, tests).
// Types for a chapter file (schema/chapter.schema.json, cms-chapter/1.0).
export type Format = 'MCQ-4' | 'MCQ-3' | 'True/False' | 'Typed-number' | 'Typed-decimal' | 'Typed-fraction' | 'Typed-text' | 'Multi-part';
export type WrongTag = 'misconception' | 'concept_error' | 'shortcut' | 'partial' | 'lost_step' | 'used_irrelevant' | 'misread' | 'unit_slip' | 'implausible';

export interface WrongAnswer { value: string; tag: WrongTag; misconception_id?: string; target_concept_id?: string; why?: string;
  /** Science (0035): the content-row misconception item this wrong option shows, e.g. C6-04-014 #2 */ mc?: { row_id: string; item_no: number };
  /** Science (Q32, 0041): a concept error's target, one of the question's linked content rows */ target_row_id?: string }
export interface Answer { format: Format; options?: string[]; correct: string; accepted?: string[]; wrong_answers?: WrongAnswer[] }
export interface ConceptRef { concept_id: string; involvement: 1 | 0.5 | 0.2 }
export interface Part { part_label: string; text: string; answer: Answer; concepts: ConceptRef[] }
export interface Signature {
  math_difficulty: 'Simple' | 'Medium' | 'Complex'; is_pure_fact: boolean; reading: number; has_irrelevant_info: boolean;
  steps: number; working_memory: number; inhibition: number; visual: number; strategy: number;
  strategy_type?: string; strategy_type_2?: string; strategy_other_note?: string; insight_id?: string;
  proposed_insight?: { name?: string; structure?: string; recognition_test?: string }; trick_ref?: string;
}
export interface Question {
  key: string; question_id?: string; topic_id: string; class_override?: number; placement_note?: string;
  typical_set_id: string; pattern_id?: string; clone_batch_id: string; locale: 'IN'; text: string;
  figure?: { description: string; image_status: 'needs_image' | 'has_image'; image_file?: string };
  answer: Answer; parts?: Part[]; concepts: ConceptRef[]; signature: Signature; duration_s: 30 | 60 | 90 | 120;
  solutions: { school: string; second?: { text: string; type: 'Smarter way' | 'Another way'; strategy?: string } };
  hints: string[]; source_refs?: { ref_id: string; relation: 'modelled_on' | 'same_idea' | 'checked_against' }[];
  tagging?: { tagged_by?: 'human' | 'ai'; why?: Record<string, { why: string; confidence: 'high' | 'medium' | 'low' }>; summary?: string };
  author_notes?: string;
  /** Science only (T1, 17 Nov 2026): the Science signature, each field may be unset (null). When present, the Math
   *  signature above is a placeholder and is never saved; Math signature and derived columns are saved as null. */
  science?: ScienceSignature;
}
export interface ScienceSignature {
  reading: number | null; steps: number | null; inhibition: number | null; visual: number | null;
  has_irrelevant_info: boolean | null; is_pure_fact: boolean | null;
  /** Q26 (S1, 0041). Each may be unset; the type is required to approve a Science production question. */
  science_question_type?: ScienceQuestionType | null; setting_familiarity?: SettingFamiliarity | null;
  has_hidden_idea?: boolean | null; has_experiment?: boolean | null;
  /** the question's setting (cms_questions.setting_id, SET catalogue, Science settings only); blank = bare */
  setting_id?: string | null;
}
export type ScienceQuestionType = 1 | 2 | 3 | 4 | 5;
export type SettingFamiliarity = 'Bare' | 'Everyday' | 'Less familiar' | 'Rare';
export const SCIENCE_QUESTION_TYPES: Record<ScienceQuestionType, string> = { 1: 'Fact', 2: 'Basic understanding', 3: 'Curiosity/application', 4: 'Achiever', 5: 'Super Achiever' };
export const SETTING_FAMILIARITY: SettingFamiliarity[] = ['Bare', 'Everyday', 'Less familiar', 'Rare'];
export interface Pattern {
  pattern_id: string; topic_id: string; typical_set_id: string; name: string; template?: string;
  variables?: Record<string, unknown>; target_misconceptions?: string[]; source_refs?: string[]; notes?: string;
}
export interface ChapterFile {
  file_schema: 'cms-chapter/1.0'; attribute_version: string; subject: 'math' | 'science' | 'grammar'; class: number;
  chapter_id: string; chapter_name?: string; generated: { by: string; thread?: string; model?: string; date: string; notes?: string };
  patterns?: Pattern[]; questions: Question[];
}

export interface Problem { level: 'error' | 'warning'; key: string; message: string;
  /** Q21 (17 Nov 2026): 'placement' = the question can't be placed (topic / Achievers row / catalogue item missing or in another
   *  class or chapter); such a question goes to the Held-out area instead of being skipped. */
  code?: PlacementCode }
export type PlacementCode = 'topic_missing' | 'achievers_missing' | 'topic_retired' | 'topic_class' | 'topic_chapter' | 'typical_set_missing'
  | 'typical_set_class' | 'pattern_missing' | 'concept_missing' | 'misconception_missing' | 'row_missing' | 'other_placement';

// Derived-field config (cms_config, from the v10 workbook)
export interface Band { min: number; max: number | null; band: number }
export interface DerivedConfig {
  multistep_bands: Band[];
  difficulty_points: { Simple: number; Medium: number; Complex: number };
  load_thresholds: { high: number; very_high: number };
}
