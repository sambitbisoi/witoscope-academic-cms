// cms-book-chapter/0.1 files (e.g. QuestionBank/NCERT-C6-01/NCERT-C6-01.book.json):
// one book chapter's source, sections and extracted items. Pure parsing.
// D3 (Sambit, 9 Nov 2026): import the source and item rows now, WITHOUT the v11
// fields (each item's `tags`: format, signature, wrong answers, pattern, why).
import { pdfStem } from './sources.ts';

export interface BookFile {
  file_schema: string; attribute_version?: string; subject: string; internal_only?: boolean;
  source: { publisher: string; book_title: string; book_class: number; kind: string; file_path: string; page_offset?: number };
  chapter: { chapter_no: number; chapter_name: string; page_from: number; page_to: number; answer_key_pdf_pages?: string;
    sections?: { section_no: string; title: string; page: number }[] };
  items: { ref_id: string; page: number; section_no?: string; item_label?: string; kind?: string; text: string; numbers?: string[];
    assessable?: boolean; placement?: { chapter_id?: string; topic_id?: string }; snapshot_image?: string }[];
}
export const SUPPORTED = ['cms-book-chapter/0.1', 'cms-book-chapter/0.2'];
export interface BookProblem { level: 'error' | 'warning'; where: string; message: string }

export function parseBook(data: unknown, topics: Map<string, string /* chapter */>) {
  const problems: BookProblem[] = [];
  const err = (where: string, message: string) => problems.push({ level: 'error', where, message });
  const warn = (where: string, message: string) => problems.push({ level: 'warning', where, message });
  const b = data as BookFile;
  // 0.2 (9 Nov) only adds items[].snapshot_image; both are accepted.
  if (!SUPPORTED.includes(b?.file_schema)) { err('file', `file_schema must be ${SUPPORTED.join(' or ')}, got "${b?.file_schema}"`); return { problems }; }
  if (b.internal_only !== true) err('file', 'internal_only must be true: book text never leaves the CMS');
  if (!b.source?.file_path || !b.chapter || !Array.isArray(b.items)) { err('file', 'needs source.file_path, chapter and items'); return { problems }; }
  const stem = pdfStem(b.source.file_path);
  if (!stem) { err('file', `source.file_path "${b.source.file_path}" is not a .pdf`); return { problems }; }
  const publisher = b.source.publisher === 'NCERT' ? 'NCERT' : b.source.publisher;
  const source_id = `${publisher}-${stem}`;
  const offset = Number(b.source.page_offset ?? 0);
  if (!Number.isInteger(offset)) err('file', 'source.page_offset must be a whole number');
  const pdf = (printed: number) => printed + offset; // printed page = pdf page − offset
  if (b.attribute_version) warn('file', `attribute_version ${b.attribute_version}: item tags are not imported (D3); only source and item rows`);

  const items: { ref_id: string; source_id: string; page: number; item_text: string; topic_id: string | null; pattern_id: null; numbers: string[] }[] = [];
  const chapters = new Set<string>();
  const seen = new Set<string>();
  for (const it of b.items) {
    const where = `item ${it.ref_id ?? '?'}`;
    if (!it.ref_id || !it.text) { err(where, 'needs ref_id and text'); continue; }
    if (seen.has(it.ref_id)) { err(where, 'ref_id appears twice'); continue; }
    seen.add(it.ref_id);
    let topic = it.placement?.topic_id ?? null;
    if (topic && !topics.has(topic)) { warn(where, `topic ${topic} is not in the CMS; item kept without a topic`); topic = null; }
    const ch = topic ? topics.get(topic)! : it.placement?.chapter_id;
    if (ch) chapters.add(ch);
    items.push({ ref_id: it.ref_id, source_id, page: it.page, item_text: it.text, topic_id: topic, pattern_id: null, numbers: it.numbers ?? [] });
  }
  const snaps = b.items.filter((i) => i.snapshot_image).length;
  if (snaps) warn('file', `${snaps} item snapshot image${snaps === 1 ? '' : 's'} not imported yet (they need the admin's Storage upload; follow-up)`);
  if (!chapters.size) warn('file', 'no item is placed in a CMS chapter; the source is not linked to any chapter');

  const pageFrom = pdf(b.chapter.page_from), pageTo = pdf(b.chapter.page_to);
  const links = [...chapters].sort().map((chapter_id) => ({ source_id, chapter_id, page_from: pageFrom, page_to: pageTo }));
  const jumpLabels = (b.chapter.sections ?? []).map((sec) => ({ label: `${sec.section_no} ${sec.title}`, pdf_page: pdf(sec.page) }));
  const ans = /^(\d+)/.exec(b.chapter.answer_key_pdf_pages ?? '');
  if (ans) jumpLabels.push({ label: 'Answers', pdf_page: Number(ans[1]) }); // already PDF pages
  const jumps = links.flatMap((l) => jumpLabels.map((j) => ({ source_id, chapter_id: l.chapter_id, ...j })));

  return {
    problems,
    source: { source_id, publisher, class: b.source.book_class, kind: b.source.kind === 'scanned_pdf' ? 'scanned_pdf' : 'pdf',
      title: `${publisher} ${b.source.book_title}, Class ${b.source.book_class} · Ch ${b.chapter.chapter_no} ${b.chapter.chapter_name}`,
      page_offset: offset, localFile: b.source.file_path },
    links, jumps, items,
    counts: { items: items.length, sections: (b.chapter.sections ?? []).length, chapters: chapters.size },
  };
}
