import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** `.fade/config.json`: per-project model choices. Written when you switch models with /model. */
export interface Config {
  builder?: string;
  companion?: string;
}

function configPath(cwd: string): string {
  return join(cwd, '.fade', 'config.json');
}

export function readConfig(cwd: string): Config {
  try {
    const raw: unknown = JSON.parse(readFileSync(configPath(cwd), 'utf8'));
    if (typeof raw !== 'object' || raw === null) return {};
    const config: Config = {};
    if ('builder' in raw && typeof raw.builder === 'string') config.builder = raw.builder;
    if ('companion' in raw && typeof raw.companion === 'string') config.companion = raw.companion;
    return config;
  } catch {
    return {};
  }
}

/** Remembers a model choice for one role. Failing to save is not worth bothering anyone about. */
export function saveModelChoice(cwd: string, role: 'builder' | 'companion', selector: string): void {
  try {
    const config = { ...readConfig(cwd), [role]: selector };
    mkdirSync(join(cwd, '.fade'), { recursive: true });
    const tmp = `${configPath(cwd)}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
    renameSync(tmp, configPath(cwd));
  } catch {
    // The switch still worked for this run.
  }
}
