// Types for a chapter file (schema/chapter.schema.json, cms-chapter/1.0).
export type Format = 'MCQ-4' | 'MCQ-3' | 'True/False' | 'Typed-number' | 'Typed-decimal' | 'Typed-fraction' | 'Typed-text' | 'Multi-part';
export type WrongTag = 'misconception' | 'concept_error' | 'shortcut' | 'partial' | 'lost_step' | 'used_irrelevant' | 'misread' | 'unit_slip' | 'implausible';

export interface WrongAnswer { value: string; tag: WrongTag; misconception_id?: string; target_concept_id?: string; why?: string }
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
}
export interface Pattern {
  pattern_id: string; topic_id: string; typical_set_id: string; name: string; template?: string;
  variables?: Record<string, unknown>; target_misconceptions?: string[]; source_refs?: string[]; notes?: string;
}
export interface ChapterFile {
  file_schema: 'cms-chapter/1.0'; attribute_version: string; subject: 'math' | 'science' | 'grammar'; class: number;
  chapter_id: string; chapter_name?: string; generated: { by: string; thread?: string; model?: string; date: string; notes?: string };
  patterns?: Pattern[]; questions: Question[];
}

export interface Problem { level: 'error' | 'warning'; key: string; message: string }
