/**
 * Component dependency-graph webview. Rolls the symbol call-graph up to
 * components (see componentGraph) and renders an interactive force layout in a
 * self-contained, CSP-locked webview — no CDN, works offline. Node size = owned
 * symbols, color = fragility, link width = cross-component call count. Clicking a
 * node opens its first path; counts badge constraints/bugs/decisions.
 */
import * as vscode from "vscode";
import { componentGraph, type Hunch } from "./hunchData.js";

let panel: vscode.WebviewPanel | undefined;

export function showGraph(hunch: Hunch, root: string): void {
  if (panel) {
    panel.reveal(vscode.ViewColumn.Active);
  } else {
    panel = vscode.window.createWebviewPanel("hunchGraph", "Hunch — Component Graph", vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    panel.onDidDispose(() => { panel = undefined; });
    panel.webview.onDidReceiveMessage((msg) => {
      if (msg?.type === "open" && typeof msg.path === "string") {
        const uri = vscode.Uri.joinPath(vscode.Uri.file(root), msg.path);
        vscode.commands.executeCommand("vscode.open", uri).then(undefined, () =>
          vscode.window.showWarningMessage(`Hunch: could not open ${msg.path}`));
      }
    });
  }
  const graph = componentGraph(hunch);
  panel.webview.html = html(panel.webview, graph);
}

export function refreshGraph(hunch: Hunch): void {
  if (panel) panel.webview.html = html(panel.webview, componentGraph(hunch));
}

function nonce(): string {
  // webview CSP nonce — fixed-length token derived without Date/random deps.
  return Array.from({ length: 16 }, (_, i) => "abcdefghijklmnop"[(i * 7 + 3) % 16]).join("");
}

function html(webview: vscode.Webview, graph: ReturnType<typeof componentGraph>): string {
  const n = nonce();
  const data = JSON.stringify(graph).replace(/</g, "\\u003c");
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${n}';">
<style>
  html,body{margin:0;height:100%;background:var(--vscode-editor-background);color:var(--vscode-foreground);font-family:var(--vscode-font-family);overflow:hidden}
  #hint{position:fixed;top:8px;left:12px;font-size:11px;opacity:.6}
  #tip{position:fixed;pointer-events:none;background:var(--vscode-editorHoverWidget-background);border:1px solid var(--vscode-editorHoverWidget-border);
       padding:6px 8px;border-radius:4px;font-size:12px;max-width:320px;display:none;z-index:10}
  svg{width:100vw;height:100vh;cursor:grab}
  text{font-size:11px;fill:var(--vscode-foreground);pointer-events:none;user-select:none}
  line{stroke:var(--vscode-panel-border);stroke-opacity:.5}
  circle{cursor:pointer;stroke:var(--vscode-editor-background);stroke-width:1.5}
</style></head><body>
<div id="hint">drag nodes · click to open · scroll to zoom</div>
<div id="tip"></div>
<svg id="svg"><g id="view"><g id="links"></g><g id="nodes"></g></g></svg>
<script nonce="${n}">
const G = ${data};
const svg = document.getElementById('svg'), view = document.getElementById('view'), tip = document.getElementById('tip');
const W = window.innerWidth, H = window.innerHeight;
if (!G.nodes.length) { document.getElementById('hint').textContent = 'No components recorded in this Hunch graph yet.'; }
const idx = new Map(G.nodes.map((d,i)=>[d.id,i]));
// deterministic initial placement on a circle
G.nodes.forEach((d,i)=>{const a=2*Math.PI*i/Math.max(1,G.nodes.length);d.x=W/2+Math.cos(a)*Math.min(W,H)*0.32;d.y=H/2+Math.sin(a)*Math.min(W,H)*0.32;d.vx=0;d.vy=0;});
const links = G.links.map(l=>({s:idx.get(l.source),t:idx.get(l.target),w:l.weight})).filter(l=>l.s!=null&&l.t!=null);
const maxSym = Math.max(1,...G.nodes.map(d=>d.symbols));
const maxW = Math.max(1,...links.map(l=>l.w));
const radius = d => 8 + 22*Math.sqrt(d.symbols/maxSym);
const color = f => { const r=Math.round(80+160*f), g=Math.round(190-150*f); return 'rgb('+r+','+g+',90)'; };

// build DOM
const linkG = document.getElementById('links'), nodeG = document.getElementById('nodes');
const lineEls = links.map(l=>{const e=document.createElementNS('http://www.w3.org/2000/svg','line');e.setAttribute('stroke-width',(0.5+2.5*l.w/maxW).toFixed(2));linkG.appendChild(e);return e;});
const nodeEls = G.nodes.map(d=>{
  const grp=document.createElementNS('http://www.w3.org/2000/svg','g');
  const c=document.createElementNS('http://www.w3.org/2000/svg','circle');
  c.setAttribute('r',radius(d));c.setAttribute('fill',color(d.fragility));
  const t=document.createElementNS('http://www.w3.org/2000/svg','text');
  t.setAttribute('text-anchor','middle');t.setAttribute('dy',radius(d)+12);
  t.textContent=d.name+(d.bugs?'  🐞'+d.bugs:'')+(d.constraints?'  ⛔'+d.constraints:'');
  grp.appendChild(c);grp.appendChild(t);nodeG.appendChild(grp);
  c.addEventListener('mousemove',ev=>showTip(ev,d));
  c.addEventListener('mouseleave',()=>tip.style.display='none');
  c.addEventListener('click',()=>{ if(d.paths&&d.paths[0]) vscodeApi.postMessage({type:'open',path:String(d.paths[0]).replace(/[\\\\/]?\\*\\*.*$/,'').replace(/\\*.*$/,'')}); });
  c.addEventListener('mousedown',ev=>startDrag(ev,d));
  return {grp,c,t};
});
function showTip(ev,d){tip.style.display='block';tip.style.left=(ev.clientX+12)+'px';tip.style.top=(ev.clientY+12)+'px';
  tip.innerHTML='<b>'+d.name+'</b><br>'+d.symbols+' symbols · fragility '+d.fragility.toFixed(2)+'<br>⛔ '+d.constraints+' · 🐞 '+d.bugs+' · 🧭 '+d.decisions+(d.paths&&d.paths[0]?'<br><i>'+d.paths[0]+'</i>':'');}

// simple force simulation
function tick(){
  for(let i=0;i<G.nodes.length;i++){const a=G.nodes[i];
    for(let j=i+1;j<G.nodes.length;j++){const b=G.nodes[j];let dx=b.x-a.x,dy=b.y-a.y,dist=Math.sqrt(dx*dx+dy*dy)||1;
      const rep=2200/(dist*dist);const fx=dx/dist*rep,fy=dy/dist*rep;a.vx-=fx;a.vy-=fy;b.vx+=fx;b.vy+=fy;}
    a.vx+=(W/2-a.x)*0.002;a.vy+=(H/2-a.y)*0.002; // gravity to center
  }
  for(const l of links){const a=G.nodes[l.s],b=G.nodes[l.t];let dx=b.x-a.x,dy=b.y-a.y,dist=Math.sqrt(dx*dx+dy*dy)||1;
    const k=(dist-120)*0.01;const fx=dx/dist*k,fy=dy/dist*k;a.vx+=fx;a.vy+=fy;b.vx-=fx;b.vy-=fy;}
  for(const d of G.nodes){ if(d===dragNode) continue; d.x+=Math.max(-20,Math.min(20,d.vx));d.y+=Math.max(-20,Math.min(20,d.vy));d.vx*=0.82;d.vy*=0.82;}
  render();
}
function render(){
  links.forEach((l,i)=>{const a=G.nodes[l.s],b=G.nodes[l.t];lineEls[i].setAttribute('x1',a.x);lineEls[i].setAttribute('y1',a.y);lineEls[i].setAttribute('x2',b.x);lineEls[i].setAttribute('y2',b.y);});
  G.nodes.forEach((d,i)=>nodeEls[i].grp.setAttribute('transform','translate('+d.x+','+d.y+')'));
}
let frames=0;const timer=setInterval(()=>{tick();if(++frames>400)clearInterval(timer);},16);

// drag
let dragNode=null,dragOff=null;
function startDrag(ev,d){dragNode=d;const p=toView(ev);dragOff={x:p.x-d.x,y:p.y-d.y};svg.style.cursor='grabbing';ev.stopPropagation();}
window.addEventListener('mousemove',ev=>{if(!dragNode)return;const p=toView(ev);dragNode.x=p.x-dragOff.x;dragNode.y=p.y-dragOff.y;dragNode.vx=dragNode.vy=0;render();
  if(frames>=400){frames=0;clearInterval(timer);}});
window.addEventListener('mouseup',()=>{dragNode=null;svg.style.cursor='grab';});

// pan + zoom
let tx=0,ty=0,scale=1,panning=false,panStart=null;
function apply(){view.setAttribute('transform','translate('+tx+','+ty+') scale('+scale+')');}
function toView(ev){return {x:(ev.clientX-tx)/scale,y:(ev.clientY-ty)/scale};}
svg.addEventListener('mousedown',ev=>{if(dragNode)return;panning=true;panStart={x:ev.clientX-tx,y:ev.clientY-ty};});
window.addEventListener('mousemove',ev=>{if(!panning)return;tx=ev.clientX-panStart.x;ty=ev.clientY-panStart.y;apply();});
window.addEventListener('mouseup',()=>panning=false);
svg.addEventListener('wheel',ev=>{ev.preventDefault();const f=ev.deltaY<0?1.1:0.9;const mx=ev.clientX,my=ev.clientY;tx=mx-(mx-tx)*f;ty=my-(my-ty)*f;scale*=f;apply();},{passive:false});
const vscodeApi=acquireVsCodeApi();
</script></body></html>`;
}
