import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { SERIES, decideSeries, normalizeUrl, validateOverrides } from './article-classification.mjs';
import { fetchBounded, syncThumbnail, validateRights, validThumbnail } from './thumbnail-sync.mjs';

export const NOTE_RSS = 'https://note.com/puyun_days/rss';
export const NOTE_MAGAZINES = [
  { series: '成長日記', rss: 'https://note.com/puyun_days/m/m00861b751170/rss' },
  { series: 'となりのnote', rss: 'https://note.com/puyun_days/m/mfbcd61c3df53/rss' },
];
export const DEV_API = 'https://dev.to/api/articles?username=puyun_days&per_page=100';
const FEED_HOSTS = new Set(['note.com', 'dev.to']);

export function decodeEntities(text) {
  return text.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

export function readTag(xml, name) {
  const match = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  if (!match) return undefined;
  const cdata = match[1].match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return (cdata ? cdata[1] : decodeEntities(match[1])).trim();
}

function attribute(tag, name) {
  const match = tag?.match(new RegExp(`\\s${name}\\s*=\\s*(["'])(.*?)\\1`, 'i'));
  return match ? decodeEntities(match[2]).trim() : undefined;
}

export function rssThumbnail(item) {
  const media = item.match(/<media:thumbnail(?:\s[^>]*)?\/?\s*>/i)?.[0];
  const source = attribute(media, 'url') || readTag(item, 'media:thumbnail');
  if (source) return source;
  for (const [tag] of item.matchAll(/<enclosure\s[^>]*\/?\s*>/gi)) {
    if (/^image\/(png|jpeg|webp)$/i.test(attribute(tag, 'type') ?? '')) return attribute(tag, 'url');
  }
  return undefined;
}

export function toIso(value, source) {
  const date = new Date(value ?? '');
  if (Number.isNaN(date.getTime())) throw new Error(`${source} に読めない日付があります`);
  return date.toISOString();
}

export function parseRss(xml, source = 'RSS') {
  if (!/<rss[\s>]/.test(xml) || !/<channel[\s>]/.test(xml) || !/<\/channel>\s*<\/rss>\s*$/.test(xml) || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error(`${source} が RSS の形式ではありません`);
  return [...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/g)].map(([, item]) => ({
    title: readTag(item, 'title'), url: readTag(item, 'link'), publishedAt: toIso(readTag(item, 'pubDate'), source), thumbnailSource: rssThumbnail(item),
  }));
}

export function parseDev(text) {
  const list = JSON.parse(text);
  if (!Array.isArray(list)) throw new Error('DEV API の応答が配列ではありません');
  return list.map((article) => ({ title: article.title, url: article.url, publishedAt: toIso(article.published_at, 'DEV API'), platform: 'dev', thumbnailSource: typeof article.cover_image === 'string' ? article.cover_image : undefined }));
}

async function fetchText(url, fetchImpl) {
  const { bytes } = await fetchBounded(url, { fetchImpl, hosts: FEED_HOSTS, maxBytes: 4 * 1024 * 1024 });
  return bytes.toString('utf8');
}

// マガジンも画像候補の供給元にする。掲載されない既存記事を削除しない。
export async function fetchSources(fetchImpl = fetch) {
  const note = parseRss(await fetchText(NOTE_RSS, fetchImpl), NOTE_RSS);
  const seriesByUrl = new Map();
  const candidates = new Map(note.map((item) => [normalizeUrl(item.url), item.thumbnailSource]));
  for (const magazine of NOTE_MAGAZINES) {
    for (const item of parseRss(await fetchText(magazine.rss, fetchImpl), magazine.rss)) {
      seriesByUrl.set(normalizeUrl(item.url), magazine.series);
      if (!candidates.get(normalizeUrl(item.url))) candidates.set(normalizeUrl(item.url), item.thumbnailSource);
    }
  }
  const dev = [];
  for (let page = 1; page <= 100; page++) {
    const list = parseDev(await fetchText(`${DEV_API}&page=${page}`, fetchImpl));
    dev.push(...list);
    for (const item of list) candidates.set(normalizeUrl(item.url), item.thumbnailSource);
    if (list.length < 100) break;
    if (page === 100) throw new Error('DEV API のページ数が上限を超えています');
  }
  return { fetched: [...note.map((item) => ({ ...item, platform: 'note', magazineSeries: seriesByUrl.get(normalizeUrl(item.url)) })), ...dev], candidates };
}

export function validateArticle(article) {
  const problems = [];
  if (typeof article.title !== 'string' || !article.title.trim()) problems.push('title');
  const pattern = article.platform === 'note' ? /^https:\/\/note\.com\/puyun_days\/n\/[a-zA-Z0-9_-]+\/?$/ : /^https:\/\/dev\.to\/puyun_days\/[a-zA-Z0-9_-]+\/?$/;
  if (typeof article.url !== 'string' || !pattern.test(article.url)) problems.push('url');
  if (!['note', 'dev'].includes(article.platform)) problems.push('platform');
  if (!SERIES.includes(article.series)) problems.push('series');
  if (typeof article.publishedAt !== 'string' || Number.isNaN(Date.parse(article.publishedAt))) problems.push('publishedAt');
  if (typeof article.hidden !== 'boolean') problems.push('hidden');
  if (problems.length) throw new Error(`不正な記事データです (${problems.join(', ')}): ${article.url}`);
}

export function mergeArticles(existing, fetched, overrides = {}) {
  validateOverrides(overrides);
  existing.forEach(validateArticle);
  const byUrl = new Map(existing.map((article) => [normalizeUrl(article.url), { ...article, series: decideSeries(article, article, overrides) }]));
  if (byUrl.size !== existing.length) throw new Error('既存記事の URL が重複しています');
  for (const item of fetched) {
    const key = normalizeUrl(item.url);
    const old = byUrl.get(key);
    const article = { title: item.title, url: item.url, platform: item.platform, series: decideSeries(item, old, overrides), publishedAt: item.publishedAt, hidden: old?.hidden ?? false };
    if (old?.thumbnail) article.thumbnail = old.thumbnail;
    validateArticle(article);
    byUrl.set(key, article);
  }
  return [...byUrl.values()].sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt) || a.url.localeCompare(b.url));
}

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
}

