import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Config } from '../config.ts';
import { SljError } from '../errors.ts';
import type { SourceAdapter, SourceConfig } from './types.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Loads `src/sources/<id>/index.ts` and checks its default export is a SourceAdapter. No central list. */
export async function loadAdapter(id: string): Promise<SourceAdapter> {
  if (!/^[a-z0-9_]+$/.test(id)) throw new SljError('INVALID_INPUT', `Not a valid source id: "${id}".`);
  const file = path.join(HERE, id, 'index.ts');
  if (!fs.existsSync(file)) {
    throw new SljError('NOT_FOUND', `No adapter for source "${id}": expected src/sources/${id}/index.ts.`, { id, file });
  }
  const mod = (await import(pathToFileURL(file).href)) as { default?: Partial<SourceAdapter> };
  const a = mod.default;
  if (!a || typeof a.id !== 'string' || typeof a.scan !== 'function' || typeof a.recheck !== 'function') {
    throw new SljError('INTERNAL', `src/sources/${id}/index.ts must default-export { id, scan, recheck }.`, { id });
  }
  if (a.id !== id) throw new SljError('INTERNAL', `src/sources/${id}/index.ts exports id "${a.id}", expected "${id}".`, { id });
  return a as SourceAdapter;
}

/** The scanned sources from config/sources.yml as SourceConfig, in precedence order (enabled or not). */
export function sourceConfigs(config: Config): SourceConfig[] {
  return config.sources.sources.map((s) => ({
    id: s.id,
    name: s.name,
    kind: s.kind,
    hosts: [...s.hosts],
    enabled: s.enabled,
    slow: s.slow,
    tiers: [...s.tiers],
    max_details: s.max_details,
    delay_ms: s.delay_ms,
    options: { ...s.options },
  }));
}
