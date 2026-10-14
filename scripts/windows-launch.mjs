import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const endpoint = 'https://opencode.ai/inference/go/v1';
export const freeModels = ['longcat-2.5-preview-free'];

/** Credentials remain in memory; neither profile nor diagnostics contain the key. */
export function readKey(env = process.env, home = homedir()) {
  if (env.OPENCODE_API_KEY) return env.OPENCODE_API_KEY;
  try {
    const auth = JSON.parse(readFileSync(join(home, '.local', 'share', 'opencode', 'auth.json'), 'utf8'));
    const key = auth?.['opencode-go']?.key;
    return typeof key === 'string' && key.trim() ? key : undefined;
  } catch { return undefined; }
}

export function profile(model) {
  if (!freeModels.includes(model)) throw new Error('Only explicitly selected free models are allowed.');
  return {
    models: { providers: { 'opencode-go': { api: 'openai-completions', baseUrl: endpoint,
      models: freeModels.map(id => ({ id, name: id, reasoning: false, input: ['text'], contextWindow: 32768,
        maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })) } } },
    settings: { packages: [], defaultProvider: 'opencode-go', defaultModel: model, defaultThinkingLevel: 'off',
      retry: { enabled: false }, compaction: { enabled: true, reserveTokens: 2048, keepRecentTokens: 1024 } }
  };
}

export async function selectFreeModel(key, request = fetch) {
  for (const model of freeModels) {
    try {
      const response = await request(`${endpoint}/chat/completions`, {
        method: 'POST', signal: AbortSignal.timeout(20000),
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'x-opencode-session': randomUUID() },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply OK.' }], max_tokens: 64, stream: false })
      });
      if (response.ok) {
        const body = await response.json();
        if (body?.choices?.some(choice => typeof choice?.message?.content === 'string' && choice.message.content.trim())) return model;
      }
      console.log(`${model}: unavailable.`);
    } catch { console.log(`${model}: connection unavailable.`); }
  }
  throw new Error('LongCat is unavailable. No user task was sent. Try this launcher later; no model substitution was made.');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Windows Fade launcher: node scripts/windows-launch.mjs [--check] [--workspace PATH]\nUses existing OpenCode credentials and an available free model. No credentials are saved.');
    return;
  }
  const key = readKey();
  if (!key) throw new Error('Existing OpenCode Go credentials were not found.');
  if (!existsSync(join(root, 'dist', 'cli.js'))) throw new Error('Build missing: run node node_modules/typescript/bin/tsc -p tsconfig.json in Fade.');
  console.log('Checking free LongCat availability (up to twenty seconds)…');
  try { await selectFreeModel(key); }
  catch { console.log('LongCat did not pass the availability probe. Opening with your selected LongCat model; provider errors will remain visible.'); }
  const config = profile('longcat-2.5-preview-free');
  const agentDir = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Fade', 'windows-profile');
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify(config.models, null, 2));
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify(config.settings, null, 2));
  const selector = `${config.settings.defaultProvider}/${config.settings.defaultModel}`;
  const builderSelector = selector;
  console.log(`Ready: Companion ${selector}; Builder ${builderSelector}. Private Windows candidate; Builder checks may still need explicit correction.`);
  if (args.includes('--check')) return;
  const position = args.indexOf('--workspace');
  if (position >= 0 && (!args[position + 1] || args[position + 1].startsWith('--'))) throw new Error('--workspace requires a directory.');
  const workspace = resolve(position >= 0 ? args[position + 1] : join(homedir(), 'Documents', 'Fade Workspace'));
  mkdirSync(workspace, { recursive: true });
  const child = spawn(process.execPath, [join(root, 'dist', 'cli.js'), '--workspace', workspace,
    '--builder', builderSelector, '--companion', selector], {
    cwd: workspace, stdio: 'inherit', env: { ...process.env, ...(key ? { OPENCODE_API_KEY: key } : {}),
      PI_CODING_AGENT_DIR: agentDir, PI_SKIP_VERSION_CHECK: '1' }
  });
  await new Promise((done, reject) => { child.once('error', reject); child.once('exit', code => { process.exitCode = code ?? 1; done(); }); });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`Fade launcher: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
}
