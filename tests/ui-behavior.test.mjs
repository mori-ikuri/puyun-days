import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';

// Execute the actual browser script; only the DOM/media-query boundary is stubbed.
// Layout, real focus and pointer behavior are checked separately in the browser.
const source = readFileSync(new URL('../src/scripts/site.ts', import.meta.url), 'utf8');
const javascript = transformSync(source, { loader: 'ts', target: 'es2022' }).code;

class Element {
  constructor(dataset = {}) {
    this.dataset = dataset;
    this.listeners = new Map();
    this.attributes = new Map();
    this.disabled = false;
    this.textContent = '';
    const classes = new Set();
    this.classList = {
      add: (name) => classes.add(name), remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
      toggle: (name) => { if (classes.has(name)) { classes.delete(name); return false; } classes.add(name); return true; },
    };
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  setAttribute(name, value) { this.attributes.set(name, value); }
  getAttribute(name) { return this.attributes.get(name); }
  dispatch(type, properties = {}) {
    const event = { target: this, defaultPrevented: false, propagationStopped: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.propagationStopped = true; }, ...properties };
    for (const listener of this.listeners.get(type) ?? []) listener(event);
    return event;
  }
  click() { if (!this.disabled) return this.dispatch('click'); }
}

function fixture({ reduced = false, hasRail = true, cardWidth = 320, gap = '18px' } = {}) {
  const root = new Element();
  const motion = new Element();
  motion.textContent = '動きを止める';
  motion.setAttribute('aria-pressed', 'false');
  const previous = new Element({ railDirection: '-1' });
  const next = new Element({ railDirection: '1' });
  const card = new Element();
  card.getBoundingClientRect = () => ({ width: cardWidth });
  const rail = new Element();
  rail.clientWidth = 1000; rail.scrollWidth = 2400; rail.scrollLeft = 0;
  rail.querySelector = (selector) => selector === '.article-card' ? card : null;
  rail.calls = [];
  const scroll = (kind, options) => {
    rail.calls.push({ kind, left: options.left, behavior: options.behavior });
    rail.scrollLeft = Math.min(Math.max(kind === 'by' ? rail.scrollLeft + options.left : options.left, 0), rail.scrollWidth - rail.clientWidth);
    rail.dispatch('scroll');
  };
  rail.scrollBy = (options) => scroll('by', options);
  rail.scrollTo = (options) => scroll('to', options);
  const media = { matches: reduced };
  let resize;
  const document = {
    documentElement: root,
    querySelectorAll: (selector) => ({ '.article-rail': hasRail ? [rail] : [], '[data-rail-direction]': hasRail ? [previous, next] : [], '[data-motion-toggle]': [motion] }[selector] ?? []),
    querySelector: () => null,
  };
  vm.runInNewContext(javascript, {
    document,
    matchMedia: (query) => { assert.equal(query, '(prefers-reduced-motion: reduce)'); return media; },
    getComputedStyle: () => ({ columnGap: gap }),
    ResizeObserver: class { constructor(callback) { resize = callback; } observe(element) { assert.equal(element, rail); } },
  }, { filename: 'site.ts (actual transpiled implementation)' });
  return { root, motion, previous, next, card, rail, media, resize: () => resize?.() };
}

test('article rail buttons advance one actual card plus gap and update disabled state', () => {
  const f = fixture();
  assert.equal(f.previous.disabled, true); assert.equal(f.next.disabled, false);
  f.next.click();
  assert.deepEqual(f.rail.calls.at(-1), { kind: 'by', left: 338, behavior: 'smooth' });
  assert.equal(f.previous.disabled, false);
  f.previous.click();
  assert.deepEqual(f.rail.calls.at(-1), { kind: 'by', left: -338, behavior: 'smooth' });
  assert.equal(f.previous.disabled, true);
});

test('reduced motion makes both rail buttons use instant scroll', () => {
  const f = fixture({ reduced: true });
  f.next.click(); f.previous.click();
  assert.deepEqual(f.rail.calls.map((call) => call.behavior), ['instant', 'instant']);
});

test('Arrow keys advance rail and Home/End navigate to bounds with instant reduced motion', () => {
  const f = fixture({ reduced: true });
  for (const key of ['ArrowRight', 'ArrowLeft', 'End', 'Home']) assert.equal(f.rail.dispatch('keydown', { key }).defaultPrevented, true);
  assert.deepEqual(f.rail.calls, [
    { kind: 'by', left: 338, behavior: 'instant' }, { kind: 'by', left: -338, behavior: 'instant' },
    { kind: 'to', left: 2400, behavior: 'instant' }, { kind: 'to', left: 0, behavior: 'instant' },
  ]);
});

