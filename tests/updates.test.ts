// CMS-updates file contracts (queue 12 Nov 2026): parsing and checks.
import { describe, expect, it } from 'vitest';
import { convertPipelineFile, parseCsv, parseKeyFixes, parseLevels, parseQuestionSettings, parseSettings, parseTopicClasses } from '../scripts/lib/updates.ts';

describe('parseCsv', () => {
  it('handles quotes, escaped quotes, commas and newlines in fields, CRLF and a BOM', () => {
    const r = parseCsv('﻿a,b,c\r\n1,"x, ""y""",3\r\n"multi\nline",,z\n');
    expect(r.header).toEqual(['a', 'b', 'c']);
    expect(r.rows.map((x) => x.values)).toEqual([{ a: '1', b: 'x, "y"', c: '3' }, { a: 'multi\nline', b: '', c: 'z' }]);
    expect(r.rows.map((x) => x.line)).toEqual([2, 3]);
  });
});

describe('file contracts', () => {
  it('question_levels: 1–6, a key once', () => {
    const r = parseLevels('file_key,level,source_file,source_field\nMC04-0007,5,NCERT-C5-01/MC04-C5.json,Book class\nMC04-0008,7,,\nbad,3,,\nMC04-0007,5,,\nMC04-0009,4,,\n');
    expect(r.rows.map((x) => [x.file_key, x.level])).toEqual([['MC04-0007', 5], ['MC04-0009', 4]]);
    expect(r.problems.map((p) => p.level)).toEqual(['error', 'error']);
  });
  it('topic_classes: known sources, warns on others', () => {
    const r = parseTopicClasses('topic_id,class,source,evidence\nMT0429,5,NCERT,Maths Mela ch 3\nMT0429,6,DAV,\nMT0429,6,DAV,\nMT0001,9,NCERT,\nMT0002,3,Other,\n');
    expect(r.rows.map((x) => `${x.topic_id}/${x.class}`)).toEqual(['MT0429/5', 'MT0429/6', 'MT0002/3']);
    expect(r.problems.map((p) => p.level)).toEqual(['warning', 'error', 'warning']);
    const m = parseTopicClasses('topic_id,class,source,evidence\nMT0001,1,workbook-default; DAV; IMO,x\n');
    expect([m.rows[0]!.source, m.problems]).toEqual(['workbook-default; DAV; IMO', []]);
  });
  it('settings_catalogue: SET ids, unique names, Bare expected', () => {
    const r = parseSettings('setting_id,name,description,theme,status\nSET001,Lift,Floors up and down,Motion,proposed\nSET002,lift,dup,,\nSET003,Thermometer,,Weather,\n');
    expect(r.rows.map((x) => [x.setting_id, x.status])).toEqual([['SET001', 'proposed'], ['SET003', 'proposed']]);
    expect(r.problems.map((p) => p.message)).toEqual([expect.stringMatching(/used by SET001 and SET002/), expect.stringMatching(/no "Bare"/)]);
  });
  it('question_settings: one setting per question, confidence values', () => {
    const r = parseQuestionSettings('file_key,setting_id,confidence,note\nMC04-0007,SET001,high,\nMC04-0007,SET002,low,\nMC04-0008,SET001,sure,\n');
    expect(r.rows).toHaveLength(1);
    expect(r.problems).toHaveLength(2);
  });
  it('key_fixes: both keys valid and different', () => {
    const r = parseKeyFixes('old_file_key,new_file_key,source_file,reason\nMC19-0001,MC19-0901,NCERT-C6-03/MC19-C6.json,clash with the worked example\nMC19-0002,MC19-0002,x,\n');
    expect(r.rows.map((x) => x.new_file_key)).toEqual(['MC19-0901']);
    expect(r.problems).toHaveLength(1);
  });
  it('converts a pipeline file: patterns dropped, figure paths become figures/ keys or needs_image', () => {
    const c = convertPipelineFile({ patterns: [{}], questions: [{ key: 'A', figure: { image_file: 'images/A.png' } }, { key: 'B', figure: { image_file: 'images/B.png' } }] }, (n) => n === 'A.png');
    expect(c.file.patterns).toBeUndefined();
    expect((c.file.questions as { figure: unknown }[]).map((q) => q.figure)).toEqual([{ image_file: 'figures/A.png', image_status: 'has_image' }, { image_status: 'needs_image' }]);
    expect(c.images).toEqual(['A.png']);
  });
});

describe('override_requests.csv', () => {
  it('needs a key, a field and a reason; a pair once', async () => {
    const { parseOverrides } = await import('../scripts/lib/updates.ts');
    const r = parseOverrides('file_key,field,reason\nMC36-0101,options,"the standard turn fractions, which the skill is about"\nMC36-0101,options,"twice listed here"\nbad,options,x\nMC10-0008,options,short\n');
    expect(r.rows.map((x) => [x.file_key, x.field])).toEqual([['MC36-0101', 'options']]);
    expect(r.problems.map((p) => p.level)).toEqual(['warning', 'error', 'error']);
  });
});
