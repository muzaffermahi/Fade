import { isAbsolute, relative } from 'node:path';
import {
  DefaultResourceLoader, getAgentDir, ModelRuntime,
} from '@earendil-works/pi-coding-agent';

export async function createRuntime(): Promise<ModelRuntime> {
  return ModelRuntime.create(); // uses ~/.pi/agent auth, shared with the `pi` CLI
}

export function resolveModel(runtime: ModelRuntime, selector?: string) {
  if (!selector) return undefined; // Pi falls back to its default model
  const slash = selector.indexOf('/');
  const model = slash > 0 ? runtime.getModel(selector.slice(0, slash), selector.slice(slash + 1)) : undefined;
  if (!model) throw new Error(`Unknown model "${selector}". Use provider/model-id.`);
  return model;
}

export async function loader(cwd: string, rolePrompt: string): Promise<DefaultResourceLoader> {
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    appendSystemPromptOverride: base => [...base, rolePrompt],
  });
  await resourceLoader.reload();
  return resourceLoader;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Joins the text blocks of a finished assistant message; undefined for any other message. */
export function assistantText(message: unknown): string | undefined {
  if (!isRecord(message) || message.role !== 'assistant' || !Array.isArray(message.content)) return undefined;
  const parts: string[] = [];
  for (const block of message.content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('');
}

/** The text delta of a streaming update event, if it is one. */
export function textDelta(assistantMessageEvent: unknown): string | undefined {
  if (!isRecord(assistantMessageEvent) || assistantMessageEvent.type !== 'text_delta') return undefined;
  return typeof assistantMessageEvent.delta === 'string' ? assistantMessageEvent.delta : undefined;
}

export function stringArg(args: unknown, key: string): string | undefined {
  if (!isRecord(args)) return undefined;
  const value = args[key];
  return typeof value === 'string' ? value : undefined;
}

export function shortPath(cwd: string, path: string | undefined): string {
  if (!path) return 'a file';
  if (!isAbsolute(path)) return path;
  const rel = relative(cwd, path);
  return rel && !rel.startsWith('..') ? rel : path;
}

export function describeTool(cwd: string, toolName: string, args: unknown): string {
  const path = shortPath(cwd, stringArg(args, 'path') ?? stringArg(args, 'file_path'));
  if (toolName === 'read') return `reading ${path}`;
  if (toolName === 'edit' || toolName === 'write') return `editing ${path}`;
  if (toolName === 'bash') return `running ${(stringArg(args, 'command') ?? '').slice(0, 40)}`;
  if (toolName === 'grep' || toolName === 'find' || toolName === 'ls') return 'searching';
  return toolName;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** If the last assistant message ended in an error (no key, network, rate limit), returns its text. */
export function lastRunError(messages: readonly unknown[]): string | undefined {
  const last = messages[messages.length - 1];
  if (!isRecord(last) || last.role !== 'assistant' || last.stopReason !== 'error') return undefined;
  return typeof last.errorMessage === 'string' && last.errorMessage ? last.errorMessage : 'the model request failed';
}
