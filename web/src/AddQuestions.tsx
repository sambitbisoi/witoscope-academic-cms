// Add and bulk-upload questions inside a topic (Sambit, 13 Nov 2026). No AI anywhere here.
// The topic is fixed by where you are. Mandatory: text, format, correct answer, options for MCQ
// (True/False automatic), Level (pre-filled with the topic's home class; must be confirmed) and
// "Picture needed" (Y needs a figure description). Everything else is optional. Each question is
// saved as Needs review with "Attributes pending" and "Originality pending" (and "Image pending"
// when a picture is needed); see migration 0029. The upload checks mandatory fields only.
import { useEffect, useMemo, useState } from 'react';
import { addContext, knownSourceItems, type AddContext } from './api';
import { addQuestions } from './editApi';
import { knownContentRows } from './scienceApi';
import {
  ADD_FORMATS, contentRowLinks, DIFFICULTIES, EXAMPLE_MARK, mandatoryErrors, parseUploadRow, UPLOAD_COLUMNS, uploadColumns, type NewQuestion, type ParsedRow, type UploadLookups,
} from './logic';

interface TopicInfo { topic_id: string; name: string; class: number; chapter_id: string }

function useAddContext(topicId: string) {
  const [ctx, setCtx] = useState<AddContext | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { addContext(topicId).then(setCtx).catch((e) => setErr(e.message)); }, [topicId]);
  return { ctx, err };
}

