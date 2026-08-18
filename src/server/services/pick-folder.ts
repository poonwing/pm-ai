import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

export async function pickFolder(initialPath?: string): Promise<string | null> {
  if (process.platform !== 'win32') {
    throw new Error('目前僅支援 Windows 系統選夾對話框，請手動貼上路徑');
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-ai-dialog-'));
  const scriptPath = path.join(dir, 'pick.ps1');
  const initial =
    initialPath && fs.existsSync(initialPath) ? initialPath.replace(/'/g, "''") : '';

  const script = `
$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '選擇 workspace 資料夾'
$dialog.ShowNewFolderButton = $true
${initial ? `$dialog.SelectedPath = '${initial}'` : ''}
$form = New-Object System.Windows.Forms.Form
$form.TopMost = $true
$form.WindowState = 'Minimized'
$form.ShowInTaskbar = $false
$result = $dialog.ShowDialog($form)
$form.Dispose()
if ($result -eq [System.Windows.Forms.DialogResult]::OK -and $dialog.SelectedPath) {
  Write-Output $dialog.SelectedPath
}
`;
  fs.writeFileSync(scriptPath, script, 'utf8');

  try {
    return await runPowerShell(scriptPath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function runPowerShell(scriptPath: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { windowsHide: false },
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
