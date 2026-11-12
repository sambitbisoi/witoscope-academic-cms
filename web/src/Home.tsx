import { useEffect, useState } from 'react';
import { activeJobs, homeStats, lastImport, type HomeStats, type Job, type LastImport } from './api';
import { seedLabel } from './Imports';
import { browseHash, SUBJECTS, subjectLabel } from './logic';
import { Jobs } from './Jobs';

const GRADES = ['all', '1', '2', '3', '4', '5', '6'];
const GRADE_KEY = 'cms.grade';
const savedGrade = () => { try { return localStorage.getItem(GRADE_KEY) ?? 'all'; } catch { return 'all'; } };

type Totals = Omit<HomeStats, 'subject' | 'class'>;
const ZERO: Totals = { chapters: 0, topics: 0, questions: 0, approved: 0, draft: 0, in_review: 0, gold: 0, topics_with_questions: 0, topics_all_levels: 0 };
function sum(rows: HomeStats[]): Totals {
  return rows.reduce<Totals>((t, r) => ({
    chapters: t.chapters + r.chapters, topics: t.topics + r.topics, questions: t.questions + r.questions, approved: t.approved + r.approved,
    draft: t.draft + r.draft, in_review: t.in_review + r.in_review, gold: t.gold + r.gold,
    topics_with_questions: t.topics_with_questions + r.topics_with_questions, topics_all_levels: t.topics_all_levels + r.topics_all_levels,
  }), { ...ZERO });
}

export function Home({ grade: routeGrade }: { grade: string | null }) {
  const grade = routeGrade && GRADES.includes(routeGrade) ? routeGrade : savedGrade();
  const [stats, setStats] = useState<HomeStats[] | null>(null);
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [last, setLast] = useState<LastImport | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    homeStats().then(setStats).catch((e) => setError(e.message));
    // secondary panels: best-effort, never block the page
    activeJobs().then(setJobs).catch(() => setJobs([]));
    lastImport().then(setLast).catch(() => setLast(null));
  }, []);
  const pick = (g: string) => { try { localStorage.setItem(GRADE_KEY, g); } catch { /* best effort */ } location.hash = g === 'all' ? '#/' : `#/?grade=${g}`; };

  if (error) return <main><p className="error">Couldn't load the overview: {error}</p></main>;
  // D6: the Review tab holds "Needs review" and rejected questions; drafts are reviewed in Browse.
  const queue = SUBJECTS.map((s) => ({ s, n: (stats ?? []).filter((r) => r.subject === s.id).reduce((n, r) => n + r.in_review, 0) }));
  const queueTotal = queue.reduce((n, x) => n + x.n, 0);
  const drafts = (stats ?? []).reduce((n, r) => n + r.draft, 0);

  return (
    <main className="wide">
      <section className="work-strip" aria-label="Today's work">
        <div className="card">
          <div className="eyebrow">Review</div>
          <div className="big">{stats ? queueTotal : '…'} <span className="muted">need{queueTotal === 1 ? 's' : ''} review</span></div>
          <div className="muted small">{queue.map((x) => `${x.s.label} ${x.n}`).join(' · ')}{stats ? ` · ${drafts} draft${drafts === 1 ? '' : 's'} not reviewed yet (review them in Browse)` : ''}</div>
          <a className="button-link" href="#/review">Open Review (flagged and rejected)</a>
        </div>
        <div className="card">
          <div className="eyebrow">Jobs</div>
          <Jobs />
          {last && (
            <div className="small">
              Last import: <a href={`#/imports/${last.import_id}`}>#{last.import_id}</a> {last.kind === 'chapter' ? `chapter ${last.chapter_id ?? ''}` : last.kind === 'seed' ? seedLabel(last.file_path) : 'topic lists'}
              {' '}<span className={`badge ${last.result ?? 'running'}`}>{last.result === 'ok' ? 'OK' : last.result === 'partial' ? 'Partial' : last.result === 'failed' ? 'Failed' : 'Running'}</span>
            </div>
          )}
        </div>
      </section>

      <section aria-label="Browse content">
        <div className="section-head">
          <h2>Browse content</h2>
          <div role="group" aria-label="Grade" className="grades">
            <span className="muted small">Grade</span>
            {GRADES.map((g) => (
              <button key={g} aria-pressed={g === grade} className={`pill ${g === grade ? 'on' : ''}`} onClick={() => pick(g)}>{g === 'all' ? 'All' : g}</button>
            ))}
          </div>
        </div>
        <div className="subject-cards">
          {SUBJECTS.map((s) => {
            const rows = (stats ?? []).filter((r) => r.subject === s.id && (grade === 'all' || r.class === Number(grade)));
            const t = sum(rows);
            const classes = grade === 'all' ? 'Classes 1–6' : `Class ${grade}`;
            return (
              <a key={s.id} className="subject-card" href={browseHash({ subject: s.id, cls: grade })}>
                <div className="subject-name">{subjectLabel(s.id)}</div>
                {!stats ? <div className="muted">…</div> : (
                  <>
                    {/* chapters span classes, so per-class chapter counts can't be added up for "All" */}
                    <div className="muted">{classes} · {grade !== 'all' ? `${t.chapters} chapters · ` : ''}{t.topics} topics</div>
                    <div>{t.questions === 0 ? <span className="muted">Questions: none yet</span> : <>Questions: {t.approved} approved · {t.draft} draft{t.in_review ? ` · ${t.in_review} need review` : ''}</>}</div>
                    {t.gold > 0 && <div className="muted small">Gold set: {t.gold} (reference only)</div>}
                    {t.questions > 0 && <span className="chip">All 3 levels: {t.topics_all_levels} of {t.topics_with_questions} topics with questions</span>}
                  </>
                )}
              </a>
            );
          })}
        </div>
      </section>
    </main>
  );
}