export async function runSync({ rootDir, fetchImpl = fetch, onWarning = console.warn } = {}) {
  const dataDir = join(rootDir, 'src/data');
  const output = join(dataDir, 'articles.json');
  const existing = await readJson(output, []);
  if (!Array.isArray(existing)) throw new Error('既存記事は配列にしてください');
  const overrides = await readJson(join(dataDir, 'article-series-overrides.json'));
  const rights = await readJson(join(dataDir, 'thumbnail-rights.json'));
  validateOverrides(overrides); validateRights(rights); existing.forEach(validateArticle);
  // 全 feed が取得・検証できるまでは記事も画像も書かない。
  const { fetched, candidates } = await fetchSources(fetchImpl);
  const merged = mergeArticles(existing, fetched, overrides);
  for (const article of merged) {
    const old = article.thumbnail;
    // 明示的な「画像なし」は旧画像を継続しない。feed掲載外だけ承認済み旧 URL を再検証する。
    const key = normalizeUrl(article.url);
    const source = candidates.has(key) ? candidates.get(key) : validThumbnail(old, article.url, rights) ? old.sourceUrl : undefined;
    delete article.thumbnail;
    if (!article.hidden) {
      const thumbnail = await syncThumbnail(article, source, rights, { publicDir: join(rootDir, 'public'), fetchImpl, onWarning, previousThumbnail: old });
      if (thumbnail) article.thumbnail = thumbnail;
    }
  }
  await mkdir(dataDir, { recursive: true });
  await writeFile(`${output}.tmp`, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  await rename(`${output}.tmp`, output);
  return { fetched: fetched.length, total: merged.length, added: merged.length - existing.length, thumbnails: merged.filter((a) => a.thumbnail).length };
}
