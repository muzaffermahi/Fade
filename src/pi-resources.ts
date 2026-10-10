import type { InlineExtension } from '@earendil-works/pi-coding-agent';

/** Load the pinned Pi CLI's complete built-in extension set, including MCP and tool search. */
export async function piBuiltins(): Promise<InlineExtension[]> {
  const entry = import.meta.resolve('@earendil-works/pi-coding-agent');
  const module: unknown = await import(new URL('./extensions/index.js', entry).href);
  if (!module || typeof module !== 'object' || !('builtInExtensions' in module) || !Array.isArray(module.builtInExtensions)) {
    throw new Error('The installed Pi SDK does not expose its CLI built-ins.');
  }
  return module.builtInExtensions.map((item: unknown): InlineExtension => {
    if (!item || typeof item !== 'object' || !('name' in item) || typeof item.name !== 'string'
      || !('factory' in item) || typeof item.factory !== 'function') throw new Error('Invalid Pi built-in extension.');
    const factory = item.factory;
    return { name: item.name, builtin: true, replaceable: 'replaceable' in item && item.replaceable === true,
      factory: async pi => { await factory(pi); } };
  });
}
