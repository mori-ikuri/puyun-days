// 自動分類と手動指定を分離する。手動指定は article-series-overrides.json の URL → series。
export const SERIES = ['成長日記', 'となりのnote', 'ぷゆんの道草', 'ぷゆん速報', 'DEV', 'その他'];
const MAGAZINES = new Set(['成長日記', 'となりのnote']);
const TITLE_RULES = [
  { series: '成長日記', includes: '成長日記' },
  { series: 'となりのnote', includes: 'となりのnote' },
  { series: 'ぷゆん速報', includes: 'ぷゆん速報' },
];

export function normalizeUrl(url) {
  return String(url ?? '').trim().replace(/\/+$/, '');
}

export function isExplicitMichikusaTitle(title) {
  const normalized = String(title ?? '').normalize('NFKC').trim();
  const stack = [];
  const pairs = { '】': '【', ']': '[' };
  for (const character of normalized) {
    if (character === '【' || character === '[') stack.push(character);
    else if (Object.hasOwn(pairs, character) && stack.pop() !== pairs[character]) return false;
  }
  if (stack.length) return false;
  return /【\s*(?:ぷゆんの)?道草\s*#\s*\d+\s*】/u.test(normalized)
    || /\|\s*ぷゆんの道草\s*#\s*\d+\s*$/u.test(normalized);
}

export function seriesByTitle(title) {
  if (isExplicitMichikusaTitle(title)) return 'ぷゆんの道草';
  return TITLE_RULES.find((rule) => String(title ?? '').includes(rule.includes))?.series;
}

export function validateOverrides(overrides) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw new Error('分類の手動指定は URL → series の object にしてください');
  for (const [url, series] of Object.entries(overrides)) {
    if (!/^https:\/\/(note\.com|dev\.to)\/puyun_days\//.test(url) || normalizeUrl(url) !== url || !SERIES.includes(series)) {
      throw new Error(`分類の手動指定が不正です: ${url}`);
    }
  }
}

export function decideSeries(fetched, existing, manualOverrides = {}) {
  const key = normalizeUrl(fetched.url);
  if (Object.hasOwn(manualOverrides, key)) {
    if (!SERIES.includes(manualOverrides[key])) throw new Error(`未登録の手動分類です: ${manualOverrides[key]}`);
    return manualOverrides[key]; // その他・DEV の明示指定も優先。
  }
  if (fetched.platform === 'dev') return 'DEV';
  if (MAGAZINES.has(fetched.magazineSeries)) return fetched.magazineSeries;
  // RSS の掲載範囲から外れた記事の既存分類は消さない。
  if (existing && existing.series !== 'その他') return existing.series;
  return seriesByTitle(fetched.title) ?? 'その他';
}
