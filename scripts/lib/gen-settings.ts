// Q38 PR 1 (Sambit, 23 Nov 2026): a generated question's free-text setting (the scene, e.g. "Potted plant near a window")
// is mapped to the closest EXISTING setting first (one shared SET list); a new setting is proposed only when none fits,
// and near-identical phrasings within a run become one. The scene itself stays on the question as its setting note
// (DL-007: Science settings are specific; broad SETs may become setting groups in Q38 PR 10).
//
// The map is a reviewed file next to the pack (settings-map/1): the helper drafts it from word similarity, Claude/Sambit
// correct it by judgement, and gen:pack-pilot --settings-map applies it.
import { settingSlug } from './gen-adapters/science-pilot04.ts';
import type { Pack } from './gen-pack.ts';

export interface SettingRow { setting_id: string; name: string; theme: string | null; description: string | null; subject: string; status: string }
export interface MapEntry { scene: string; setting_id?: string | null; new?: { name: string; description?: string | null } | null; score?: number | null; why?: string | null; candidates?: { setting_id: string; name: string; score: number }[] }
export interface SettingsMap { file_schema: 'settings-map/1'; subject: string; source_run?: string; note?: string; entries: MapEntry[] }

const STOP = new Set(['a', 'an', 'the', 'of', 'in', 'on', 'at', 'to', 'by', 'and', 'with', 'for', 'from', 'after', 'into', 'near', 'beside', 'off', 'an', 'old', 'its', 'his', 'her', 'no', 'story']);
/** words of a phrase: lower case, no stop words, crude singular ("trees" → "tree", "leaves" → "leaf") */
export function words(s: string): string[] {
  return [...new Set(s.toLowerCase().replace(/[’']s\b/g, '').split(/[^a-z]+/).filter((w) => w.length > 2 && !STOP.has(w))
    .map((w) => w.replace(/ves$/, 'f').replace(/ies$/, 'y').replace(/(?<!s)s$/, '')))];
}
/** Share of the scene's words found in the setting's name / theme / description (0–1). */
export function similarity(scene: string, s: Pick<SettingRow, 'name' | 'theme' | 'description'>): number {
  const a = words(scene), b = new Set(words([s.name, s.theme ?? '', s.description ?? ''].join(' ')));
  return a.length ? Math.round((a.filter((w) => b.has(w)).length / a.length) * 100) / 100 : 0;
}
/** Draft map: for each scene, the best existing settings (live ones of this subject or shared, plus the other subject's,
 *  which would become shared); below `min` it suggests a new setting named after the scene. Near-identical scenes
 *  (same words) share one suggestion. */
export function draftMap(scenes: string[], settings: SettingRow[], subject: string, min = 0.34): SettingsMap {
  const live = settings.filter((s) => s.status !== 'retired' && s.name.toLowerCase() !== 'bare' && !/^bare\b/i.test(s.name));
  const byWords = new Map<string, string>();
  const entries: MapEntry[] = [...new Set(scenes)].sort().map((scene) => {
    const candidates = live.map((s) => ({ setting_id: s.setting_id, name: s.name, score: similarity(scene, s) }))
      .filter((c) => c.score > 0).sort((x, y) => y.score - x.score || x.setting_id.localeCompare(y.setting_id)).slice(0, 3);
    const best = candidates[0];
    if (best && best.score >= min) return { scene, setting_id: best.setting_id, score: best.score, why: `words in common with "${best.name}"`, candidates };
    const key = words(scene).sort().join(' ');
    const name = byWords.get(key) ?? scene;
    byWords.set(key, name);
    return { scene, new: { name }, score: best?.score ?? 0, why: 'no existing setting fits', candidates };
  });
  return { file_schema: 'settings-map/1', subject, entries };
}

/** Applies a reviewed map to a pack: mapped scenes → {setting_id}; new → one new setting per distinct name (Proposed).
 *  Every question keeps its scene as setting_note. Returns problems (a scene without an entry, an entry without a decision). */
export function applySettingsMap(pack: Pack, map: SettingsMap): string[] {
  const problems: string[] = [];
  const bySceneLower = new Map(map.entries.map((e) => [e.scene.trim().toLowerCase(), e]));
  const news = new Map<string, { local_id: string; name: string; description: string | null }>();
  for (const e of map.entries) {
    if (!!e.setting_id === !!e.new) problems.push(`settings map: "${e.scene}" needs exactly one of setting_id or new`);
    if (e.new) { const k = e.new.name.trim().toLowerCase(); if (!news.has(k)) news.set(k, { local_id: settingSlug(e.new.name), name: e.new.name.trim(), description: e.new.description ?? null }); }
  }
  for (const q of pack.questions) {
    const scene = q.setting_note?.trim();
    if (!scene || !q.setting) continue;   // bare
    const e = bySceneLower.get(scene.toLowerCase());
    if (!e) { problems.push(`${q.local_id}: scene "${scene}" is not in the settings map`); continue; }
    q.setting = e.setting_id ? { setting_id: e.setting_id } : { new: news.get(e.new!.name.trim().toLowerCase())!.local_id };
  }
  pack.catalogue_new = { ...(pack.catalogue_new ?? {}), settings: [...news.values()] };
  return problems;
}