// ---------------------------------------------------------------- the form
export function AddQuestionForm({ topic, onDone }: { topic: TopicInfo; onDone: (questionId: string | null) => void }) {
  const { ctx, err: ctxErr } = useAddContext(topic.topic_id);
  const [text, setText] = useState('');
  const [format, setFormat] = useState('');
  const [options, setOptions] = useState(['', '', '', '']);
  const [correct, setCorrect] = useState('');
  const [level, setLevel] = useState(topic.class);
  const [levelOk, setLevelOk] = useState(false);
  const [picture, setPicture] = useState<boolean | null>(null);
  const [figure, setFigure] = useState('');
  const [more, setMore] = useState(false);
  const [solution, setSolution] = useState('');
  const [hints, setHints] = useState(['', '', '']);
  const [wrong, setWrong] = useState('');
  const [concepts, setConcepts] = useState<string[]>([]);
  const [setId, setSetId] = useState('');
  const [patternId, setPatternId] = useState('');
  const [settingId, setSettingId] = useState('');
  const [difficulty, setDifficulty] = useState('');
  const [source, setSource] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const science = topic.chapter_id.startsWith('SC');
  const [rowsDirect, setRowsDirect] = useState('');
  const [rowsSupporting, setRowsSupporting] = useState('');

  const nOpts = format === 'MCQ-4' ? 4 : format === 'MCQ-3' ? 3 : 0;
  const opts = nOpts ? options.slice(0, nOpts) : format === 'True/False' ? ['True', 'False'] : [];
  const build = async (): Promise<NewQuestion> => {
    const items = await knownSourceItems(source.trim() ? [source.trim()] : []).catch(() => new Set<string>());
    const isItem = !!source.trim() && items.has(source.trim());
    return {
      text: text.trim(), format, options: opts.map((o) => o.trim()), correct: correct.trim(), level, picture_needed: picture,
      figure_description: figure.trim() || undefined, solution: solution.trim() || undefined, hints: hints.map((h) => h.trim()).filter(Boolean),
      wrong_answers: wrong.split(/\n|;/).map((w) => w.trim()).filter(Boolean).map((w) => { const i = w.indexOf(':'); return i > 0 ? { value: w.slice(0, i).trim(), why: w.slice(i + 1).trim() } : { value: w, why: '' }; }),
      concepts, typical_set_id: setId || undefined, pattern_id: patternId || undefined, setting_id: settingId || undefined, math_difficulty: difficulty || undefined,
      source_refs: isItem ? [source.trim()] : [], author_notes: [notes.trim(), source.trim() && !isItem ? `Source: ${source.trim()}` : ''].filter(Boolean).join('\n') || undefined,
    };
  };
  const save = async () => {
    setBusy(true); setErrors([]);
    try {
      const q = await build();
      const e = mandatoryErrors(q);
      if (!levelOk) e.push(`confirm the level (Level ${level})`);
      if (science) {
        const links = contentRowLinks(rowsDirect, rowsSupporting);
        const known = await knownContentRows(links.map((l) => l.row_id));
        for (const l of links) if (!known.has(l.row_id)) e.push(`content row ${l.row_id} does not exist`);
        q.content_rows = links;
      }
      if (e.length) { setErrors(e); return; }
      const r = await addQuestions({ topic_id: topic.topic_id, origin: 'manual', questions: [{ ...q, row: null }] });
      onDone(r.added[0]?.question_id ?? null);
    } catch (x) { setErrors([(x as Error).message]); } finally { setBusy(false); }
  };

  return (
    <div className="add-form card">
      <div className="add-head"><h3>Add a question to {topic.topic_id} · {topic.name}</h3><span className="muted small">Saved as Needs review · Manual · attributes and originality pending</span></div>
      {ctxErr && <p className="error small">Couldn't load this topic's typical sets and concepts: {ctxErr}</p>}
      <label className="field"><span>Question text <b>*</b></span><textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} /></label>
      <div className="row-fields">
        <label className="field"><span>Format <b>*</b></span>
          <select value={format} onChange={(e) => { setFormat(e.target.value); setCorrect(''); }}>
            <option value="">Choose…</option>{ADD_FORMATS.map((f) => <option key={f} value={f}>{f}</option>)}
          </select></label>
        <label className="field"><span>Level <b>*</b></span>
          <select value={level} onChange={(e) => { setLevel(Number(e.target.value)); setLevelOk(true); }}>
            {[1, 2, 3, 4, 5, 6].map((l) => <option key={l} value={l}>Level {l}{l === topic.class ? ' (topic’s home class)' : ''}</option>)}
          </select></label>
        <label className="check small confirm"><input type="checkbox" checked={levelOk} onChange={(e) => setLevelOk(e.target.checked)} /> Level {level} is right</label>
        <fieldset className="field yn"><span>Picture needed <b>*</b></span>
          <label><input type="radio" name="pic" checked={picture === true} onChange={() => setPicture(true)} /> Yes</label>
          <label><input type="radio" name="pic" checked={picture === false} onChange={() => setPicture(false)} /> No</label>
        </fieldset>
      </div>
      {picture && <label className="field"><span>Figure description <b>*</b></span><textarea rows={2} value={figure} onChange={(e) => setFigure(e.target.value)} placeholder="What the picture shows, in our own words" /></label>}
      {nOpts > 0 && (
        <div className="field"><span>Options <b>*</b> <span className="muted">(tick the correct one)</span></span>
          {options.slice(0, nOpts).map((o, i) => (
            <div key={i} className="opt-row">
              <input type="radio" name="correct" aria-label={`Option ${'ABCD'[i]} is correct`} checked={!!o.trim() && correct === o.trim()} onChange={() => setCorrect(o.trim())} />
              <span className="mono">{'ABCD'[i]}</span>
              <input value={o} onChange={(e) => { const n = [...options]; n[i] = e.target.value; setOptions(n); if (correct === o.trim()) setCorrect(e.target.value.trim()); }} />
            </div>
          ))}
        </div>
      )}
      {format === 'True/False' && <label className="field"><span>Correct answer <b>*</b></span>
        <select value={correct} onChange={(e) => setCorrect(e.target.value)}><option value="">Choose…</option><option>True</option><option>False</option></select></label>}
      {format && !nOpts && format !== 'True/False' && <label className="field"><span>Correct answer <b>*</b></span><input value={correct} onChange={(e) => setCorrect(e.target.value)} /></label>}
      {science && <div className="row-fields">
        <label className="field"><span>Content row IDs · direct <span className="muted">(optional; e.g. C6-04-001, C6-04-014)</span></span><input value={rowsDirect} onChange={(e) => setRowsDirect(e.target.value)} /></label>
        <label className="field"><span>Content row IDs · supporting <span className="muted">(optional)</span></span><input value={rowsSupporting} onChange={(e) => setRowsSupporting(e.target.value)} /></label>
      </div>}

      <button className="link small" onClick={() => setMore(!more)} aria-expanded={more}>{more ? '▾' : '▸'} More (optional): solution, hints, wrong-answer notes, concepts, typical set, setting, difficulty, source, notes</button>
      {more && (
        <div className="more-fields">
          <label className="field"><span>Solution</span><textarea rows={2} value={solution} onChange={(e) => setSolution(e.target.value)} /></label>
          <div className="row-fields">{hints.map((h, i) => <label key={i} className="field"><span>Hint {i + 1}</span><input value={h} onChange={(e) => { const n = [...hints]; n[i] = e.target.value; setHints(n); }} /></label>)}</div>
          <label className="field"><span>Wrong-answer notes <span className="muted">(one per line, as  wrong answer: why)</span></span><textarea rows={2} value={wrong} onChange={(e) => setWrong(e.target.value)} placeholder="102: compared the last digit only" /></label>
          {ctx && ctx.concepts.length > 0 && <fieldset className="field"><span>Concepts</span><div className="concept-picks">
            {ctx.concepts.map((c) => <label key={c.concept_id} className="check small"><input type="checkbox" checked={concepts.includes(c.concept_id)}
              onChange={(e) => setConcepts(e.target.checked ? [...concepts, c.concept_id] : concepts.filter((x) => x !== c.concept_id))} /> <span className="mono">{c.concept_id}</span> {c.name}</label>)}
          </div></fieldset>}
          <div className="row-fields">
            <label className="field"><span>Typical set</span><select value={setId} onChange={(e) => { setSetId(e.target.value); setPatternId(''); }}>
              <option value="">—</option>{ctx?.sets.map((x) => <option key={x.typical_set_id} value={x.typical_set_id}>{x.typical_set_id} · {x.name}</option>)}</select></label>
            <label className="field"><span>Pattern</span><select value={patternId} disabled={!setId} onChange={(e) => setPatternId(e.target.value)}>
              <option value="">—</option>{ctx?.patterns.filter((x) => x.typical_set_id === setId).map((x) => <option key={x.pattern_id} value={x.pattern_id}>{x.pattern_id} · {x.name}</option>)}</select></label>
            <label className="field"><span>Setting</span><select value={settingId} onChange={(e) => setSettingId(e.target.value)}>
              <option value="">—</option>{ctx?.settings.map((x) => <option key={x.setting_id} value={x.setting_id}>{x.name}</option>)}</select></label>
            <label className="field"><span>Difficulty guess</span><select value={difficulty} onChange={(e) => setDifficulty(e.target.value)}>
              <option value="">—</option>{DIFFICULTIES.map((d) => <option key={d}>{d}</option>)}</select></label>
          </div>
          <label className="field"><span>Source citation <span className="muted">(citation only, e.g. N6-01-004; never book text)</span></span><input value={source} onChange={(e) => setSource(e.target.value)} /></label>
          <label className="field"><span>Notes</span><textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
        </div>
      )}
      {errors.length > 0 && <ul className="error small add-errors">{errors.map((e) => <li key={e}>{e}</li>)}</ul>}
      <div className="form-actions"><button disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save question'}</button> <button className="link" disabled={busy} onClick={() => onDone(null)}>Cancel</button></div>
    </div>
  );
}

