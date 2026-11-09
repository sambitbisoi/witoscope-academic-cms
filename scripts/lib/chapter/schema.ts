// JSON Schema validation of a chapter file, with errors in plain words, per question key.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020, { type ErrorObject } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { Problem } from '../../../shared/types.ts';

const schema = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'schema', 'chapter.schema.json'), 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: false });
(addFormats as unknown as (a: Ajv2020) => void)(ajv);
const validate = ajv.compile(schema);

function plain(e: ErrorObject): string {
  const at = e.instancePath.replace(/^\/questions\/\d+/, '').replace(/\//g, '.').replace(/^\./, '') || 'the file';
  switch (e.keyword) {
    case 'required': return `${at === 'the file' ? '' : at + ': '}missing "${(e.params as { missingProperty: string }).missingProperty}"`;
    case 'additionalProperties': return `${at === 'the file' ? '' : at + ': '}unknown field "${(e.params as { additionalProperty: string }).additionalProperty}"`;
    case 'enum': return `${at} must be one of: ${(e.params as { allowedValues: unknown[] }).allowedValues.join(', ')}`;
    case 'const': return `${at} must be ${JSON.stringify((e.params as { allowedValue: unknown }).allowedValue)}`;
    case 'pattern': return `${at} has the wrong form (expected ${(e.params as { pattern: string }).pattern})`;
    default: return `${at} ${e.message}`;
  }
}

/** Returns schema problems; each is attached to the question key when it is inside a question. */
export function schemaProblems(data: unknown): Problem[] {
  if (validate(data)) return [];
  const questions = (data as { questions?: { key?: string }[] })?.questions ?? [];
  const seen = new Set<string>();
  const out: Problem[] = [];
  for (const e of validate.errors ?? []) {
    if (e.keyword === 'if') continue; // the failing "then" branch is reported separately
    const m = /^\/questions\/(\d+)/.exec(e.instancePath);
    const key = m ? (questions[Number(m[1])]?.key ?? `question #${Number(m[1]) + 1}`) : 'file';
    const message = plain(e);
    const id = `${key}|${message}`;
    if (!seen.has(id)) { seen.add(id); out.push({ level: 'error', key, message }); }
  }
  return out;
}
