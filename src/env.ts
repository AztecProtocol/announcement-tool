import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Minimal .env loader: KEY=VALUE lines, # comments, optional surrounding quotes.
 * Values already present in process.env always win, so shell exports and real
 * deployment environments override the file. Dependency-free and runner-agnostic
 * (tsx, node, compiled) — called explicitly by each entry point (worker, scripts).
 */
export function loadEnv(dir = process.cwd()): void {
  let text: string;
  try {
    text = readFileSync(join(dir, '.env'), 'utf8');
  } catch {
    return; // no .env file — nothing to do
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