test('rail keyboard handling does not consume keys from child article links or unrelated keys', () => {
  const f = fixture();
  for (const key of ['ArrowRight', 'ArrowLeft', 'Home', 'End']) assert.equal(f.rail.dispatch('keydown', { key, target: f.card }).defaultPrevented, false);
  assert.equal(f.rail.dispatch('keydown', { key: 'Tab' }).defaultPrevented, false);
  assert.equal(f.rail.calls.length, 0);
});

test('manual motion stop updates accessible state and stops smooth scrolling until resumed', () => {
  const f = fixture();
  f.motion.click();
  assert.equal(f.root.classList.contains('motion-paused'), true);
  assert.equal(f.motion.textContent, '動きを再開'); assert.equal(f.motion.getAttribute('aria-pressed'), 'true');
  f.next.click(); assert.equal(f.rail.calls.at(-1).behavior, 'instant');
  f.motion.click();
  assert.equal(f.root.classList.contains('motion-paused'), false);
  assert.equal(f.motion.textContent, '動きを止める'); assert.equal(f.motion.getAttribute('aria-pressed'), 'false');
  f.next.click(); assert.equal(f.rail.calls.at(-1).behavior, 'smooth');
});

test('resuming manually never overrides operating-system reduced motion', () => {
  const f = fixture({ reduced: true });
  f.motion.click(); f.motion.click();
  f.next.click(); f.rail.dispatch('keydown', { key: 'Home' });
  assert.equal(f.root.classList.contains('motion-paused'), false);
  assert.ok(f.rail.calls.every((call) => call.behavior === 'instant'));
});

test('system motion preference changes are respected on the next action', () => {
  const f = fixture();
  f.next.click(); f.media.matches = true; f.next.click(); f.media.matches = false; f.next.click();
  assert.deepEqual(f.rail.calls.map((call) => call.behavior), ['smooth', 'instant', 'smooth']);
});

test('rail scroll/resize disables controls at both ends and when all cards fit', () => {
  const f = fixture();
  f.rail.dispatch('keydown', { key: 'End' });
  assert.equal(f.next.disabled, true); assert.equal(f.previous.disabled, false);
  f.rail.dispatch('keydown', { key: 'Home' });
  assert.equal(f.previous.disabled, true); assert.equal(f.next.disabled, false);
  f.rail.scrollWidth = f.rail.clientWidth;
  f.resize();
  assert.equal(f.previous.disabled, true); assert.equal(f.next.disabled, true);
});

test('pages without an article rail still support motion controls without errors', () => {
  const f = fixture({ hasRail: false });
  f.motion.click();
  assert.equal(f.root.classList.contains('motion-paused'), true);
});

const css = ['site.css', 'cards.css'].map((name) => readFileSync(new URL(`../src/styles/${name}`, import.meta.url), 'utf8')).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
const rules = (text) => [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({ selectors: selector.trim().split(',').map((value) => value.trim()), body }));
function reduceBlock() {
  const match = /@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)\s*\{/.exec(css);
  assert.ok(match, 'reduced-motion media rule exists');
  const start = match.index + match[0].length;
  let depth = 1, end = start;
  while (depth && end < css.length) { if (css[end] === '{') depth++; else if (css[end] === '}') depth--; end++; }
  assert.equal(depth, 0, 'media rule is closed');
  return css.slice(start, end - 1);
}

test('reduced-motion CSS disables animation and transition for elements and both pseudo-elements', () => {
  const reducedRules = rules(reduceBlock());
  for (const selector of ['*', '*::before', '*::after']) {
    const rule = reducedRules.find((item) => item.selectors.includes(selector));
    assert.ok(rule, `${selector} is covered`);
    assert.match(rule.body, /animation\s*:\s*none\s*!important/);
    assert.match(rule.body, /transition\s*:\s*none\s*!important/);
  }
  assert.match(reducedRules.find((rule) => rule.selectors.includes('html'))?.body ?? '', /scroll-behavior\s*:\s*auto/);
  const animated = rules(css).filter((rule) => /(?:^|;)\s*(?:animation|transition)\s*:(?!\s*none)/.test(rule.body));
  assert.ok(animated.length > 0, 'coverage includes real motion rules');
  // Universal !important rules win over every normal motion declaration in this site.
  for (const rule of animated) assert.doesNotMatch(rule.body, /(?:animation|transition)\s*:[^;}]*!important/, `unexpected override in ${rule.selectors.join(', ')}`);
});

test('manual pause CSS covers element, ::before and ::after animations', () => {
  const paused = rules(css).filter((rule) => /animation-play-state\s*:\s*paused\s*!important/.test(rule.body));
  const covered = new Set(paused.flatMap((rule) => rule.selectors));
  for (const selector of ['.motion-paused *', '.motion-paused *::before', '.motion-paused *::after']) assert.ok(covered.has(selector), selector);
});
