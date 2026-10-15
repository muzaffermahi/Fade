import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DefaultResourceLoader, getAgentDir, ModelRuntime,
} from '@earendil-works/pi-coding-agent';

export async function createRuntime(): Promise<ModelRuntime> {
  return ModelRuntime.create(); // uses ~/.pi/agent auth, shared with the `pi` CLI
}

/** Path to Pi's own CLI (bundled with the SDK), for logins and screens Fade hands off to. */
export function piCliPath(): string | undefined {
  try {
    const entry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
    const candidate = join(dirname(entry), 'bundle', 'cli.js');
    return existsSync(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
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
  return humanError(error instanceof Error ? error.message : String(error));
}

const AUTH_TROUBLE = /oauth refresh failed|invalid_grant|refresh token|unauthori[sz]ed|invalid api key|invalid x-api-key|authentication|\b401\b|no api key/i;

/**
 * Provider errors arrive as long technical dumps (URLs, JSON bodies, stack traces).
 * Turn them into one line a person can act on.
 */
export function humanError(raw: string): string {
  const text = raw.replace(/\s+/g, ' ').trim();
  if (AUTH_TROUBLE.test(text)) {
    const provider = /for ([a-z0-9-]+)[:.]/i.exec(text)?.[1] ?? /provider[ "']+([a-z0-9-]+)/i.exec(text)?.[1];
    const who = provider ? `Your ${provider} login` : 'The model login';
    return `${who} has expired or is missing. Type /login in this pane (or run fade login), then try again.`;
  }
  if (/insufficient (account )?funds|insufficient_quota|\b402\b|credit balance|out of credits/i.test(text)) {
    return 'That provider account is out of credits. Top it up, or switch with /model in this pane.';
  }
  if (/econnrefused|fetch failed|enotfound|network/i.test(text)) {
    return 'Could not reach the model provider. Check your connection (or that your local model server is running).';
  }
  if (/rate.?limit|\b429\b|overloaded|\b529\b/i.test(text)) {
    return 'The model provider is rate-limiting or overloaded right now. Wait a moment, then ready the step again.';
  }
  const first = text.split(/(?<=[.!?])\s|; details=| stack=| at [\w.<>]+ \(/)[0] ?? text;
  return first.length > 200 ? `${first.slice(0, 199)}…` : first;
}

/** If the last assistant message ended in an error (no key, network, rate limit), returns its text. */
export function lastRunError(messages: readonly unknown[]): string | undefined {
  const last = messages[messages.length - 1];
  if (!isRecord(last) || last.role !== 'assistant' || last.stopReason !== 'error') return undefined;
  return typeof last.errorMessage === 'string' && last.errorMessage ? humanError(last.errorMessage) : 'the model request failed';
}
