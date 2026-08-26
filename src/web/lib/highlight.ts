import type { BundledLanguage } from 'shiki';
import { codeToHtml } from 'shiki';

type HighlightLang = BundledLanguage | 'text';

const EXT_TO_LANG: Record<string, HighlightLang> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'jsonc',
  md: 'markdown',
  mdx: 'mdx',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  xml: 'xml',
  svg: 'xml',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  rb: 'ruby',
  php: 'php',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  ps1: 'powershell',
  psm1: 'powershell',
  sql: 'sql',
  graphql: 'graphql',
  gql: 'graphql',
  dockerfile: 'dockerfile',
  env: 'dotenv',
  txt: 'text',
  log: 'text',
  conf: 'ini',
  ini: 'ini',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  swift: 'swift',
  vue: 'vue',
  svelte: 'svelte',
  prisma: 'prisma',
};

const SPECIAL_NAMES: Record<string, HighlightLang> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  gemfile: 'ruby',
  rakefile: 'ruby',
  'cmakelists.txt': 'cmake',
  '.gitignore': 'text',
  '.dockerignore': 'text',
  '.env': 'dotenv',
  '.env.local': 'dotenv',
  '.env.example': 'dotenv',
};

export function languageFromPath(filePath: string): HighlightLang {
  const base = filePath.split(/[/\\]/).pop() ?? filePath;
  const lower = base.toLowerCase();

  if (SPECIAL_NAMES[lower]) return SPECIAL_NAMES[lower];

  const dot = lower.lastIndexOf('.');
  if (dot <= 0) return 'text';
  const ext = lower.slice(dot + 1);
  return EXT_TO_LANG[ext] ?? 'text';
}

export async function highlightCode(code: string, filePath: string): Promise<string> {
  const lang = languageFromPath(filePath);
  try {
    return await codeToHtml(code, {
      lang,
      theme: 'github-light',
      transformers: [
        {
          line(node, line) {
            node.properties['data-line'] = String(line);
          },
        },
      ],
    });
  } catch {
    return await codeToHtml(code, {
      lang: 'text',
      theme: 'github-light',
      transformers: [
        {
          line(node, line) {
            node.properties['data-line'] = String(line);
          },
        },
      ],
    });
  }
}
