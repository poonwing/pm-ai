import { spawn } from 'child_process';
import fs from 'fs';

export async function pickFolder(initialPath?: string): Promise<string | null> {
  const initial = initialPath && fs.existsSync(initialPath) ? initialPath : undefined;

  switch (process.platform) {
    case 'win32':
      return pickFolderWindows(initial);
    case 'darwin':
      return pickFolderMac(initial);
    case 'linux':
      return pickFolderLinux(initial);
    default:
      throw new Error('目前不支援此系統的選夾對話框，請手動貼上路徑');
  }
}

function pickFolderWindows(initialPath?: string): Promise<string | null> {
  const initial = initialPath ? initialPath.replace(/'/g, "''") : '';

  // Windows PowerShell 5.1 reads -File as the system ANSI code page (Big5 on zh-TW).
  // UTF-8 scripts then break string quotes. -EncodedCommand is always UTF-16LE.
  const script = [
    '$OutputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false',
    'Add-Type -AssemblyName System.Windows.Forms',
    '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
    "$dialog.Description = 'Select workspace folder'",
    '$dialog.ShowNewFolderButton = $true',
    initial ? `$dialog.SelectedPath = '${initial}'` : '',
    '$form = New-Object System.Windows.Forms.Form',
    '$form.TopMost = $true',
    "$form.WindowState = 'Minimized'",
    '$form.ShowInTaskbar = $false',
    '$result = $dialog.ShowDialog($form)',
    '$form.Dispose()',
    'if ($result -eq [System.Windows.Forms.DialogResult]::OK -and $dialog.SelectedPath) {',
    '  [Console]::WriteLine($dialog.SelectedPath)',
    '}',
  ]
    .filter((line) => line.length > 0)
    .join('\r\n');

  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return runCommand(
    'powershell.exe',
    ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { windowsHide: true },
  );
}

function pickFolderMac(initialPath?: string): Promise<string | null> {
  const prompt = 'Select workspace folder';
  const defaultLocation = initialPath
    ? ` default location POSIX file "${escapeAppleScriptString(initialPath)}"`
    : '';
  const script = [
    'try',
    '  activate',
    `  POSIX path of (choose folder with prompt "${prompt}"${defaultLocation})`,
    'on error number -128',
    '  return ""',
    'end try',
  ].join('\n');

  return runCommand('osascript', ['-l', 'AppleScript'], {
    input: script,
    isCancel: (code, stderr) => code === 1 && /(-128|User canceled)/i.test(stderr),
  });
}

async function pickFolderLinux(initialPath?: string): Promise<string | null> {
  const initial = initialPath ?? '';
  if (await commandExists('zenity')) {
    return runCommand('zenity', [
      '--file-selection',
      '--directory',
      '--title=Select workspace folder',
      ...(initial ? [`--filename=${initial}/`] : []),
    ], { cancelCodes: [1] });
  }
  if (await commandExists('kdialog')) {
    return runCommand(
      'kdialog',
      ['--getexistingdirectory', initial || '.', 'Select workspace folder'],
      { cancelCodes: [1] },
    );
  }
  throw new Error('目前僅支援 zenity 或 kdialog 系統選夾對話框，請手動貼上路徑');
}

function escapeAppleScriptString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function commandExists(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('which', [command]);
    child.on('close', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

function normalizePickedPath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (process.platform === 'win32') return trimmed;
  if (trimmed === '/') return '/';
  return trimmed.replace(/\/+$/, '');
}

function runCommand(
  command: string,
  args: string[],
  options: {
    windowsHide?: boolean;
    input?: string;
    cancelCodes?: number[];
    isCancel?: (code: number | null, stderr: string) => boolean;
  } = {},
): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: options.windowsHide });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    if (options.input !== undefined) {
      child.stdin.write(options.input);
      child.stdin.end();
    }
    child.on('error', reject);
    child.on('close', (code) => {
      const selected = normalizePickedPath(stdout);
      if (selected) {
        resolve(selected);
        return;
      }
      if (
        code === 0 ||
        options.cancelCodes?.includes(code ?? -1) ||
        options.isCancel?.(code, stderr)
      ) {
        resolve(null);
        return;
      }
      reject(new Error(stderr.trim() || '選夾對話框失敗'));
    });
  });
}
