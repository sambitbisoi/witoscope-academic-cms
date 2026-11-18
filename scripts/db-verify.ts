// npm run db:verify — run against the real project BEFORE exposing schema cms
// (docs/phase2-plan.md §3, step 3). Read-only; connects as cms_owner.
// Every check must pass; any failure exits non-zero and says what is wrong.
import { tierChanges } from './lib/tier.ts';
import { conceptClassChanges } from './lib/concept-class.ts';
import { assertCmsOwner, connect } from './lib/db.ts';
import { unexpectedGrants } from './lib/grants.ts';

const sql = connect();
const results: { check: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: string) => results.push({ check: name, ok, detail });
const EXPECTED_POLICY = 'cms.cms_is_admin(( SELECT cms.cms_current_uid() AS cms_current_uid))';

try {
  await assertCmsOwner(sql);

  const tables = (await sql`select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
                            where n.nspname = 'cms' and c.relkind = 'r' order by 1`) as unknown as { relname: string; relrowsecurity: boolean }[];
  check('every cms table has RLS enabled', tables.every((t) => t.relrowsecurity), tables.filter((t) => !t.relrowsecurity).map((t) => t.relname).join(', '));
  check('no table outside the cms_ naming rule', tables.every((t) => t.relname.startsWith('cms_')), tables.filter((t) => !t.relname.startsWith('cms_')).map((t) => t.relname).join(', '));

  const views = await sql`select c.relname, coalesce(c.reloptions, '{}') as opts from pg_class c join pg_namespace n on n.oid = c.relnamespace
                          where n.nspname = 'cms' and c.relkind in ('v', 'm')`;
  const unsafeViews = views.filter((v) => !(v.opts as string[]).includes('security_invoker=true'));
  check('every cms view is security_invoker (RLS applies through it)', unsafeViews.length === 0, unsafeViews.map((v) => v.relname).join(', '));

  const policies = await sql`select tablename, roles::text[] as roles, qual, with_check from pg_policies where schemaname = 'cms'`;
  const want = tables.map((t) => t.relname).filter((t) => t !== 'cms_schema_migrations');
  const bad = want.filter((t) => {
    const p = policies.filter((x) => x.tablename === t);
    return p.length !== 1 || p[0]!.qual !== EXPECTED_POLICY || p[0]!.with_check !== EXPECTED_POLICY || p[0]!.roles.join() !== 'authenticated';
  });
  check('every table (but migration history) has exactly the admin policy, for authenticated', bad.length === 0, bad.join(', '));
  check('migration history has no policy (owner only)', !policies.some((p) => p.tablename === 'cms_schema_migrations'));

  const grants = await sql`select grantee, privilege_type, table_name from information_schema.role_table_grants
                           where table_schema = 'cms' and grantee not in ('cms_owner', 'postgres')`;
  const others = grants.filter((g) => g.grantee !== 'authenticated');
  check('table grants: nobody but authenticated', others.length === 0, others.map((g) => `${g.grantee} ${g.privilege_type} ${g.table_name}`).join(', '));
  const extra = unexpectedGrants(grants.filter((g) => g.grantee === 'authenticated') as never);
  check('authenticated: SELECT, plus only the listed writes (no DELETE anywhere)', extra.length === 0, extra.join(', '));

  const [s] = await sql`select has_schema_privilege('anon', 'cms', 'usage') as anon_usage,
                               has_schema_privilege('authenticated', 'cms', 'usage') as auth_usage,
                               has_schema_privilege('service_role', 'cms', 'usage') as service_usage,
                               has_schema_privilege('cms_owner', 'auth', 'usage') as owner_auth,
                               has_schema_privilege('cms_owner', 'public', 'create') as owner_public_create`;
  check('anon has no USAGE on cms', s!.anon_usage === false);
  check('authenticated has USAGE on cms', s!.auth_usage === true);
  check('service_role has no USAGE on cms', s!.service_usage === false);
  check('cms_owner has no USAGE on auth', s!.owner_auth === false);
  check('cms_owner cannot create in public', s!.owner_public_create === false);

  const fns = await sql`select p.proname, p.prosecdef, p.provolatile, p.proconfig,
                               has_function_privilege('anon', p.oid, 'execute') as anon_exec,
                               has_function_privilege('authenticated', p.oid, 'execute') as auth_exec
                        from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'cms'`;
  const fn = (name: string) => fns.find((f) => f.proname === name);
  const uid = fn('cms_current_uid');
  const adm = fn('cms_is_admin');
  check('cms_current_uid: security invoker, stable, empty search_path, authenticated only',
    !!uid && !uid.prosecdef && uid.provolatile === 's' && uid.proconfig?.[0] === 'search_path=""' && uid.auth_exec && !uid.anon_exec);
  check('cms_is_admin: security definer, stable, empty search_path, authenticated only',
    !!adm && adm.prosecdef && adm.provolatile === 's' && adm.proconfig?.[0] === 'search_path=""' && adm.auth_exec && !adm.anon_exec);

  const DEFINER_ALLOWED = ['cms_is_admin', 'cms_apply_save', 'cms_set_status', 'cms_retire', 'cms_record_run', 'cms_save_job', 'cms_set_catalogue_status', 'cms_save_curriculum', 'cms_decide_override', 'cms_set_topic_review', 'cms_add_questions', 'cms_save_order', 'cms_decide_topic_class', 'cms_save_science_review', 'cms_save_content_links', 'cms_set_row_misconception_status', 'cms_save_content_row', 'cms_place_held_out', 'cms_discard_held_out', 'cms_decide_overrides',
    'cms_save_course_board', 'cms_save_course', 'cms_set_course_status', 'cms_copy_course'];
  const badFns = fns.filter((f) => f.proconfig?.[0] !== 'search_path=""' || f.anon_exec || (f.prosecdef && !DEFINER_ALLOWED.includes(f.proname)));
  check('every cms function: empty search_path, no anon access; only the listed functions run as owner', badFns.length === 0, badFns.map((f) => f.proname).join(', '));

  // Book material stays on the Mac (Sambit, 10 Nov 2026): the cloud holds citations only.
  const cols = await sql`select table_name, column_name from information_schema.columns where table_schema = 'cms'
                         and table_name in ('cms_source_items', 'cms_sources')`;
  const itemCols = cols.filter((c) => c.table_name === 'cms_source_items').map((c) => c.column_name as string).sort();
  const CITATION = ['item_label', 'page', 'pattern_id', 'ref_id', 'section', 'source_id', 'topic_id'];
  check('book items are citations only (no item text or numbers)', itemCols.join() === CITATION.join(), itemCols.join(', '));
  check('sources hold no file key (book files stay on the Mac)', !cols.some((c) => c.table_name === 'cms_sources' && c.column_name === 'storage_path'));
  check('no screenshot table', !tables.some((t) => t.relname === 'cms_source_assets'));
  const [badUrl] = await sql`select count(*)::int as n from cms.cms_sources where publisher = 'NCERT' and url !~ '^https://ncert\\.nic\\.in/'`;
  check('NCERT sources link only to ncert.nic.in', badUrl!.n === 0, `${badUrl!.n} other links`);

  const [mapCols] = await sql`select count(*)::int as n from cms.cms_source_map m, jsonb_array_elements(m.cells) c where c ->> 0 ~* '(evidence|^notes?\y|source scan)'`;
  check('source-mapping rows hold no evidence, notes or scan paths (book text stays on the Mac)', mapCols!.n === 0, `${mapCols!.n} such cells`);

  // Science (13 Nov 2026): citations are a source + printed pages + the cell's own short citation, nothing else
  const citCols = (await sql`select column_name from information_schema.columns where table_schema = 'cms' and table_name = 'cms_citations' order by 1`).map((c) => c.column_name as string);
  check('Science citations are citations only (source, pages, short label)', citCols.join() === ['citation_id', 'for_row_id', 'page_from', 'page_to', 'raw', 'row_id', 'source_id', 'version_id'].join(), citCols.join(', '));
  const [badCit] = await sql`select count(*)::int as n from cms.cms_citations
    where raw !~ '^(NCERT p\\.|DAV |Claude-added \\(extends NCERT p|[A-Za-z][A-Za-z0-9]* (pp?\\.)?[0-9])' or char_length(raw) > 80`;
  check('every Science citation label looks like "NCERT p.N" / "<book> p.N"', badCit!.n === 0, `${badCit!.n} other labels`);

  // Science misconception items and primary rows (0035, 16 Nov 2026)
  const hasItems = (await sql`select to_regclass('cms.cms_row_misconceptions') as t`)[0]!.t !== null;
  if (hasItems) {
    const [x] = await sql`select
      (select count(*)::int from cms.cms_question_versions v where v.misconception_row_id is not null
         and not exists (select 1 from cms.cms_question_content_rows l where l.version_id = v.version_id and l.row_id = v.misconception_row_id)) as off_row,
      (select count(*)::int from cms.cms_version_wrong_answers w where w.mc_row_id is not null
         and not exists (select 1 from cms.cms_question_content_rows l where l.version_id = w.version_id and l.row_id = w.mc_row_id)) as wrong_off_row,
      (select count(*)::int from (select version_id from cms.cms_question_content_rows where rank = 'primary' group by 1 having count(*) > 1) t) as two_primary,
      (select count(*)::int from cms.cms_question_content_rows where (role = 'supporting') <> (rank = 'context')) as bad_rank,
      (select count(*)::int from (select row_id from cms.cms_row_misconceptions group by 1 having max(item_no) <> count(*)) t) as gaps,
      exists (select 1 from cms.cms_imports where kind = 'science_rationalise' and finished_at is not null) as rationalised,
      (select count(*)::int from cms.cms_question_versions v join cms.cms_questions q on q.question_id = v.question_id
         where q.subject = 'science' and btrim(coalesce(v.misconception_targeted, '')) <> '') as free_text,
      (select count(*)::int from cms.cms_content_rows r where btrim(coalesce(r.misconceptions, '')) <> ''
         and not exists (select 1 from cms.cms_row_misconceptions m where m.row_id = r.row_id and m.source = 'row split')) as unsplit`;
    check('Science misconception references point at items of the question\'s own content rows', x!.off_row === 0 && x!.wrong_off_row === 0, `${x!.off_row} targeted, ${x!.wrong_off_row} wrong options off their rows`);
    check('at most one primary content row per version; supporting rows are context', x!.two_primary === 0 && x!.bad_rank === 0, `${x!.two_primary} with two primaries, ${x!.bad_rank} rank/role mismatches`);
    check('misconception items are numbered 1…n per row, no gaps', x!.gaps === 0, `${x!.gaps} rows with gaps`);
    check('after science:rationalise: no free-text Science misconception, every row\'s misconceptions split into items',
      !x!.rationalised || (x!.free_text === 0 && x!.unsplit === 0), x!.rationalised ? `${x!.free_text} free text, ${x!.unsplit} rows not split` : 'not rationalised yet');
  }

  // Q14 (17 Nov 2026): content rows made or edited in the CMS
  const hasCmsRows = (await sql`select 1 from information_schema.columns where table_schema = 'cms' and table_name = 'cms_content_rows' and column_name = 'cms_edited_at'`).length > 0;
  if (hasCmsRows) {
    const [c] = await sql`select
      (select count(*)::int from cms.cms_content_rows where source = 'CMS' and (originality_result is not null or originality_ref is not null)) as cms_checked,
      (select count(*)::int from cms.cms_content_rows r where r.cms_edited_at is not null
         and exists (select 1 from cms.cms_row_misconceptions m0 where m0.row_id = r.row_id)
         and r.misconceptions is distinct from (select rtrim(string_agg(case when m.text ~ '[.!?]$' then m.text else m.text || ';' end, ' ' order by m.item_no), ';') from cms.cms_row_misconceptions m where m.row_id = r.row_id and m.status = 'active')) as text_off,
      (select count(*)::int from cms.cms_content_rows r where r.source = 'CMS' and r.row_id !~ ('^C' || r.row_class || '-') and not exists (
         select 1 from cms.cms_reviews v where v.target_table = 'cms_content_rows' and v.target_id = r.row_id and v.action = 'science_row' and v.field_diff ? 'row_class')) as bad_id,
      (select count(*)::int from cms.cms_content_rows r where r.cms_edited_at is not null and not exists (
         select 1 from cms.cms_reviews v where v.target_table = 'cms_content_rows' and v.target_id = r.row_id)) as unaudited`;
    check('CMS content rows: no originality fields (own writing), IDs follow C<class>-<code>-<n>, every change audited',
      c!.cms_checked === 0 && c!.bad_id === 0 && c!.unaudited === 0, `${c!.cms_checked} with originality, ${c!.bad_id} odd IDs, ${c!.unaudited} unaudited`);
    check('rows edited in the CMS: the misconceptions text equals their active items', c!.text_off === 0, `${c!.text_off} rows differ`);
  }

  // Q21 (17 Nov 2026): the Held-out area holds our own content and citations only; never a near-copy
  if ((await sql`select to_regclass('cms.cms_held_out') as t`)[0]!.t !== null) {
    const [h] = await sql`select
      (select count(*)::int from cms.cms_held_out where originality ->> 'result' = 'near_copy') as near,
      (select count(*)::int from cms.cms_held_out where originality is not null and exists (select 1 from jsonb_object_keys(originality) k
         where k not in ('checked_at', 'result', 'similarity', 'same_numbers', 'closest_ref', 'field', 'checked', 'missing', 'threshold', 'near_copy_threshold', 'tool'))) as odd_orig,
      (select count(*)::int from cms.cms_held_out where question ?| array['book_text', 'item_text', 'source_text', 'page_text']) as book_text,
      (select count(*)::int from cms.cms_held_out h where h.status = 'placed' and not exists (select 1 from cms.cms_questions q where q.question_id = h.placed_question_id and q.file_key = h.file_key)) as bad_place`;
    check('held-out items: no near-copy, citation-only originality, no book text, placed ones exist with their key',
      h!.near === 0 && h!.odd_orig === 0 && h!.book_text === 0 && h!.bad_place === 0, `${h!.near} near-copy, ${h!.odd_orig} odd originality, ${h!.book_text} book text, ${h!.bad_place} bad placements`);
  }

  // Q20 (17 Nov 2026): every stored tier follows "Tier uses Level" (enforced once tier:recompute has run)
  const tierOff = await tierChanges(sql);
  const [tr] = await sql`select exists (select 1 from cms.cms_imports where kind = 'tier_recompute' and finished_at is not null) as done`
    .catch(() => [{ done: false }]);
  check('stored tiers follow "Tier uses Level" (Q20)', !tr!.done || tierOff.length === 0,
    `${tierOff.length} version(s) differ${tr!.done ? '' : ' (tier:recompute not run yet)'}`);

  // Q24 (17 Nov 2026): concept class = "first taught in", lower only; the catalogued class is never lost
  const [hasQ24] = await sql`select exists (select 1 from information_schema.columns where table_schema = 'cms' and table_name = 'cms_concepts' and column_name = 'class_legacy') as yes`;
  if (hasQ24!.yes) {
    const [cc] = await sql`select count(*) filter (where class_basis = 'first_taught' and (class_legacy is null or class >= class_legacy))::int as bad,
                                  count(*) filter (where class_basis = 'first_taught')::int as lowered from cms.cms_concepts`;
    const [aud] = await sql`select count(*)::int as n from cms.cms_concepts c where c.class_basis = 'first_taught'
                             and not exists (select 1 from cms.cms_reviews r where r.target = 'catalogue' and r.target_id = c.concept_id and r.action = 'derived_update')`;
    check('concept classes "first taught in" (Q24): lowered only, catalogued class kept, every change audited', cc!.bad === 0 && aud!.n === 0,
      `${cc!.lowered} lowered, ${cc!.bad} wrong, ${aud!.n} without an audit row`);
    // Drift (new imports since the last run) is information only, never a failure: re-run concept:first-taught (checklist D11)
    const drift = await conceptClassChanges(sql);
    check('info: concept classes in step with "first taught in" (re-run concept:first-taught after Math imports)', true,
      drift.length ? `${drift.length} concept(s) would change: ${drift.slice(0, 5).map((d) => `${d.concept_id} ${d.before}→${d.after}`).join(', ')}` : 'in step');
  }

  // 0041 (Round 2, 17 Nov 2026): Science question attributes (Q26), the retired authored tier (Q27), settings by subject (Q28),
  // Science wrong-option tags (Q32)
  const [has41] = await sql`select exists (select 1 from information_schema.columns where table_schema = 'cms' and table_name = 'cms_question_versions' and column_name = 'science_question_type') as yes`;
  if (has41!.yes) {
    const [s1] = await sql`
      select (select count(*) from cms.cms_question_versions v join cms.cms_questions q on q.question_id = v.question_id
               where q.subject <> 'science' and (v.science_question_type is not null or v.setting_familiarity is not null or v.has_hidden_idea is not null
                     or v.has_experiment is not null or v.science_tier_legacy is not null))::int as on_math,
             (select count(*) from cms.cms_question_versions v where v.level_tier is not null and v.science_tier_legacy is distinct from v.level_tier)::int as legacy_lost,
             (select count(*) from cms.cms_questions q join cms.cms_settings s on s.setting_id = q.setting_id where s.subject <> q.subject)::int as setting_subject,
             (select count(*) from cms.cms_question_versions v join cms.cms_questions q on q.question_id = v.question_id
               join cms.cms_version_wrong_answers w on w.version_id = v.version_id
               where q.subject = 'science' and v.status = 'approved' and w.tag = 'concept_error'
                 and not exists (select 1 from cms.cms_question_content_rows l where l.version_id = v.version_id and l.row_id = w.target_row_id))::int as ce_unlinked,
             (select count(*) from cms.cms_question_versions v join cms.cms_questions q on q.question_id = v.question_id
               where q.subject = 'science' and q.bank = 'production' and v.status = 'approved' and v.science_question_type is null)::int as approved_untyped`;
    check('Science attributes (0041): Science-only fields, legacy tier kept, settings match the subject, concept errors on own rows, approved Science typed',
      s1!.on_math === 0 && s1!.legacy_lost === 0 && s1!.setting_subject === 0 && s1!.ce_unlinked === 0 && s1!.approved_untyped === 0,
      `${s1!.on_math} non-Science with Science fields, ${s1!.legacy_lost} legacy tiers not kept, ${s1!.setting_subject} settings of another subject, ${s1!.ce_unlinked} concept errors off its rows, ${s1!.approved_untyped} approved untyped`);
  }

  // 0042 (Q29): a Science tier follows its Science question type (1–3 School · 4 Achiever · 5 Super Achiever; untyped none)
  const [has42] = await sql`select exists (select 1 from information_schema.views where table_schema = 'cms' and table_name = 'cms_science_derived') as yes`;
  if (has42!.yes) {
    const [st] = await sql`select count(*)::int as n from cms.cms_question_versions v join cms.cms_questions q on q.question_id = v.question_id
      where q.subject = 'science' and v.tier is distinct from case when v.science_question_type between 1 and 3 then 'School'
        when v.science_question_type = 4 then 'Achiever' when v.science_question_type = 5 then 'Super Achiever' end`;
    check('Science tiers follow the Science question type (Q29)', st!.n === 0, `${st!.n} version(s) differ`);
  }

  // 0045 (Q13, 18 Nov 2026): Course builder. Courses only arrange CMS topics; the book chapter reference holds bare citations.
  const [has45] = await sql`select exists (select 1 from information_schema.tables where table_schema = 'cms' and table_name = 'cms_courses') as yes`;
  if (has45!.yes) {
    const refCols = (await sql`select column_name from information_schema.columns where table_schema = 'cms' and table_name = 'cms_ref_book_chapters' order by 1`).map((r) => r.column_name as string);
    check('book chapter reference holds only book, class, subject, chapter number and title (bare citations)',
      refCols.join() === ['book', 'book_title', 'ch_name', 'ch_no', 'class', 'import_id', 'ref_id', 'subject', 'updated_at'].join(), refCols.join(', '));
    const [cx] = await sql`
      select (select count(*) from cms.cms_course_topic_items i join cms.cms_courses c on c.course_id = i.course_id
               join cms.cms_topics t on t.topic_id = i.topic_id join cms.cms_chapters ch on ch.chapter_id = t.chapter_id
               where i.removed_at is null and (t.topic_kind <> 'normal' or ch.subject <> c.subject))::int as bad_topic,
             (select count(*) from cms.cms_course_achievers a join cms.cms_courses c on c.course_id = a.course_id
               join cms.cms_chapters ch on ch.chapter_id = a.chapter_id where a.removed_at is null and (c.subject <> 'math' or ch.subject <> c.subject))::int as bad_ach,
             (select count(*) from cms.cms_course_topic_items i join cms.cms_course_topics t on t.course_topic_id = i.course_topic_id
               where i.removed_at is null and t.status <> 'active')::int as on_retired,
             (select count(*) from cms.cms_courses c where not exists (select 1 from cms.cms_reviews r where r.target = 'course'
               and r.target_table = 'cms_courses' and r.target_id = c.course_id and r.action = 'create'))::int as unaudited`;
    check('courses (0045): CMS topics of the course subject, Achievers only on Math, no links on retired display topics, every course audited',
      cx!.bad_topic === 0 && cx!.bad_ach === 0 && cx!.on_retired === 0 && cx!.unaudited === 0,
      `${cx!.bad_topic} wrong topics, ${cx!.bad_ach} wrong Achievers links, ${cx!.on_retired} links on retired topics, ${cx!.unaudited} courses without a create row`);
    const pub = await sql`select c.course_id, count(e.kind)::int as n from cms.cms_courses c cross join lateral cms.cms_course_errors(c.course_id) e
                           where c.status = 'published' group by c.course_id`;
    check('info: published courses with an open ✗ check (e.g. a CMS topic retired since)', true, pub.length ? pub.map((p) => `${p.course_id} ${p.n}`).join(', ') : 'none');
    const [rb] = await sql`select count(*)::int as n from cms.cms_ref_book_chapters`;
    check('info: book chapter reference loaded (npm run import:book-chapters)', true, `${rb!.n} chapters`);
  }

  const [admin] = await sql`select value #>> '{}' as id from cms.cms_config where key = 'admin_user_id'`;
  check('cms_config.admin_user_id is set to a UUID', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(admin?.id ?? ''), admin?.id ?? 'not set');

  const cfg = await sql`select key from cms.cms_config where key in ('multistep_bands', 'difficulty_points', 'load_thresholds')`;
  check('derived-field config loaded (import:seed)', cfg.length === 3, `${cfg.length}/3 keys`);
  const [counts] = await sql`select (select count(*) from cms.cms_topics)::int as topics, (select count(*) from cms.cms_questions where bank = 'gold')::int as gold`;
  check('topic lists imported', counts!.topics > 0, `${counts!.topics} topics`);
  check('gold set seeded', counts!.gold > 0, `${counts!.gold} gold questions`);
} finally {
  await sql.end();
}

for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.check}${r.detail ? `  (${r.detail})` : ''}`);
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\ndb:verify: ${failed} check(s) FAILED — do not expose schema cms.` : '\ndb:verify: all checks passed.');
process.exit(failed ? 1 : 0);