// ---------------------------------------------------------------- Excel
type ExcelMod = typeof import('exceljs');
async function excel(): Promise<ExcelMod> {
  const m = (await import('exceljs')) as unknown as { default?: ExcelMod } & ExcelMod;
  return (m.default ?? m) as ExcelMod;
}
function cellValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v).trim();
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.richText)) return (o.richText as { text: string }[]).map((t) => t.text).join('').trim();
    if ('result' in o) return cellValue(o.result);
    if ('text' in o) return cellValue(o.text);
  }
  return '';
}
const download = (buf: ArrayBuffer, name: string) => {
  const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
};

/** "Download template": the Questions sheet (headers, an example row, drop-downs) and a Help sheet. */
async function downloadTemplate(topic: TopicInfo, ctx: AddContext | null) {
  const ExcelJS = await excel();
  const wb = new ExcelJS.Workbook();
  wb.creator = 'WitoScope CMS';
  const ws = wb.addWorksheet('Questions', { views: [{ state: 'frozen', ySplit: 1 }] });
  const cols = uploadColumns(topic.chapter_id.startsWith('SC'));
  ws.columns = cols.map((c) => ({ header: c.required ? `${c.header} *` : c.header, key: c.key, width: c.key === 'text' || c.key === 'solution' || c.key === 'figure' ? 40 : c.key.length <= 2 ? 12 : 20 }));
  const head = ws.getRow(1);
  head.font = { bold: true }; head.alignment = { wrapText: true, vertical: 'top' };
  cols.forEach((c, i) => {
    const cell = head.getCell(i + 1);
    cell.note = `${c.required ? 'Required. ' : 'Optional. '}${c.help}`;
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: c.required ? 'FFFFF3D6' : 'FFEEF0F4' } };
  });
  ws.addRow({ text: 'Which number is the largest?', format: 'MCQ-4', a: '12', b: '21', c: '102', d: '120', correct: '120', level: topic.class, picture: 'N',
    solution: 'Compare the hundreds first: 120 has 1 hundred and 2 tens.', hint1: 'Look at the hundreds digit first.', wrong: '102: looked at the last digit only',
    difficulty: 'Simple', notes: `${EXAMPLE_MARK} — delete this row (it is never imported)` }).font = { italic: true, color: { argb: 'FF667085' } };
  const col = (k: string) => cols.findIndex((c) => c.key === k) + 1;
  const letter = (k: string) => ws.getColumn(col(k)).letter;
  const lists: [string, string[]][] = [['format', [...ADD_FORMATS]], ['picture', ['Y', 'N']], ['difficulty', [...DIFFICULTIES]], ['level', ['1', '2', '3', '4', '5', '6']]];
  for (const [k, vals] of lists) {
    for (let r = 2; r <= 501; r++) ws.getCell(`${letter(k)}${r}`).dataValidation = { type: 'list', allowBlank: true, formulae: [`"${vals.join(',')}"`], showErrorMessage: true, errorTitle: 'Not allowed', error: `Pick one of: ${vals.join(', ')}` };
  }
  const help = wb.addWorksheet('Help');
  help.columns = [{ header: 'Column', key: 'h', width: 26 }, { header: 'Required?', key: 'r', width: 11 }, { header: 'What to put in it', key: 'w', width: 100 }];
  help.getRow(1).font = { bold: true };
  help.addRow({ h: 'Topic', r: '', w: `${topic.topic_id} · ${topic.name} (home class ${topic.class}). Upload this file inside that topic in Browse; there is no topic column.` });
  help.addRow({ h: 'Checks on upload', r: '', w: 'Only the required columns are checked. Rows with a missing required field are skipped, with the reason; the rest are imported as Needs review.' });
  help.addRow({});
  for (const c of cols) help.addRow({ h: c.header, r: c.required ? 'Required' : 'Optional', w: c.help });
  if (ctx) {
    help.addRow({});
    help.addRow({ h: 'IDs you can use here', r: '', w: '' }).font = { bold: true };
    for (const x of ctx.concepts) help.addRow({ h: 'Concept', r: x.concept_id, w: x.name });
    for (const x of ctx.sets) help.addRow({ h: 'Typical set', r: x.typical_set_id, w: x.name });
    for (const x of ctx.patterns) help.addRow({ h: 'Pattern', r: x.pattern_id, w: `${x.name} (typical set ${x.typical_set_id})` });
    for (const x of ctx.settings) help.addRow({ h: 'Setting', r: x.setting_id, w: x.name });
  }
  help.getColumn(3).alignment = { wrapText: true };
  download(await wb.xlsx.writeBuffer() as ArrayBuffer, `WitoScope_questions_${topic.topic_id}.xlsx`);
}

