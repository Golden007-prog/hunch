/** A static, read-only consumer of the existing state HTTP contract. No embedded user data. */
export const operatorHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hunch · Shared state</title><link rel="icon" href="data:,"><link rel="stylesheet" href="/operator.css"><script src="/operator.js" defer></script></head>
<body><main>
<header><div class="eyebrow">HUNCH / SHARED RECORD</div><span class="badge">Read-only view</span>
<h1>Shared state</h1><p class="intro">What was decided, what happened, and what still needs doing.</p></header>
<section id="connection" class="panel"><h2>Open your workspace</h2><p>Use a token issued by this Hunch server. It stays in this tab’s memory until you disconnect or reload.</p>
<form id="connect-form"><label for="token">Access token</label><div class="row"><input id="token" type="password" required autocomplete="off" spellcheck="false" placeholder="Paste your access token"><button id="connect" type="submit">Connect</button></div></form>
<p class="muted small">The view makes no changes to records. The token keeps its existing server permissions.</p></section>
<p id="status" role="status" aria-live="polite"></p><p id="error" role="alert" hidden></p>
<div id="workspace" hidden>
<section class="toolbar"><div><label for="scope">Workspace</label><select id="scope"></select><p id="identity" class="small muted"></p></div><div class="row"><button id="refresh" class="secondary">Refresh</button><button id="disconnect" class="secondary">Disconnect</button></div></section>
<form id="subject-form" class="panel"><label for="subject">Find a subject or record</label><div class="row"><input id="subject" maxlength="512" required placeholder="A topic, customer:c1, or record ID" autocomplete="off"><button type="submit">Show state</button><button id="inspect-id" type="button" class="secondary">Inspect record ID</button></div><p class="small muted">Show state for an exact topic or subject key. Inspect a record ID to see its stored version, including failed or retired records.</p></form>
<section id="subject-view" aria-labelledby="subject-title"><div class="section-heading"><div><div class="eyebrow">STATE ON RECORD</div><h2 id="subject-title">Choose a subject</h2></div></div><p id="subject-hint" class="muted">Open a subject to see the record your agents share.</p><div id="state-content"></div></section>
<section id="record-view" class="panel" hidden aria-labelledby="record-title"><div class="section-heading"><h2 id="record-title">Stored record</h2><button id="close-record" class="secondary">Close record</button></div><p class="muted small">Latest stored version. A past activity event may refer to an earlier revision.</p><div id="record-content"></div></section>
<section aria-labelledby="activity-title"><div class="section-heading"><div><div class="eyebrow">CHANGE HISTORY</div><h2 id="activity-title">Recent activity</h2></div></div><p id="activity-note" class="muted small"></p><div id="activity"></div></section>
<footer>Showing stored evidence, not a fresh check of external systems. Source content stays in its original system. Refresh to see changes made by other agents.</footer>
</div><noscript>This view needs JavaScript to make authenticated reads from your Hunch server.</noscript>
</main></body></html>`;

export const operatorCss = String.raw`
:root{color-scheme:light dark;--bg:#f4f7f4;--paper:#fff;--ink:#162e24;--muted:#53685b;--line:#d5e1d8;--accent:#276540;--error:#9c352e}
*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.65 system-ui,sans-serif}main{max-width:1120px;margin:auto;padding:48px 28px 80px}header{border-top:5px solid var(--accent);padding-top:26px;margin-bottom:36px;position:relative}.eyebrow{font-size:12px;letter-spacing:.1em;color:var(--muted);font-weight:650}header>.badge{float:right}.badge{display:inline-block;font-size:12px;border:1px solid var(--line);border-radius:30px;padding:3px 10px;color:var(--muted)}h1{font-size:clamp(36px,6vw,60px);line-height:1.12;letter-spacing:-.045em;margin:20px 0 12px}h2{font-size:23px;line-height:1.3;margin:8px 0 14px}h3{font-size:17px;line-height:1.5;margin:10px 0}p{margin:8px 0}.intro{font-size:19px;color:var(--muted);max-width:660px}.panel,article{background:var(--paper);border:1px solid var(--line);border-radius:12px;padding:24px;margin:16px 0}.muted,dt{color:var(--muted)}.small{font-size:13px}label{display:block;font-size:13px;font-weight:650;margin:12px 0 6px}input,select,button{font:inherit;border-radius:7px;padding:10px 14px;min-height:46px}input,select{min-width:0;width:100%;background:var(--paper);color:var(--ink);border:1px solid var(--line)}button{cursor:pointer;background:var(--accent);border:1px solid var(--accent);color:var(--paper);font-weight:600;flex-shrink:0}button.secondary{color:var(--ink);background:var(--paper);border-color:var(--line)}button:disabled{opacity:.6;cursor:wait}.row{display:flex;gap:10px;align-items:center}.row>input{flex:1}.toolbar,.section-heading{display:flex;gap:20px;align-items:center;justify-content:space-between}.toolbar{margin-bottom:24px}.toolbar>div:first-child{min-width:0;flex:1;max-width:470px}.section-heading{margin-top:32px}.state-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.state-column>h3{border-bottom:1px solid var(--line);padding-bottom:12px}.state-column article{padding:18px}.record-title,.record-content{white-space:pre-wrap;overflow-wrap:anywhere}.record-content{font-size:14px}.metadata{font-size:12px;color:var(--muted)}.empty{border:1px dashed var(--line);border-radius:10px;padding:20px;color:var(--muted);font-size:14px}summary{cursor:pointer;padding:8px 0;font-size:13px;font-weight:600}details{margin-top:14px;border-top:1px solid var(--line);padding-top:6px}pre{white-space:pre-wrap;font:12px/1.6 ui-monospace,monospace;background:var(--bg);padding:12px;border-radius:6px}pre,code,dd,li,h2,h3,select{overflow-wrap:anywhere;word-break:break-word}dd{margin:0 0 8px;font-size:13px}dt{font-size:12px}ul{padding-left:20px}article.activity-item{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;padding:18px 22px}.activity-item>div{min-width:0}.activity-item h3{margin:0 0 4px}.activity-actions{display:flex;gap:8px;flex-wrap:wrap}.activity-actions button{font-size:12px;min-height:40px;padding:7px 11px}#error{color:var(--error);border-left:3px solid var(--error);padding:12px 16px;background:var(--paper)}#status{color:var(--muted)}footer{margin-top:36px;border-top:1px solid var(--line);padding-top:20px;font-size:12px;color:var(--muted)}:focus-visible{outline:3px solid var(--accent);outline-offset:4px}
@media(prefers-color-scheme:dark){:root{--bg:#101b16;--paper:#17271e;--ink:#e3eee6;--muted:#a7b9ac;--line:#365041;--accent:#9cdbb0;--error:#f1a89e}}
@media(max-width:760px){main{padding:26px 20px 50px}.state-grid{grid-template-columns:1fr}.toolbar{align-items:stretch;flex-direction:column;gap:8px}.toolbar>div:first-child{max-width:none}.panel{padding:20px}.row{flex-wrap:wrap}.row input{flex-basis:100%}article.activity-item{flex-direction:column;gap:10px}.section-heading{flex-wrap:wrap}header>.badge{float:none;margin-top:12px}.section-heading h2{max-width:100%}}
`;

export const operatorJs = String.raw`
'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const node = (tag, text, cls) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; };
  const empty = text => node('p', text, 'empty');
  let token = '', scopes = [], subject = '', cursor = null, generation = 0, controller;
  const scope = () => scopes[Number($('scope').value)];
  function clearSubject() {
    subject = ''; cursor = null; $('state-content').replaceChildren(); $('subject-title').textContent = 'Choose a subject';
    $('subject-hint').textContent = 'Open a subject to see the record your agents share.'; $('record-view').hidden = true; $('record-content').replaceChildren();
  }
  function disconnect() {
    generation++; controller?.abort(); token = ''; scopes = []; clearSubject(); $('token').value = ''; $('subject').value = '';
    $('scope').replaceChildren(); $('identity').textContent = ''; $('activity').replaceChildren(); $('activity-note').textContent = '';
    $('workspace').hidden = true; $('connection').hidden = false; $('error').hidden = true; $('status').textContent = 'Disconnected. Workspace data cleared from this page.';
    $('connect').disabled = false; $('refresh').disabled = false; $('token').focus();
  }
  async function run(label, work) {
    controller?.abort(); controller = new AbortController(); const signal = controller.signal, id = ++generation;
    $('error').hidden = true; $('status').textContent = label; $('connect').disabled = true; $('refresh').disabled = true;
    try { await work(signal, () => id === generation); if (id === generation) $('status').textContent = 'Updated ' + new Date().toLocaleTimeString() + ' · refresh for newer records'; }
    catch (e) {
      if (id !== generation || e.name === 'AbortError') return;
      if (e.status === 401) disconnect();
      $('error').textContent = e.status === 409 ? 'The records changed between pages. Show the subject again to restart from current state.' : e.status === 401 ? 'That token was not accepted. Check it and reconnect.' : e.message || 'Could not reach this Hunch server. Try again.';
      $('error').hidden = false; $('status').textContent = 'Update failed. Displayed records may be out of date.';
    } finally { if (id === generation) { $('connect').disabled = false; $('refresh').disabled = false; } }
  }
  async function api(route, body, signal) {
    const response = await fetch('/nuryel/v1/' + route, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), signal, cache: 'no-store', credentials: 'omit', redirect: 'error' });
    const data = await response.json(); if (!response.ok) { const e = new Error(data.detail || 'The server could not complete this read.'); e.status = response.status; throw e; } return data;
  }
  function field(list, title, value) { if (value === undefined || value === null || value === '') return; list.append(node('dt', title), node('dd', typeof value === 'string' ? value : JSON.stringify(value))); }
  // Dependencies have a fixed JSON schema. Match the contract's sorted-key hash,
  // independent of their position in the dependency array; never fetch a source.
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
  async function dependencyHash(value) {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(canonical(value))));
    return 'sha256:' + Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
  }
  async function citationDetails(record, area) {
    try {
      const dependencies = new Map(await Promise.all(record.dependencies.map(async d => [await dependencyHash(d), d])));
      for (const citation of record.field_provenance) {
        const selector = citation.selector;
        const detail = node('details'); detail.append(node('summary', selector.kind === 'text' ? 'Text ' + selector.start + '–' + selector.end : 'Field ' + (selector.path || '(root)')));
        // A valid record can reuse hundreds of large sources across many fields.
        // Expand only the field the person opens, with four source bodies per step.
        let rendered = false;
        detail.addEventListener('toggle', () => {
          if (!detail.open || rendered) return; rendered = true;
          let value = selector.kind === 'text' ? Array.from(record.content).slice(selector.start, selector.end).join('') : JSON.parse(record.content);
          if (selector.kind === 'json_pointer') for (const key of selector.path === '' ? [] : selector.path.slice(1).split('/').map(k => k.replace(/~1/g, '/').replace(/~0/g, '~'))) {
            if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) { detail.append(node('p', 'Citation target unavailable.')); return; }
            value = value[key];
          }
          detail.append(node('pre', JSON.stringify(value)), node('h3', 'Sources for this field'));
          const bodies = node('div'), more = node('button', 'Show more sources', 'secondary'); let offset = 0;
          const showSources = () => {
            citation.dependency_hashes.slice(offset, offset + 4).forEach(hash => bodies.append(node('pre', JSON.stringify(dependencies.get(hash) || { unavailable_dependency_hash: hash }, null, 2))));
            offset += 4; more.hidden = offset >= citation.dependency_hashes.length;
          };
          more.type = 'button'; more.onclick = showSources; detail.append(bodies, more); showSources();
        });
        area.append(detail);
      }
    } catch { area.append(node('p', 'Citation display unavailable. Exact citations remain in Sources & record details.', 'small muted')); }
  }
  function card(ref, records) {
    const r = records[ref.id], article = node('article');
    if (!r) { article.append(empty('Record body unavailable: ' + ref.id)); return article; }
    article.append(node('span', (r.state || r.status || r.lifecycle || ref.facet) + ' · ' + ref.facet, 'badge'));
    let observation;
    if (typeof r.content === 'string') { try { const parsed = JSON.parse(r.content); if (parsed?.schema === 'nuryel.observation-content/1' && typeof parsed.statement === 'string') observation = parsed; } catch { /* Ordinary derived text is not JSON. */ } }
    const title = r.title || r.statement || observation?.statement || (r.action_kind ? r.action_kind.replaceAll('_', ' ') + ' · ' + (r.target?.object_key || '') : r.name || r.subject || ref.id);
    article.append(node('h3', title, 'record-title'));
    const description = observation ? observation.relevance?.reason : r.content || r.decision || r.rationale;
    if (description) article.append(node('p', description, 'record-content'));
    if (r.visibility) article.append(node('p', 'Restricted record · access owner: ' + r.visibility.owner, 'metadata'));
    if (r.owner || r.actor) article.append(node('p', (r.owner ? 'Owner: ' + r.owner : 'Actor: ' + r.actor), 'metadata'));
    if (r.due) article.append(node('p', 'Due ' + r.due, 'metadata'));
    if (r.occurred_at || r.computed_at || r.created_at) article.append(node('p', r.occurred_at || r.computed_at || r.created_at, 'metadata'));
    if (r.field_provenance?.length) {
      const citations = node('section', undefined, 'field-citations');
      citations.append(node('h3', 'Field citations'), node('p', 'Writer-supplied source links. They do not verify truth, freshness, or uncited fields.', 'small muted'));
      article.append(citations); void citationDetails(r, citations);
    }
    const detail = node('details'); detail.append(node('summary', 'Sources & record details'));
    const list = node('dl'); field(list, 'Record ID', ref.id); field(list, 'Recorded by / source', r.provenance?.source);
    field(list, 'Source reference', r.source); field(list, 'Action target', r.target); field(list, 'Closed by receipt', r.closed_by); field(list, 'Captured by', observation?.captured_by);
    if (ref.record_hash) field(list, 'Record revision', ref.record_hash); detail.append(list);
    const evidence = r.provenance?.evidence || []; if (evidence.length) { detail.append(node('h3', 'Evidence')); const ul = node('ul'); evidence.forEach(x => ul.append(node('li', typeof x === 'string' ? x : JSON.stringify(x)))); detail.append(ul); }
    if (observation?.evidence) detail.append(node('h3', 'Source excerpts'), node('pre', JSON.stringify(observation.evidence, null, 2)));
    if (r.dependencies?.length || r.rests_on?.length) { detail.append(node('h3', 'Depends on'), node('pre', JSON.stringify(r.dependencies || r.rests_on, null, 2))); }
    detail.append(node('pre', JSON.stringify(r, null, 2))); article.append(detail); return article;
  }
  function group(title, refs, records, hint) {
    const section = node('section', undefined, 'state-column'); section.append(node('h3', title + ' (' + refs.length + ')'));
    if (hint) section.append(node('p', hint, 'small muted'));
    if (!refs.length) section.append(empty('No matching records on file.')); else refs.forEach(ref => section.append(card(ref, records))); return section;
  }
  async function readSubject(value, next, signal, current) {
    const result = await api('read', { scope: scope(), subject: value, observed_page: next ? { cursor: next } : {} }, signal);
    if (!current()) return;
    subject = value; cursor = result.state_of_record?.observed_page?.next_cursor || null;
    $('subject').value = value; $('subject-title').textContent = value; $('subject-hint').textContent = 'Stored state for this subject. Status labels describe the record; they do not independently verify its claims.';
    const state = result.state_of_record, records = result.records || {}, area = $('state-content'); area.replaceChildren();
    if (!state) { area.append(empty('No state was returned for this subject.')); return; }
    const grid = node('div', undefined, 'state-grid');
    grid.append(group('Current records', state.current, records), group('Open commitments & rules', state.in_force, records), group('Completed work', state.done, records)); area.append(grid);
    if (state.observed?.length) area.append(group('Observations', state.observed, records, 'Source-backed statements whose currentness is unverified.'));
    const page = state.observed_page;
    if (page && page.total) area.append(node('p', 'Observations ' + ((next?.offset || 0) + 1) + '–' + ((next?.offset || 0) + (state.observed?.length || 0)) + ' of ' + page.total, 'small muted'));
    if (cursor) { const more = node('button', 'Next observations', 'secondary'); more.onclick = () => run('Loading observations…', (s, c) => readSubject(subject, cursor, s, c)); area.append(more); }
    if (next) { const first = node('button', 'First observations', 'secondary'); first.onclick = () => showSubject(subject); area.append(first); }
    if (state.relationships_truncated) area.append(node('p', 'Some relationships are omitted by the server’s response limit.', 'small muted'));
    if (state.invalidated_by?.length) area.append(node('p', 'Recorded invalidation signals: ' + state.invalidated_by.join(', '), 'small muted'));
    const evidence = node('details'); evidence.append(node('summary', 'Read evidence'), node('pre', JSON.stringify({ receipt_id: result.receipt_id, depends_on: state.depends_on, denied_scopes: result.denied_scopes }, null, 2))); area.append(evidence);
  }
  function showSubject(value) {
    clearSubject(); $('subject-title').textContent = value; $('subject-hint').textContent = 'Loading stored state…';
    return run('Reading subject…', (signal, current) => readSubject(value, null, signal, current));
  }
  function inspectRecord(id) {
    return run('Reading record…', async (signal, current) => {
      $('record-content').replaceChildren(); $('record-view').hidden = false;
      const result = await api('records', { scope: scope(), ids: [id] }, signal); if (!current()) return;
      $('record-content').replaceChildren(result.records[id] ? card({ id, facet: result.facets[id] }, result.records) : empty(result.denied.includes(id) ? 'This record is outside your access.' : 'This record is no longer available.'));
      $('record-view').scrollIntoView({ block: 'start' });
    });
  }
  async function activity(signal, current) {
    const result = await api('subscribe', { scope: scope(), after_seq: 0 }, signal); if (!current()) return;
    const events = result.events.slice(-50).reverse(); $('activity').replaceChildren();
    $('activity-note').textContent = 'Showing ' + events.length + ' most recent retained changes · ledger head ' + result.head_seq + '. ' + (result.floor_seq ? 'Earlier history was compacted through event ' + result.floor_seq + '. ' : '') + 'This is change history, not a complete inventory.';
    if (!events.length) $('activity').append(empty('No retained activity in this workspace. You can still look up a subject or record above.'));
    events.forEach(event => {
      const item = node('article', undefined, 'activity-item'), info = node('div'), actions = node('div', undefined, 'activity-actions');
      info.append(node('h3', event.subject || event.record_id), node('p', event.change + ' · ' + event.facet + ' · ' + event.at, 'metadata'));
      if (event.cause?.principal) info.append(node('p', 'Recorded by ' + event.cause.principal, 'metadata'));
      const open = node('button', 'Open subject', 'secondary'); open.onclick = () => { showSubject(event.subject || event.record_id); $('subject-view').scrollIntoView({ block: 'start' }); }; actions.append(open);
      const inspect = node('button', 'Inspect record', 'secondary'); inspect.onclick = () => inspectRecord(event.record_id); actions.append(inspect); item.append(info, actions); $('activity').append(item);
    });
  }
  $('connect-form').onsubmit = event => {
    event.preventDefault(); token = $('token').value.trim(); $('token').value = '';
    run('Connecting…', async (signal, current) => {
      const result = await api('capabilities', undefined, signal); if (!current()) return;
      scopes = result.principal.grants; $('scope').replaceChildren(); scopes.forEach((s, i) => { const option = node('option', s.kind + ' / ' + s.id); option.value = String(i); $('scope').append(option); });
      $('identity').textContent = 'Connected as ' + (result.principal.display || result.principal.id);
      $('connection').hidden = true; $('workspace').hidden = false; await activity(signal, current);
    });
  };
  $('scope').onchange = () => { clearSubject(); $('subject').value = ''; $('activity').replaceChildren(); $('activity-note').textContent = ''; run('Loading workspace…', activity); };
  $('subject-form').onsubmit = event => { event.preventDefault(); const value = $('subject').value.trim(); if (value) showSubject(value); };
  $('inspect-id').onclick = () => { if ($('subject').reportValidity()) inspectRecord($('subject').value.trim()); };
  $('refresh').onclick = () => run('Refreshing workspace…', async (signal, current) => { $('record-view').hidden = true; $('record-content').replaceChildren(); await activity(signal, current); if (subject && current()) await readSubject(subject, null, signal, current); });
  $('disconnect').onclick = disconnect; $('close-record').onclick = () => { $('record-view').hidden = true; $('record-content').replaceChildren(); };
  window.addEventListener('pagehide', disconnect);
})();
`;
