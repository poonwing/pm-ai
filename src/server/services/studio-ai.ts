import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import YAML from 'yaml';
import { chatCompletion } from '../orchestrator/model.js';
import { getProject } from './tasks.js';
import { ensurePmAiStructure } from './files.js';
import {
  getRequirementsChatPath,
  getDesignsChatPath,
  getDesignsDir,
  getDesignsManifestPath,
} from '../paths.js';
import type { StudioMessage } from '../../shared/schemas.js';
import type { RunnerJob } from '../runner/types.js';

export function extractMarkdown(text: string): string {
  const fence = text.match(/```(?:markdown|md)?\s*\n([\s\S]*?)```/i);
  if (fence?.[1]) return fence[1].trim();
  return text.trim();
}

export function extractHtml(text: string): string {
  const fence = text.match(/```(?:html|html5)?\s*\n([\s\S]*?)```/i);
  if (fence?.[1]) return fence[1].trim();
  const doctype = text.match(/<!DOCTYPE html[\s\S]*/i);
  if (doctype) {
    const closed = doctype[0].match(/[\s\S]*<\/html>/i);
    return (closed ? closed[0] : doctype[0]).trim();
  }
  const html = text.match(/<html[\s\S]*<\/html>/i);
  if (html) return html[0].trim();
  return text.trim();
}

export async function completeStudioChat(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  opts?: { temperature?: number },
): Promise<string> {
  return chatCompletion(messages, {
    temperature: opts?.temperature ?? 0.4,
    timeoutMs: 180_000,
    maxAttempts: 2,
  });
}

type StudioChatKind = 'requirements' | 'design';

function chatPath(workspacePath: string, kind: StudioChatKind): string {
  return kind === 'requirements'
    ? getRequirementsChatPath(workspacePath)
    : getDesignsChatPath(workspacePath);
}

export function readStudioMessages(
  workspacePath: string,
  kind: StudioChatKind,
): StudioMessage[] {
  const filePath = chatPath(workspacePath, kind);
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf-8').trim();
  if (!raw) return [];
  const entries: StudioMessage[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      entries.push(JSON.parse(line) as StudioMessage);
    } catch {
      /* skip */
    }
  }
  return entries;
}

export function appendStudioMessage(
  workspacePath: string,
  kind: StudioChatKind,
  message: Omit<StudioMessage, 'id' | 'at'> & { id?: string; at?: string },
): StudioMessage {
  ensurePmAiStructure(workspacePath);
  const entry: StudioMessage = {
    id: message.id ?? uuidv4(),
    role: message.role,
    content: message.content,
    engine: message.engine,
    at: message.at ?? new Date().toISOString(),
  };
  const filePath = chatPath(workspacePath, kind);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf-8');
  return entry;
}

export function recordStudioOutcome(job: RunnerJob): void {
  if (job.kind !== 'studio' || !job.studioKind) return;
  const project = getProject(job.projectId);
  const workspacePath = project.workspacePath;
  ensurePmAiStructure(workspacePath);

  if (job.status === 'completed') {
    const summary = (job.resultSummary ?? '外部 AI 已完成').slice(0, 4000);
    appendStudioMessage(workspacePath, job.studioKind, {
      role: 'assistant',
      engine: 'external',
      content: summary,
    });
    if (job.studioKind === 'design') {
      reconcileDesignsFromDisk(workspacePath);
    }
  } else if (job.status === 'failed') {
    appendStudioMessage(workspacePath, job.studioKind, {
      role: 'system',
      engine: 'external',
      content: `外部 AI 失敗：${job.error ?? '未知錯誤'}`,
    });
  }
}

export interface DesignManifestItem {
  id: string;
  title: string;
  slug: string;
  updatedAt: string;
}

interface DesignManifest {
  designs: DesignManifestItem[];
}

export function readDesignManifest(workspacePath: string): DesignManifestItem[] {
  const filePath = getDesignsManifestPath(workspacePath);
  if (!fs.existsSync(filePath)) return [];
  try {
    const parsed = YAML.parse(fs.readFileSync(filePath, 'utf-8')) as DesignManifest | DesignManifestItem[];
    if (Array.isArray(parsed)) return parsed;
    return Array.isArray(parsed?.designs) ? parsed.designs : [];
  } catch {
    return [];
  }
}

export function writeDesignManifest(workspacePath: string, designs: DesignManifestItem[]): void {
  ensurePmAiStructure(workspacePath);
  fs.mkdirSync(getDesignsDir(workspacePath), { recursive: true });
  fs.writeFileSync(
    getDesignsManifestPath(workspacePath),
    YAML.stringify({ designs }),
    'utf-8',
  );
}

/** Pick up HTML files written by external Runner that are not yet in the manifest. */
export function reconcileDesignsFromDisk(workspacePath: string): DesignManifestItem[] {
  const dir = getDesignsDir(workspacePath);
  fs.mkdirSync(dir, { recursive: true });
  const existing = readDesignManifest(workspacePath);
  const bySlug = new Map(existing.map((d) => [d.slug, d]));
  let changed = false;

  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return existing;
  }

  for (const name of entries) {
    if (!name.endsWith('.html')) continue;
    const slug = name.slice(0, -5);
    if (bySlug.has(slug)) continue;
    const stat = fs.statSync(path.join(dir, name));
    const item: DesignManifestItem = {
      id: uuidv4(),
      title: slug,
      slug,
      updatedAt: stat.mtime.toISOString(),
    };
    existing.push(item);
    bySlug.set(slug, item);
    changed = true;
  }

  if (changed) writeDesignManifest(workspacePath, existing);
  return existing;
}
