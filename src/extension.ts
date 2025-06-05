import * as vscode from 'vscode';
import { ensurePySpy, runPySpyDump, openFileAtLine } from './utils';
import { StackProvider, Frame } from './stackProvider';
import * as fs from 'fs';
import { exec } from 'child_process';

const log = vscode.window.createOutputChannel('PySpy Stack Log');

export async function activate(context: vscode.ExtensionContext) {
  log.appendLine('--- PySpy Stack Viewer activate() ---');
  log.appendLine(`globalStorage: ${context.globalStorageUri.fsPath}`);

  let pySpy: string;
  try {
    pySpy = await ensurePySpy(context.globalStorageUri.fsPath);
    log.appendLine(`py-spy path: ${pySpy}`);
  } catch (e: any) {
    vscode.window.showErrorMessage(`PySpy Viewer: ${e.message}`);
    log.appendLine(`ensurePySpy failed: ${e}`);
    return;
  }

  const provider = new StackProvider();
  vscode.window.registerTreeDataProvider('pyspy.view', provider);

  const tree = vscode.window.createTreeView('pyspy.view', {
    treeDataProvider: provider
  });


  let currentPid: string | undefined;

  /* -------------------- pick process -------------------- */
  async function pickProcess(): Promise<{pid:string, cmd:string}|undefined> {
    /** choose shell command per platform ------------------------------------- */
    let cmd: string;
    let mode: 'wmic' | 'tasklist' | 'ps';

    if (process.platform === 'win32') {
      /* prefer WMIC (may be missing on Win 11) */
      try { exec('wmic.exe -?'); mode = 'wmic'; }
      catch { mode = 'tasklist'; }

      cmd = mode === 'wmic'
        ? 'wmic process get ProcessId,CommandLine /FORMAT:CSV'
        : 'tasklist /v /fo csv';
    } else {
      mode = 'ps';
      cmd  = 'ps -eo pid,args';
    }

    /** run command and build QuickPick list ---------------------------------- */
    return new Promise(resolve => {
      exec(cmd, (_, stdout) => {
        const items: vscode.QuickPickItem[] = [];
        const pidToCmd = new Map<string, string>();

        stdout.split(/\r?\n/).forEach(line => {
          let pid: string | undefined, cmdLine: string | undefined;

          /* -------- Windows: WMIC CSV -------- */
          if (mode === 'wmic') {
            // CSV row:  Node,PID,"cmd line"  *or*  Node,cmd line,PID
            const parts = line.split(',');
            if (parts.length >= 3) {
              pid = parts.pop()!.trim();       // last part = PID
              parts.shift();                   // drop Node
              cmdLine = parts.join(',').replace(/^"|"$/g, '').trim();
            }
          }

          /* -------- Windows: tasklist CSV -------- */
          else if (mode === 'tasklist') {
            // First columns: "Image","PID",...,"Command Line"
            const parts = line.split('","').map(s => s.replace(/^"|"$/g, ''));
            if (parts.length > 8) {
              pid     = parts[1];
              cmdLine = parts[8];
            }
          }

          /* -------- Linux / macOS: ps -------- */
          else { // ps
            const m = line.match(/^\s*(\d+)\s+(.*)$/);
            if (m) { pid = m[1]; cmdLine = m[2]; }
          }

          /* -------- Linux UID filter -------- */
          if (process.platform === 'linux' && pid) {
            try {
              const s = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
              const m = s.match(/^Uid:\s+(\d+)/m);
              if (
                m &&
                typeof process.getuid === 'function' &&
                Number(m[1]) !== process.getuid()
               ) {
                pid = undefined;
              }
            } catch {
              pid = undefined;
            }
          }
          
          /* keep only python-ish processes ----------------------------------- */
          const PY_RE =
            /(?:^|[\\/\s"])(python(?:3|w)?(?:\.exe)?|py(?:\.exe)?)(?=$|[\\/\s"])/i;

          if (pid && cmdLine && PY_RE.test(cmdLine)) {
            cmdLine = cmdLine.replace(/"/g, '').trim();
            const parts = cmdLine.split(/\s+/);
            const exe   = parts[0];
            let show = exe;                            // fallback
            for (let i = 1; i < parts.length; i++) {
              if (!parts[i].startsWith('-')) {
                show = parts[i];
                break;
              }
            }
            const entry: vscode.QuickPickItem = {
              label: pid,
              description: show
            };
            (entry as any).detail = cmdLine;
            items.push(entry);
            pidToCmd.set(pid, cmdLine);
          }
        });

        const qp = vscode.window.createQuickPick();
        qp.items = items;
        qp.placeholder   = 'Select Python process';
        if ('matchOnDetail' in qp) {
          (qp as any).matchOnDetail = true;
        }
        qp.onDidAccept(() => {
          const sel = qp.selectedItems[0];
          if (sel) {
            resolve({ pid: sel.label, cmd: pidToCmd.get(sel.label) ?? '' });
          } else {
            resolve(undefined);
          }
          qp.hide();
        });
        qp.onDidHide(()  => resolve(undefined));
        qp.show();
      });
    });
  }


  /* -------------------- refresh -------------------- */
  async function refresh() {
    log.appendLine('[refresh]');
    if (!currentPid) {
      vscode.window.showWarningMessage('PySpy Viewer: no process selected.');
      return;
    }

    try {
      const dump = await runPySpyDump(pySpy, currentPid);
      log.appendLine(`dump length: ${dump.length}`);

      if (!dump.includes('Thread')) {
        vscode.window.showWarningMessage('PySpy Viewer: stack read failed - need sudo or same user?');
      }

      let uid = 0;
      const frames: Frame[] = [];
      dump.split('\n').forEach(line => {
        const t = line.trim();
        const m1 = t.match(/^File "(.+)", line (\d+), in (.+)$/);
        if (m1) {
          frames.push({ file: m1[1], line: +m1[2], func: m1[3], uid: uid++ });
          return;
        }
        const m2 = t.match(/^(.+?) \((.+):(\d+)\)$/);
        if (m2) {
          frames.push({ file: m2[2], line: +m2[3], func: m2[1], uid: uid++ });
        }
      });
      provider.setFrames(frames);

      if (!frames.length) {
        vscode.window.showInformationMessage('PySpy Viewer: no frames (process idle or permission denied).');
      }
    } catch (e: any) {
      const msg = e.toString();
      const ended = /(No such process|executable name|process error|os error 87|os error 3)/i;
      if (ended.test(msg)) {
        vscode.window.showInformationMessage('PySpy Viewer: process ended.');
      } else {
        vscode.window.showErrorMessage(`PySpy Viewer: ${msg.slice(0,120)}`);
      }

      provider.setFrames([]);
      provider.setHeader(null); 
      tree.message = '';
      currentPid = undefined;
      log.appendLine(`py-spy dump error: ${msg}`);
    }
  }

  /* -------------------- commands -------------------- */
  context.subscriptions.push(
    vscode.commands.registerCommand('pyspy.pickProcess', async () => {
      const sel = await pickProcess();
      if (sel) {
        const { pid, cmd } = sel;
        currentPid = pid;
        provider.setHeader({ pid, cmd });
        await refresh();
      }
    }),

    vscode.commands.registerCommand('pyspy.refreshTrace', refresh),

    vscode.commands.registerCommand('pyspy.toggleOrder', () => {
      if (provider.getChildren().length === 0) {
        vscode.window.showInformationMessage('PySpy Viewer: no frames to reorder.');
        return;
      }
      provider.toggleOrder();
    }),

    vscode.commands.registerCommand('pyspy.openFrame', (fr: Frame) => {
      provider.setSelected(fr.uid);
      openFileAtLine(fr, vscode.ViewColumn.One);
    }),

    { dispose: () => log.dispose() }
  );

  log.appendLine('activation complete');
}
