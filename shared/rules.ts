// Which rule version (WitoScope Question Attributes vN) is current. Several versions can be loaded
// side by side (rule tables are keyed by rule_version); the current one is cms_config
// current_rule_version, set by the seed when it loads a version at least as new (Sambit, 10 Nov 2026).

export const ruleNo = (v: string) => {
  const m = /^v(\d+)$/.exec(v);
  return m ? Number(m[1]) : NaN;
};

/** The configured current version if it is loaded, else the highest loaded one; null if none is loaded. */
export function currentRuleVersion(loaded: string[], configured: unknown): string | null {
  if (typeof configured === 'string' && loaded.includes(configured)) return configured;
  const ok = loaded.filter((v) => !Number.isNaN(ruleNo(v)));
  return ok.length ? ok.reduce((a, b) => (ruleNo(b) > ruleNo(a) ? b : a)) : null;
}

/** The seed only changes gold questions from a workbook that is (or becomes) the current version, so
 *  re-running an older workbook never turns gold back. */
export const workbookIsCurrent = (workbook: string, current: string | null) => !current || ruleNo(workbook) >= ruleNo(current);

export type GoldAction = 'unchanged' | 'typo_fix' | 'new_version' | 'blocked_open_version' | 'report_only';
/** What the seed does with an existing gold question that the workbook may have changed. */
export function goldAction(change: 'unchanged' | 'typo' | 'new', currentStatus: string, isCurrent: boolean): GoldAction {
  if (change === 'unchanged') return 'unchanged';
  if (!isCurrent) return 'report_only';
  if (currentStatus !== 'approved') return 'blocked_open_version'; // an edit in progress in the CMS is never overwritten
  return change === 'typo' ? 'typo_fix' : 'new_version';
}
