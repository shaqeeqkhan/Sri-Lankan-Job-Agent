import fs from 'node:fs';
import YAML from 'yaml';
import type { Context } from '../context.ts';
import { SljError } from '../errors.ts';
import { FactSchema, loadFacts, type Fact } from '../user/profile.ts';

function slug(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

/**
 * Appends one confirmed interview fact to user/facts.yml. Refuses unless `confirmed` is true: the
 * person must have said yes to the exact wording first (PRD §5.5 step 2). Comments in the file are kept.
 */
export function addFact(ctx: Pick<Context, 'paths' | 'now'>, input: { text: string; kind: string; id?: string; confirmed: boolean }): { fact: Fact; count: number; path: string } {
  if (input.confirmed !== true) {
    throw new SljError('INVALID_INPUT', 'Not saved. Read the fact back to the person in their words, and pass --confirmed only after they say it is right.');
  }
  const facts = loadFacts(ctx);
  const ids = new Set(facts.map((f) => f.id));
  let id = input.id?.trim() || `${slug(input.kind) || 'fact'}-${slug(input.text.split(/\s+/).slice(0, 5).join(' ')) || 'x'}`;
  id = id.slice(0, 60);
  if (input.id && ids.has(id)) throw new SljError('INVALID_INPUT', `A fact with id "${id}" already exists.`);
  for (let n = 2; ids.has(id); n++) id = `${id.replace(/-\d+$/, '')}-${n}`;
  const fact = FactSchema.parse({
    id,
    text: input.text.trim(),
    kind: input.kind.trim(),
    source: 'interview',
    confirmed: true,
    added_at: ctx.now().toISOString(),
  });

  let doc: YAML.Document;
  try {
    const raw = fs.readFileSync(ctx.paths.factsFile, 'utf8');
    doc = YAML.parseDocument(raw);
    if (doc.contents == null) doc.contents = doc.createNode([]) as never;
  } catch {
    doc = new YAML.Document([]);
    doc.commentBefore = ' Facts confirmed by the person during CV tailoring interviews (slj facts add). CVs may use these and resume.md only.';
  }
  if (!YAML.isSeq(doc.contents)) throw new SljError('INVALID_INPUT', 'user/facts.yml must be a YAML list.');
  doc.contents.items.push(doc.createNode(fact));
  fs.mkdirSync(ctx.paths.userDir, { recursive: true });
  const tmp = `${ctx.paths.factsFile}.tmp`;
  fs.writeFileSync(tmp, doc.toString());
  fs.renameSync(tmp, ctx.paths.factsFile);
  return { fact, count: facts.length + 1, path: ctx.paths.factsFile };
}
