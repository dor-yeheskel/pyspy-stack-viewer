import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync, execFile, spawnSync } from 'child_process';

/* ---------- 1. Python interpreter ---------- */

const CANDIDATES = ['python3', 'python', 'py -3'];

async function findPythonCLI(): Promise<string> {
  for (const cmd of CANDIDATES) {
    try {
      const parts = cmd.split(' ');
      const out = execFileSync(parts[0], [...parts.slice(1), '-c', 'import sys; print(sys.version_info[0])'], { stdio: 'pipe' })
        .toString().trim();
      if (out === '3') return cmd;
    } catch { /* ignore */ }
  }
  throw new Error('Python 3 interpreter not found in PATH.');
}

export async function getPythonInterpreterPath(): Promise<string> {
  const ext = vscode.extensions.getExtension('ms-python.python');
  if (ext) {
    await ext.activate();
    const api: any = ext.exports;
    if (api?.environments) {
      let active = api.environments.getActiveEnvironmentPath();
      if (active?.path && fs.existsSync(active.path)) return active.path;
      await vscode.commands.executeCommand('python.selectInterpreter');
      active = api.environments.getActiveEnvironmentPath();
      if (active?.path && fs.existsSync(active.path)) return active.path;
    }
  }
  return findPythonCLI();
}

/* ---------- 2. Ensure py-spy ---------- */

const PYSPY_VERSION = '0.4.0';

function locateLocalPySpy(dir: string): string | undefined {
  const names =
    process.platform === 'win32'
      ? ['py-spy.exe', path.join('Scripts', 'py-spy.exe')]
      : ['py-spy', path.join('bin', 'py-spy')];
  for (const n of names) {
    const p = path.join(dir, n);
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

export async function ensurePySpy(storageDir: string): Promise<string> {
  if (spawnSync('py-spy', ['--version']).status === 0) return 'py-spy';

  const existing = locateLocalPySpy(storageDir);
  if (existing) return existing;

  const python = await getPythonInterpreterPath();

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Installing py-spy ${PYSPY_VERSION}…` },
    () => new Promise<void>((res, rej) => {
      const parts = python.split(' ');
      execFile(parts[0],
        [...parts.slice(1), '-m', 'pip', 'install', '--no-deps',
         '--no-warn-script-location', '-t', storageDir, `py-spy==${PYSPY_VERSION}`],
        e => e ? rej(e) : res());
    })
  );

  const local = locateLocalPySpy(storageDir);
  if (!local) throw new Error('py-spy installed but binary not found');
  if (process.platform !== 'win32') fs.chmodSync(local, 0o755);
  return local;
}

/* ---------- 3. Run py-spy dump ---------- */

export function runPySpyDump(pySpyPath: string, pid: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      pySpyPath,
      ['dump', '--pid', pid, '--full-filenames'],
      { env: { PYSPY_ALLOW_LOWER_PERMS: '1' } },
      (err, stdout, stderr) =>
        err ? reject(stderr || err.message) : resolve(stdout)
    );
  });
}

/* ---------- 4. Open file helper ---------- */

type FileLike = { file?: string; path?: string; line?: number };

export async function openFileAtLine(
  f: FileLike,
  col: vscode.ViewColumn = vscode.ViewColumn.One
) {
  const p = f.path ?? f.file;
  if (!p) throw new Error('Invalid frame object');

  const doc = await vscode.workspace.openTextDocument(p);
  const ed  = await vscode.window.showTextDocument(doc, { viewColumn: col });

  if (f.line) {
    const pos = new vscode.Position(f.line - 1, 0);
    ed.selection = new vscode.Selection(pos, pos);
    ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  }
}
