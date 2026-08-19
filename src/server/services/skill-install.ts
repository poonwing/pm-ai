import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export const PM_AI_SKILL_NAME = 'pm-ai-agent';

export interface SkillInstallResult {
  installed: boolean;
  skillPath: string | null;
  updated: boolean;
  error?: string;
}

function getBundledSkillSourcePath(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(process.cwd(), 'skill', 'SKILL.md'),
    path.join(here, '..', '..', '..', 'skill', 'SKILL.md'),
    path.join(here, '..', '..', 'skill', 'SKILL.md'),
  ];

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (fs.existsSync(resolved)) return resolved;
  }
  return null;
}

export function getWorkspaceSkillPath(workspacePath: string): string {
  return path.join(workspacePath, '.cursor', 'skills', PM_AI_SKILL_NAME, 'SKILL.md');
}

export function installPmAiSkill(workspacePath: string): SkillInstallResult {
  const skillPath = getWorkspaceSkillPath(workspacePath);
  const sourcePath = getBundledSkillSourcePath();

  if (!sourcePath) {
    return {
      installed: false,
      skillPath: null,
      updated: false,
      error: '找不到 PM-AI 內建 skill 範本',
    };
  }

  try {
    const source = fs.readFileSync(sourcePath, 'utf-8');
    const existed = fs.existsSync(skillPath);
    const previous = existed ? fs.readFileSync(skillPath, 'utf-8') : null;
    const changed = previous !== source;

    if (!changed) {
      return { installed: true, skillPath, updated: false };
    }

    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.writeFileSync(skillPath, source, 'utf-8');

    return { installed: true, skillPath, updated: existed || !previous };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      installed: false,
      skillPath: null,
      updated: false,
      error: message,
    };
  }
}
