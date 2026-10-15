// Integration check of the actual Pi sessions and network tools; no model call is made.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSession, SessionManager } from '@earendil-works/pi-coding-agent';
import { BUILDER_TOOLS } from '../src/agents/builder.js';
import { COMPANION_TOOLS } from '../src/agents/companion.js';
import { createRuntime, loader } from '../src/agents/pi.js';
import { checkTool } from '../src/agents/checks.js';

const cwd = mkdtempSync(join(tmpdir(), 'fade-capabilities-'));
const runtime = await createRuntime();
for (const role of ['builder', 'companion'] as const) {
  const { session } = await createAgentSession({
    cwd, modelRuntime: runtime, sessionManager: SessionManager.inMemory(cwd),
    tools: role === 'builder' ? BUILDER_TOOLS : COMPANION_TOOLS,
    ...(role === 'companion' ? { excludeTools: ['mcp__*', 'codemode', 'tool_search'] } : {}),
    customTools: role === 'builder' ? [checkTool(cwd)] : [],
    resourceLoader: await loader(cwd, 'Use tools for the requested check.', role === 'builder'),
  });
  try {
    await session.bindExtensions({});
    const activate = session.agent.state.tools.find(tool => tool.name === 'web_enable');
    if (activate) await activate.execute('enable-web', {}, AbortSignal.timeout(60000));
    const tools = session.getActiveToolNames();
    console.log(`${role}: ${tools.join(', ')}`);
    for (const name of ['web_search', 'fetch_content', 'get_search_content']) assert.ok(tools.includes(name), name);
    if (role === 'companion') {
      assert.ok(!tools.some(name => ['bash', 'write', 'edit', 'codemode', 'tool_search'].includes(name) || name.startsWith('mcp__')));
    } else {
      assert.ok(tools.includes('fade_check'));
      assert.ok(tools.includes('tool_search'));
      const fetch = session.agent.state.tools.find(tool => tool.name === 'fetch_content');
      assert.ok(fetch);
      const fetched = await fetch.execute('fetch-docs', { url: 'https://docs.python.org/3/library/unittest.html' }, AbortSignal.timeout(60000));
      const text = fetched.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
      assert.match(text, /TestCase/);
      assert.doesNotMatch(text, /Error fetching|Fetch failed|No content/i);
      console.log(`fetch: ${text.slice(0, 300)}`);
      const search = session.agent.state.tools.find(tool => tool.name === 'web_search');
      assert.ok(search);
      const found = await search.execute('search-docs', { query: 'site:docs.python.org unittest discover', numResults: 3, workflow: 'none' }, AbortSignal.timeout(60000));
      const results = found.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
      console.log(`search: ${results.slice(0, 1200)}`);
      assert.match(results, /https?:\/\/[^\s]*python\.org/);
    }
  } finally { session.dispose(); }
}
console.log('PASS: web search/fetch, Builder diagnostics and read-only Companion tool boundary.');
