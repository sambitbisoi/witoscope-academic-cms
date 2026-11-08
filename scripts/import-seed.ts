// npm run import:seed [-- --dry-run] [--file <v10.xlsx>]
//
// Loads the WitoScope Question Attributes workbook (v10 only; never v2 or the
// witoscope-app repo) into cms, as cms_owner, in one transaction.
//
// Step 1 (this file, now): cms_rule_versions row for the workbook version and
// the derived-field config in cms_config (multistep_bands, difficulty_points,
// load_thresholds) from "Derived Attributes" and "Engine Check" (decision 8).
// Catalogue and gold-set steps follow in the next commits.
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { assertCmsOwner, connect } from './lib/db.ts';
import { parseDerivedConfig } from './lib/v10-config.ts';
import { readRaw } from './lib/xlsx.ts';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const fi = args.indexOf('--file');
const file = fi >= 0 ? args[fi + 1]! : join(homedir(), 'WitoScope', 'ContentResearch', 'QuestionBank', 'WitoScope_Question_Attributes_v10.xlsx');

const m = /_v(\d+)\.xlsx$/.exec(basename(file));
if (!m) throw new Error(`cannot tell the workbook version from the file name ${basename(file)} (expected …_v10.xlsx)`);
const ruleVersion = `v${m[1]}`;
if (ruleVersion !== 'v10') throw new Error(`only v10 is approved for the seed; got ${ruleVersion}`);

const wb = await readRaw(file);
const sheet = (name: string) => {
  const s = wb.sheets.get(name);
  if (!s) throw new Error(`sheet "${name}" is missing from ${basename(file)}`);
  return s;
};
const config = parseDerivedConfig(sheet('Derived Attributes'), sheet('Engine Check'));

class DryRunRollback extends Error {}
const sql = connect();
try {
  await assertCmsOwner(sql);
  await sql.begin(async (tx) => {
    await tx`
      insert into cms.cms_rule_versions (rule_version, notes, source_file, source_hash)
      values (${ruleVersion}, 'WitoScope Question Attributes', ${basename(file)}, ${wb.sha256})
      on conflict (rule_version) do update set source_file = excluded.source_file, source_hash = excluded.source_hash`;
    const note = `from ${basename(file)} (${ruleVersion}), Derived Attributes + Engine Check`;
    for (const [key, value] of Object.entries(config)) {
      const [before] = await tx`select value from cms.cms_config where key = ${key}`;
      await tx`
        insert into cms.cms_config (key, value, note) values (${key}, ${tx.json(value as never)}, ${note})
        on conflict (key) do update set value = excluded.value, note = excluded.note, updated_at = now()`;
      if (before && JSON.stringify(before.value) !== JSON.stringify(value)) {
        await tx`
          insert into cms.cms_reviews (target, target_table, target_id, action, field_diff, by_label, reason)
          values ('catalogue', 'cms_config', ${key}, 'edit_catalogue', ${tx.json({ value: { before: before.value, after: value } } as never)},
                  'seed importer', ${note})`;
      }
    }
    if (dryRun) throw new DryRunRollback();
  });
} catch (e) {
  if (!(e instanceof DryRunRollback)) throw e;
} finally {
  await sql.end();
}

console.log(`Seed ${ruleVersion}${dryRun ? ' (DRY RUN — nothing saved)' : ''}: ${basename(file)} sha256 ${wb.sha256.slice(0, 12)}`);
console.log('  cms_config', JSON.stringify(config));
