// The ONLY privileges the logged-in role (authenticated) may have on cms objects.
// SELECT on everything except the migration history; writes only where a phase needs them.
export const WRITE_GRANTS: Record<string, string[]> = {
  cms_sources: ['INSERT', 'UPDATE'],          // Phase 4 (D2)
  cms_source_chapters: ['INSERT', 'UPDATE'],  // Phase 4 (D2)
  cms_source_jumps: ['INSERT', 'UPDATE'],     // Phase 4 (D2)
  cms_source_assets: ['INSERT', 'UPDATE'],    // Phase 4 (D2)
  cms_reviews: ['INSERT'],                    // audit log of browser saves
};

/** Grants that are NOT allowed, from rows of information_schema.role_table_grants for authenticated. */
export function unexpectedGrants(rows: { privilege_type: string; table_name: string }[]): string[] {
  return rows.filter((g) => g.privilege_type !== 'SELECT' && !(WRITE_GRANTS[g.table_name] ?? []).includes(g.privilege_type))
    .map((g) => `${g.privilege_type} on ${g.table_name}`);
}
