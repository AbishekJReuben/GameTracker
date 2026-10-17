// Build a durable clause-level evidence ledger without changing the approved plan.
// Existing evidence survives a rebuild; new or altered clauses start incomplete.
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

const root = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(root, '..', 'ImplementationPlan.md'), 'utf8');
const path = join(root, 'requirements.json');
const previous = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { requirements: [] };
const byText = new Map(previous.requirements.map(item => [item.id + ':' + item.text, item]));
const requirements = [];
let section = 0, clause = 0;
for (const [i, line] of source.split(/\r?\n/).entries()) {
  const heading = line.match(/^(\d+)\. \*\*(.+)\*\*/);
  if (heading) { section = Number(heading[1]); clause = 0; }
  if (!heading && !/^\s+(?:- |\|[^-]|\*\*Gate:)/.test(line)) continue;
  if (!section || /^\s*\|(?:---| Area | Concept | Layer | Transition | Group | Display | Stage | Condition | Event |\s*$)/.test(line)) continue;
  const id = heading ? String(section) : `${section}.${++clause}`;
  const text = line.trim();
  requirements.push(byText.get(id + ':' + text) ?? { id, planLine: i + 1, text, status: 'incomplete', evidence: [], notes: '' });
}
const result = { schemaVersion: 1, planSha256: createHash('sha256').update(source).digest('hex'), statuses: ['incomplete','proven','failed','unavailable','awaiting-physical-validation'], requirements };
writeFileSync(path + '.tmp', JSON.stringify(result, null, 2) + '\n');
renameSync(path + '.tmp', path);
console.log(`${requirements.length} specification clauses retained in requirements.json`);
