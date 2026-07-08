/**
 * Review-queue webview — draft triage inside the editor. Renders the same
 * READY / SCRUTINY split as `hunch review`, but as a card list with Accept /
 * Reject buttons so the reviewer never has to copy decision ids into a shell.
 *
 * Read-only over .hunch/ JSON like the rest of the extension; every write
 * (accept / reject / batch) delegates to the `hunch` CLI via `runCli` — the
 * extension never mutates the graph itself (Delegate-all-writes decision). The
 * panel is self-contained and CSP-locked (no CDN), mirroring graph.ts.
 */
import * as vscode from "vscode";
import { reviewQueue, type Hunch, type ReviewItem, READY_MIN_GROUNDED } from "./hunchData.js";

/** Shell out to `hunch review <...args>`; resolves after the CLI finishes. */
export type RunCli = (args: string[]) => Thenable<void>;

let panel: vscode.WebviewPanel | undefined;
let runCli: RunCli | undefined;

export function showReview(hunch: Hunch, root: string, run: RunCli): void {
  runCli = run;
  if (panel) {
    panel.reveal(vscode.ViewColumn.Active);
  } else {
    panel = vscode.window.createWebviewPanel("hunchReview", "Hunch — Review Queue", vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    panel.onDidDispose(() => { panel = undefined; });
    panel.webview.onDidReceiveMessage(async (msg: { type?: string; id?: string; file?: string }) => {
      if (!runCli) return;
      switch (msg?.type) {
        case "accept":            if (msg.id) await runCli(["--accept", msg.id]); break;
        case "reject":            if (msg.id) await runCli(["--reject", msg.id]); break;
        case "acceptVerified":    await runCli(["--accept-verified"]); break;
        case "rejectDuplicates":  await runCli(["--reject-duplicates"]); break;
        case "open":
          if (msg.file) {
            const uri = vscode.Uri.joinPath(vscode.Uri.file(root), msg.file);
            void vscode.commands.executeCommand("vscode.open", uri).then(undefined, () =>
              vscode.window.showWarningMessage(`Hunch: could not open ${msg.file}`));
          }
          break;
      }
    });
  }
  panel.webview.html = html(hunch);
}

/** Re-render if the panel is open (called after the graph reloads on a .hunch/ change). */
export function refreshReview(hunch: Hunch): void {
  if (panel) panel.webview.html = html(hunch);
}

function nonce(): string {
  return Array.from({ length: 16 }, (_, i) => "abcdefghijklmnop"[(i * 7 + 3) % 16]).join("");
}

function html(hunch: Hunch): string {
  const n = nonce();
  const q = reviewQueue(hunch);
  const data = JSON.stringify({ ready: q.ready, scrutiny: q.scrutiny, minGrounded: READY_MIN_GROUNDED }).replace(/</g, "\\u003c");
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${n}';">
<style>
  body{margin:0;padding:0 18px 40px;background:var(--vscode-editor-background);color:var(--vscode-foreground);font-family:var(--vscode-font-family);font-size:13px}
  h2{border-bottom:1px solid var(--vscode-panel-border);padding-bottom:6px}
  h3{margin:1.6em 0 .6em;font-size:12px;text-transform:uppercase;letter-spacing:.5px;opacity:.85}
  .empty{opacity:.6;font-style:italic;margin:2em 0}
  .card{border:1px solid var(--vscode-panel-border);border-left-width:3px;border-radius:5px;padding:10px 12px;margin:10px 0;background:var(--vscode-editorWidget-background)}
  .card.ready{border-left-color:var(--vscode-testing-iconPassed,#3fb950)}
  .card.scrutiny{border-left-color:var(--vscode-editorWarning-foreground,#d29922)}
  .title{font-weight:600;margin-bottom:4px}
  .body{opacity:.9;line-height:1.45;margin:6px 0;white-space:pre-wrap}
  .meta{font-size:11px;opacity:.6;margin:4px 0}
  .badges{margin:6px 0}
  .badge{display:inline-block;font-size:10px;padding:1px 7px;border-radius:10px;margin-right:6px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)}
  .rej{margin:6px 0;font-size:12px}.rej b{opacity:.7;font-weight:600}
  .files{font-size:11px;margin:4px 0}
  .files a{color:var(--vscode-textLink-foreground);cursor:pointer;text-decoration:none;margin-right:10px}
  .files a:hover{text-decoration:underline}
  .actions{margin-top:8px}
  button{font-family:inherit;font-size:12px;border:none;border-radius:4px;padding:4px 12px;margin-right:8px;cursor:pointer}
  .accept{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
  .accept:hover{background:var(--vscode-button-hoverBackground)}
  .reject{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
  .reject:hover{background:var(--vscode-button-secondaryHoverBackground)}
  .batch{margin:8px 0 4px}
  .hint{opacity:.6;font-size:11px;margin-bottom:10px}
</style></head><body>
<h2>🧠 Review Queue</h2>
<div class="hint">Drafts synthesized from your commits, awaiting confirmation. Accepting arms a draft's tripwires; rejecting deletes it. Writes run through the <code>hunch</code> CLI.</div>
<div id="root"></div>
<script nonce="${n}">
const Q = ${data};
const vscodeApi = acquireVsCodeApi();
function esc(s){return String(s==null?'':s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}
function pct(x){return x==null?'?':Math.round(x*100)+'%';}

function card(it, group){
  const d = it.d, p = d.provenance||{}, s = it.synth||{};
  const badges = [];
  badges.push('<span class="badge">'+esc(d.status||'?')+'</span>');
  if (d.topic) badges.push('<span class="badge">topic: '+esc(d.topic)+'</span>');
  if (it.verified) badges.push('<span class="badge">✓ critic-verified</span>');
  badges.push('<span class="badge">confidence '+pct(it.confidence)+'</span>');
  if (s.grounded!=null) badges.push('<span class="badge">grounded '+pct(s.grounded)+'</span>');
  if (s.provider) badges.push('<span class="badge">'+esc(s.provider)+'</span>');
  if (s.verify) badges.push('<span class="badge">verify '+esc(s.verify)+'</span>');

  const rejected = (d.alternatives_rejected||[]).map(r=>'<div class="rej"><b>rejected:</b> '+esc(r)+'</div>').join('');
  const files = (d.related_files||[]).map(f=>'<a data-file="'+esc(f)+'">'+esc(f)+'</a>').join('');

  return '<div class="card '+group+'">'
    + '<div class="title">'+esc(d.title)+'</div>'
    + (d.decision?'<div class="body">'+esc(d.decision)+'</div>':'')
    + (d.context?'<div class="meta">context: '+esc(d.context)+'</div>':'')
    + rejected
    + '<div class="badges">'+badges.join('')+'</div>'
    + (files?'<div class="files">'+files+'</div>':'')
    + '<div class="meta">'+esc(d.id)+(p.source?' · '+esc(p.source):'')+'</div>'
    + '<div class="actions">'
    +   '<button class="accept" data-act="accept" data-id="'+esc(d.id)+'">Accept</button>'
    +   '<button class="reject" data-act="reject" data-id="'+esc(d.id)+'">Reject</button>'
    + '</div>'
    + '</div>';
}

function render(){
  const root = document.getElementById('root');
  if (!Q.ready.length && !Q.scrutiny.length){
    root.innerHTML = '<div class="empty">✓ No drafts awaiting review. Hunch synthesizes these from your commits — they show up here after a sync.</div>';
    return;
  }
  let h = '';
  if (Q.ready.length){
    h += '<h3>✓ Ready to confirm — critic-verified, grounded ≥ '+pct(Q.minGrounded)+' ('+Q.ready.length+')</h3>';
    h += '<div class="batch"><button class="accept" data-act="acceptVerified">Accept all verified ('+Q.ready.length+')</button></div>';
    h += Q.ready.map(it=>card(it,'ready')).join('');
  }
  if (Q.scrutiny.length){
    h += '<h3>⚠ Needs scrutiny — unverified / low-grounded ('+Q.scrutiny.length+')</h3>';
    h += '<div class="batch"><button class="reject" data-act="rejectDuplicates">Reject near-duplicates</button></div>';
    h += Q.scrutiny.map(it=>card(it,'scrutiny')).join('');
  }
  root.innerHTML = h;
}
render();

document.getElementById('root').addEventListener('click', ev=>{
  const a = ev.target.closest('a[data-file]');
  if (a){ vscodeApi.postMessage({type:'open', file:a.getAttribute('data-file')}); return; }
  const btn = ev.target.closest('button[data-act]');
  if (!btn) return;
  const act = btn.getAttribute('data-act'), id = btn.getAttribute('data-id');
  btn.disabled = true; btn.textContent = '…';
  vscodeApi.postMessage({type:act, id:id||undefined});
});
</script></body></html>`;
}
