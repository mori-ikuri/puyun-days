const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const scrollBehavior = (): ScrollBehavior => reducedMotion.matches || document.documentElement.classList.contains('motion-paused') ? 'instant' : 'smooth';

document.querySelectorAll<HTMLButtonElement>('[data-series-filter]').forEach(button => {
  button.addEventListener('click', () => {
    const selected = button.dataset.seriesFilter;
    document.querySelectorAll('[data-series-filter]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    let count = 0;
    document.querySelectorAll<HTMLElement>('[data-series-group]').forEach(group => {
      group.hidden = selected !== 'all' && group.dataset.seriesGroup !== selected;
      if (!group.hidden) count += group.querySelectorAll('.article-card').length;
    });
    const output = document.querySelector('[data-article-count]');
    if (output) output.textContent = `${selected === 'all' ? 'すべて' : button.dataset.filterLabel}の記事 · ${count}件`;
    const empty = document.querySelector<HTMLElement>('[data-filter-empty]');
    if (empty) empty.hidden = count !== 0;
  });
});

document.querySelectorAll<HTMLElement>('.article-rail').forEach(rail => {
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('[data-rail-direction]')];
  const step = () => (rail.querySelector('.article-card')?.getBoundingClientRect().width ?? rail.clientWidth) + Number.parseFloat(getComputedStyle(rail).columnGap);
  const move = (direction: number) => rail.scrollBy({left: direction * step(), behavior: scrollBehavior()});
  const update = () => buttons.forEach(button => {
    button.disabled = Number(button.dataset.railDirection) < 0 ? rail.scrollLeft <= 4 : rail.scrollLeft >= rail.scrollWidth - rail.clientWidth - 4;
  });
  buttons.forEach(button => button.addEventListener('click', () => move(Number(button.dataset.railDirection))));
  rail.addEventListener('scroll', update, {passive: true});
  new ResizeObserver(update).observe(rail);
  rail.addEventListener('keydown', event => {
    if (event.target !== rail) return;
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault(); move(event.key === 'ArrowRight' ? 1 : -1);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault(); rail.scrollTo({left: event.key === 'Home' ? 0 : rail.scrollWidth, behavior: scrollBehavior()});
    }
  });
  let startX = 0, startScroll = 0, pointer: number | undefined, dragging = false, suppressClick = false;
  rail.addEventListener('pointerdown', event => {
    if (event.pointerType !== 'mouse' || event.button !== 0) return;
    startX = event.clientX; startScroll = rail.scrollLeft; pointer = event.pointerId; dragging = false; suppressClick = false;
  });
  rail.addEventListener('pointermove', event => {
    if (event.pointerId !== pointer || event.buttons !== 1) return;
    if (!dragging && Math.abs(event.clientX - startX) > 6) {
      dragging = true; suppressClick = true; rail.setPointerCapture(event.pointerId); rail.classList.add('is-dragging');
    }
    if (dragging) { event.preventDefault(); rail.scrollLeft = startScroll - (event.clientX - startX); }
  });
  const finish = () => { pointer = undefined; dragging = false; rail.classList.remove('is-dragging'); };
  rail.addEventListener('pointerup', finish);
  rail.addEventListener('pointercancel', finish);
  rail.addEventListener('lostpointercapture', finish);
  rail.addEventListener('dragstart', event => event.preventDefault());
  rail.addEventListener('click', event => { if (suppressClick) { event.preventDefault(); event.stopPropagation(); suppressClick = false; } }, true);
  update();
});

document.querySelectorAll<HTMLButtonElement>('[data-motion-toggle]').forEach(button => {
  button.addEventListener('click', () => {
    const paused = document.documentElement.classList.toggle('motion-paused');
    button.textContent = paused ? '動きを再開' : '動きを止める';
    button.setAttribute('aria-pressed', String(paused));
  });
});

document.querySelectorAll<HTMLImageElement>('.article-media img').forEach(img => {
  const fallback = () => {
    img.hidden = true;
    img.closest('.article-card')?.classList.remove('has-thumbnail');
    const placeholder = img.parentElement?.querySelector<HTMLElement>('.thumbnail-placeholder');
    if (placeholder) placeholder.hidden = false;
  };
  img.addEventListener('error', fallback, {once: true});
  if (img.complete && !img.naturalWidth) fallback();
});
