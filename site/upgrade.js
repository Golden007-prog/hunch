(() => {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const root = document.documentElement;
  const nav = document.querySelector('.nav');
  const sections = [...document.querySelectorAll('main section, body > section')];
  const meter = document.createElement('div');
  meter.className = 'site-meter'; meter.innerHTML = '<span></span>';
  document.body.append(meter);
  root.classList.add('motion-active');

  sections.forEach(section => {
    section.dataset.reveal = '';
    const blocks = section.querySelectorAll(':scope .sec-head, :scope .grid3, :scope .steps, :scope .chain, :scope .fgroups, :scope .cmp, :scope .qs, :scope .wrap > .hero-cta');
    blocks.forEach(block => block.classList.add('motion-block'));
    const items = section.querySelectorAll(':scope .card, :scope .step, :scope .chain .node, :scope .fgroup, :scope .cmp tbody tr');
    items.forEach((item, index) => { item.classList.add('motion-item'); item.style.setProperty('--stagger', index % 7); });
  });
  const observer = new IntersectionObserver(entries => entries.forEach(entry => {
    if (entry.isIntersecting) { entry.target.classList.add('is-inview'); observer.unobserve(entry.target); }
  }), { threshold: .12 });
  sections.forEach(section => observer.observe(section));

  document.querySelectorAll('.grid3 .card').forEach(card => {
    card.addEventListener('pointermove', event => {
      if (!matchMedia('(pointer:fine)').matches) return;
      const rect = card.getBoundingClientRect();
      card.style.setProperty('--ry', `${((event.clientX - rect.left) / rect.width - .5) * 6}deg`);
      card.style.setProperty('--rx', `${((event.clientY - rect.top) / rect.height - .5) * -6}deg`);
      card.style.setProperty('--ty', '-6px');
    });
    card.addEventListener('pointerleave', () => { card.style.setProperty('--rx','0deg'); card.style.setProperty('--ry','0deg'); card.style.setProperty('--ty','0px'); });
  });

  const meterFill = meter.querySelector('span');
  addEventListener('scroll', () => {
    const p = scrollY / Math.max(1, document.documentElement.scrollHeight - innerHeight);
    meterFill.style.height = `${p * 100}%`;
    nav?.classList.toggle('is-scrolled', scrollY > 24);
  }, { passive: true });
})();