/** Read the Questions sheet: header row 1 (matched by header text), one row per question. */
async function readUpload(file: File): Promise<{ rows: { row: number; cells: Record<string, string> }[]; unknownHeaders: string[] }> {
  const ExcelJS = await excel();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await file.arrayBuffer());
  const ws = wb.getWorksheet('Questions') ?? wb.worksheets[0];
  if (!ws) throw new Error('The file has no sheets.');
  const norm = (s: string) => s.replace(/\*/g, '').trim().toLowerCase();
  const byHeader = new Map(UPLOAD_COLUMNS.map((c) => [norm(c.header), c.key]));
  const keys: (string | null)[] = []; const unknownHeaders: string[] = [];
  ws.getRow(1).eachCell({ includeEmpty: true }, (cell, i) => { const h = norm(cellValue(cell.value)); const k = byHeader.get(h) ?? null; keys[i] = k; if (h && !k) unknownHeaders.push(cellValue(cell.value)); });
  if (!keys.includes('text')) throw new Error('No "Question text" column in row 1. Start from the template (Download template).');
  const rows: { row: number; cells: Record<string, string> }[] = [];
  ws.eachRow({ includeEmpty: false }, (r, n) => {
    if (n === 1) return;
    const cells: Record<string, string> = {};
    r.eachCell({ includeEmpty: false }, (cell, i) => { const k = keys[i]; if (k) cells[k] = cellValue(cell.value); });
    if (Object.values(cells).some((v) => v !== '')) rows.push({ row: n, cells });
  });
  return { rows, unknownHeaders };
}

