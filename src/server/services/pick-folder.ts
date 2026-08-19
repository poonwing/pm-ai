import { spawn } from 'child_process';
import fs from 'fs';

export async function pickFolder(initialPath?: string): Promise<string | null> {
  if (process.platform !== 'win32') {
    throw new Error('目前僅支援 Windows 系統選夾對話框，請手動貼上路徑');
  }

  const initial =
    initialPath && fs.existsSync(initialPath) ? initialPath.replace(/'/g, "''") : '';

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
  return runPowerShellEncoded(encoded);
}

function runPowerShellEncoded(encoded: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true },
    );

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
    child.on('error', reject);
    child.on('close', (code) => {
      const selected = stdout.trim();
      if (selected) {
        resolve(selected);
        return;
      }
      if (code === 0) {
        resolve(null);
        return;
      }
      reject(new Error(stderr.trim() || '選夾對話框失敗'));
    });
  });
}
