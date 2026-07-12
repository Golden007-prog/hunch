(() => {
  const section = document.querySelector('.proof-curve');
  if (!section) return;
  const value = (selector, text) => { const node = section.querySelector(selector); if (node) node.textContent = String(text); };
  const drawSeries = series => {
    if (!Array.isArray(series) || series.length < 2) return;
    const width = 700, height = 190, top = 18, bottom = 180;
    const times = series.map(point => Date.parse(point.at));
    const counts = series.map(point => Number(point.memories));
    const first = Math.min(...times), last = Math.max(...times), max = Math.max(...counts, 1);
    const points = series.map((point, index) => {
      const x = ((times[index] - first) / Math.max(1, last - first)) * width;
      const y = bottom - (counts[index] / max) * (bottom - top);
      return [Number(x.toFixed(1)), Number(y.toFixed(1))];
    });
    const line = `M${points.map(([x, y]) => `${x} ${y}`).join(' L')}`;
    const area = `${line} L${width} ${height} L0 ${height} Z`;
    section.querySelector('[data-proof-stock]')?.setAttribute('d', line);
    section.querySelector('[data-proof-area]')?.setAttribute('d', area);
    const [x, y] = points.at(-1);
    const point = section.querySelector('[data-proof-point]');
    point?.setAttribute('cx', x); point?.setAttribute('cy', y);
  };
  fetch('/proof-curve.json', { cache: 'no-cache' }).then(response => {
    if (!response.ok) throw new Error(`proof receipt ${response.status}`);
    return response.json();
  }).then(proof => {
    const stock = proof.stock;
    drawSeries(proof.stock_series);
    value('[data-proof="decisions"]', stock.decisions.accepted);
    value('[data-proof="locked"]', stock.invariants.locked);
    value('[data-proof="coverage"]', `${Math.round(stock.coverage.pct * 100)}%`);
    value('[data-proof="caught"]', proof.return.lifetime.violations_caught);
    value('[data-proof="reprevented"]', proof.return.lifetime.bugs_reprevented);
    value('[data-proof="payback"]', proof.compounding.payback_ratio.toFixed(2));
    value('[data-proof="generated"]', new Date(proof.generated_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }));
    value('.proof-now', `${stock.decisions.total} memories · ${stock.components} components`);
    section.classList.add('is-loaded');
  }).catch(() => {
    value('.proof-meta', 'Live receipt unavailable · run hunch stats --json locally');
  });
})();