async function sha256(file: File) {
  const d = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------- bulk upload
export function BulkUpload({ topic, onDone }: { topic: TopicInfo; onDone: (changed: boolean) => void }) {
  const { ctx } = useAddContext(topic.topic_id);
  const [file, setFile] = useState<File | null>(null);
  const [parsed, setParsed] = useState<ParsedRow[] | null>(null);
  const [extra, setExtra] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<{ import_id: number | null; added: { row: number | null; question_id: string; file_key: string }[] } | null>(null);
  const valid = useMemo(() => (parsed ?? []).filter((p) => p.q && !p.errors.length), [parsed]);
  const skipped = useMemo(() => (parsed ?? []).filter((p) => p.q && p.errors.length), [parsed]);

  const pick = async (f: File | null) => {
    setFile(f); setParsed(null); setResult(null); setErr(null); setExtra([]);
    if (!f || !ctx) return;
    setBusy(true);
    try {
      const { rows, unknownHeaders } = await readUpload(f);
      const items = await knownSourceItems(rows.map((r) => r.cells.source ?? ''));
      const rowIds = rows.flatMap((r) => contentRowLinks(r.cells.rows_direct ?? '', r.cells.rows_supporting ?? '').map((l) => l.row_id));
      const contentRows = topic.chapter_id.startsWith('SC') ? await knownContentRows(rowIds) : new Set<string>();
      const look: UploadLookups = { concepts: new Set(ctx.concepts.map((c) => c.concept_id)), sets: new Set(ctx.sets.map((x) => x.typical_set_id)),
        patterns: new Map(ctx.patterns.map((x) => [x.pattern_id, x.typical_set_id])), settings: new Set(ctx.settings.map((x) => x.setting_id)), sourceItems: items, contentRows };
      setParsed(rows.map((r) => parseUploadRow(r.row, r.cells, look)));
      setExtra(unknownHeaders.map((h) => `column "${h}" is not in the template; ignored`));
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const importNow = async () => {
    if (!file || !parsed) return;
    setBusy(true); setErr(null);
    try {
      const r = await addQuestions({
        topic_id: topic.topic_id, origin: 'upload', file_name: file.name, file_hash: await sha256(file),
        questions: valid.map((p) => p.q),
        skipped: skipped.map((p) => ({ level: 'error', where: `row ${p.row}`, message: p.errors.join('; ') })),
        warnings: [...parsed.filter((p) => p.q && !p.errors.length && p.warnings.length).map((p) => ({ level: 'warning', where: `row ${p.row}`, message: p.warnings.join('; ') })),
          ...extra.map((m) => ({ level: 'warning', where: 'file', message: m }))],
      });
      setResult(r);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="add-form card">
      <div className="add-head"><h3>Bulk upload (Excel) to {topic.topic_id} · {topic.name}</h3>
        <button className="link small" disabled={!ctx} onClick={() => downloadTemplate(topic, ctx).catch((e) => setErr(e.message))}>Download template</button></div>
      <p className="muted small">The topic is fixed by where you are. Only the required columns are checked: rows missing one are skipped with the reason; the rest are added as Needs review · Uploaded, with attributes and originality pending. No similarity, duplicate or quality checks.</p>
      {!result && <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={busy || !ctx} onChange={(e) => pick(e.target.files?.[0] ?? null)} />}
      {busy && <p className="muted small">Working…</p>}
      {err && <p className="error small">{err}</p>}
      {parsed && !result && (
        <>
          <p className="small"><strong>{valid.length}</strong> row{valid.length === 1 ? '' : 's'} ready · <strong>{skipped.length}</strong> will be skipped
            {parsed.some((p) => p.example) ? ' · the example row is left out' : ''}{extra.length ? ` · ${extra.join('; ')}` : ''}</p>
          <div className="upload-preview">
            <table className="list small">
              <thead><tr><th>Row</th><th>Result</th><th>Question</th><th>Format</th><th>Answer</th><th>Level</th><th>Problems</th></tr></thead>
              <tbody>{parsed.filter((p) => p.q).map((p) => (
                <tr key={p.row} className={p.errors.length ? 'row-skip' : ''}>
                  <td>{p.row}</td>
                  <td className="nowrap">{p.errors.length ? <span className="error">✗ skip</span> : <span className="ok">✓ ready</span>}</td>
                  <td className="clip">{p.q!.text || <span className="muted">—</span>}</td>
                  <td>{p.q!.format || '—'}</td><td>{p.q!.correct || '—'}</td><td>{p.q!.level ?? '—'}</td>
                  <td>{p.errors.map((e) => <div key={e} className="error">{e}</div>)}{p.warnings.map((w) => <div key={w} className="muted">{w}</div>)}</td>
                </tr>))}</tbody>
            </table>
          </div>
          <div className="form-actions">
            <button disabled={busy || !valid.length} onClick={importNow}>Import {valid.length} row{valid.length === 1 ? '' : 's'}{skipped.length ? ` (skip ${skipped.length})` : ''}</button>{' '}
            <button className="link" disabled={busy} onClick={() => onDone(false)}>Cancel</button>
          </div>
        </>
      )}
      {result && (
        <div className="upload-summary small">
          <p><strong>Added {result.added.length} question{result.added.length === 1 ? '' : 's'}</strong> from {file?.name} (Needs review · Uploaded){result.import_id ? <> · <a href={`#/imports/${result.import_id}`}>upload #{result.import_id}</a></> : null}</p>
          {result.added.length > 0 && <p className="muted">{result.added.map((a) => `${a.question_id} (row ${a.row})`).join(' · ')}</p>}
          {skipped.length > 0 && <><p><strong>Skipped {skipped.length} row{skipped.length === 1 ? '' : 's'}:</strong></p>
            <ul>{skipped.map((p) => <li key={p.row}>Row {p.row}: {p.errors.join('; ')}</li>)}</ul></>}
          <button onClick={() => onDone(true)}>Done</button>
        </div>
      )}
    </div>
  );
}

/** 13 Nov 2026: where an added question came from, and what is still pending. */
export function OriginFlags({ q, compact }: { q: { bank?: string; created_from?: string | null; upload_file?: string | null; uploaded_at?: string | null; attributes_pending?: boolean | null; image_pending?: boolean | null; originality_pending?: boolean | null }; compact?: boolean }) {
  const when = q.uploaded_at ? new Date(q.uploaded_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  const added = q.created_from === 'manual' || q.created_from === 'upload';
  return (
    <>
      {q.created_from === 'manual' && <span className="tag origin" title="Added by hand in the CMS">Manual</span>}
      {q.created_from === 'upload' && <span className="tag origin" title={`Uploaded from ${q.upload_file ?? 'an Excel file'}${when ? ` on ${when}` : ''}`}>{compact ? 'Uploaded' : `Uploaded · ${q.upload_file ?? 'Excel'}${when ? ` · ${when}` : ''}`}</span>}
      {added && q.attributes_pending && <span className="tag pending" title="Signature and derived fields not evaluated yet">{compact ? 'Attr. pending' : 'Attributes pending'}</span>}
      {q.image_pending && q.bank !== 'gold' && <span className="tag pending" title="A picture is needed and not drawn yet">Image pending</span>}
      {q.originality_pending && <span className="tag pending orig" title="The book check runs on the Mac: npm run check:originality -- --pending">{compact ? 'Orig. pending' : 'Originality pending'}</span>}
    </>
  );
}
