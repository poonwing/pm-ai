import fs from 'fs';
import os from 'os';
import path from 'path';

export const OPENCODE_CLI_INSTALL_HINT =
  '未检测到 OpenCode CLI（PATH 中找不到 opencode）。请先安装后再执行任务：curl -fsSL https://opencode.ai/install | bash  或  npm i -g opencode-ai。安装后重开终端并重启 PM-AI。也可在 .env 设置 OPENCODE_BIN 为可执行文件路径。验证：which opencode';

function isExecutableFile(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.F_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Node 安全补丁后，Windows 上不能无 shell 直接 spawn .cmd/.bat（会 EINVAL）。 */
function isWindowsBatchShim(file: string): boolean {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(file);
}

/**
 * npm 全局安装的 opencode 常是 PATH 里的 .cmd 包装脚本；
 * 真实二进制在 node_modules/opencode-ai/bin/opencode.exe。
 */
function resolveRealBinary(candidate: string): string | null {
  if (!isExecutableFile(candidate)) return null;
  if (!isWindowsBatchShim(candidate)) return candidate;

  const nested = path.join(
    path.dirname(candidate),
    'node_modules',
    'opencode-ai',
    'bin',
    'opencode.exe',
  );
  if (isExecutableFile(nested)) return nested;
  return candidate;
}

function candidateNames(): string[] {
  return process.platform === 'win32'
    ? ['opencode.exe', 'opencode.cmd', 'opencode.bat', 'opencode']
    : ['opencode'];
}

function searchDirs(): string[] {
  const home = os.homedir();
  const npmGlobal =
    process.platform === 'win32'
      ? path.join(process.env.APPDATA ?? '', 'npm', 'node_modules', 'opencode-ai', 'bin')
      : '';
  const extras = [
    process.env.OPENCODE_BIN ? path.dirname(process.env.OPENCODE_BIN) : '',
    npmGlobal,
    path.join(home, '.opencode', 'bin'),
    path.join(home, '.local', 'bin'),
    path.join(home, 'go', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
  const pathDirs = (process.env.PATH ?? '').split(path.delimiter);
  return [...extras, ...pathDirs].filter(Boolean);
}

export function getOpenCodeCliPath(): string | null {
  const fromEnv = process.env.OPENCODE_BIN?.trim();
  if (fromEnv) {
    const resolved = resolveRealBinary(fromEnv);
    if (resolved) return resolved;
  }

  const names = candidateNames();
  for (const dir of searchDirs()) {
    for (const name of names) {
      const resolved = resolveRealBinary(path.join(dir, name));
      if (resolved) return resolved;
    }
  }
  return null;
}

export function isOpenCodeCliInstalled(): boolean {
  return getOpenCodeCliPath() !== null;
}

/** Put the CLI directory on PATH so `@opencode-ai/sdk` 的 spawn('opencode') 能找到。 */
export function ensureOpenCodeCliOnPath(): { ok: true; bin: string } | { ok: false; error: string } {
  const bin = getOpenCodeCliPath();
  if (!bin) return { ok: false, error: OPENCODE_CLI_INSTALL_HINT };
  const dir = path.dirname(bin);
  const parts = (process.env.PATH ?? '').split(path.delimiter);
  if (!parts.includes(dir)) {
    process.env.PATH = `${dir}${path.delimiter}${process.env.PATH ?? ''}`;
  }
  return { ok: true, bin };
}
