// note と DEV の公開済み記事を取り込み、src/data/articles.json にマージして保存する。
// 実行: npm run sync
// 保存するのは title / url / platform / series / publishedAt / hidden だけ（本文・抜粋・画像は保存しない）。

import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';

const OUTPUT = new URL('../src/data/articles.json', import.meta.url);
const TIMEOUT_MS = 20_000;

const NOTE_RSS = 'https://note.com/puyun_days/rss';
// note のマガジン RSS（このマガジンに入っている記事を、そのシリーズとして扱う）
const NOTE_MAGAZINES = [
  { series: '成長日記', rss: 'https://note.com/puyun_days/m/m00861b751170/rss' },
  { series: 'となりのnote', rss: 'https://note.com/puyun_days/m/mfbcd61c3df53/rss' },
];
// マガジン RSS で判定できなかった note 記事は、タイトルの文字列で判定する
const TITLE_RULES = [
  { series: '成長日記', includes: '成長日記' },
  { series: 'となりのnote', includes: 'となりのnote' },
  { series: 'ぷゆん速報', includes: 'ぷゆん速報' },
];
const DEV_API = 'https://dev.to/api/articles?username=puyun_days&per_page=100';

const SERIES = ['成長日記', 'となりのnote', 'ぷゆん速報', 'DEV', 'その他'];
const PLATFORMS = ['note', 'dev'];

async function fetchText(url) {
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': 'puyun-days-sync (+https://mori-ikuri.github.io/puyun-days/)' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(`${url} に接続できませんでした (${e.cause?.code ?? e.name})`);
  }
  if (!res.ok) throw new Error(`${url} の取得に失敗しました (HTTP ${res.status})`);
  return res.text();
}

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function readTag(xml, name) {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  if (!m) return undefined;
  const cdata = m[1].match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return (cdata ? cdata[1] : decodeEntities(m[1])).trim();
}

// RSS の <item> から title / link / pubDate だけを取り出す
function parseRss(xml, source) {
  if (!/<rss[\s>]/.test(xml) || !/<channel[\s>]/.test(xml)) {
    throw new Error(`${source} が RSS の形式ではありません`);
  }
  const items = [...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/g)].map((m) => m[1]);
  return items.map((item) => ({
    title: readTag(item, 'title'),
    url: readTag(item, 'link'),
    publishedAt: toIso(readTag(item, 'pubDate'), source),
  }));
}

function toIso(value, source) {
  const d = new Date(value ?? '');
  if (Number.isNaN(d.getTime())) throw new Error(`${source} に読めない日付があります: ${value}`);
  return d.toISOString();
}

function normalizeUrl(url) {
  return url.trim().replace(/\/+$/, '');
}

async function fetchNote() {
  const all = parseRss(await fetchText(NOTE_RSS), NOTE_RSS);

  const seriesByUrl = new Map();
  for (const mag of NOTE_MAGAZINES) {
    for (const item of parseRss(await fetchText(mag.rss), mag.rss)) {
      seriesByUrl.set(normalizeUrl(item.url ?? ''), mag.series);
    }
  }

  return all.map((item) => ({
    ...item,
    platform: 'note',
    magazineSeries: seriesByUrl.get(normalizeUrl(item.url ?? '')),
  }));
}

async function fetchDev() {
  const articles = [];
  for (let page = 1; ; page++) {
    const text = await fetchText(`${DEV_API}&page=${page}`);
    let list;
    try {
      list = JSON.parse(text);
    } catch {
      throw new Error(`DEV API の応答が JSON ではありません (page ${page})`);
    }
    if (!Array.isArray(list)) throw new Error(`DEV API の応答が配列ではありません (page ${page})`);
    if (list.length === 0) break;
    for (const a of list) {
      articles.push({
        title: a.title,
        url: a.url,
        publishedAt: toIso(a.published_at, 'DEV API'),
        platform: 'dev',
      });
    }
    if (list.length < 100) break;
  }
  return articles;
}

function seriesByTitle(title) {
  return TITLE_RULES.find((r) => title.includes(r.includes))?.series;
}

function decideSeries(fetched, existing) {
  if (fetched.platform === 'dev') return 'DEV';
  if (fetched.magazineSeries) return fetched.magazineSeries;
  // マガジン RSS が最新分しか返さない場合に備え、以前に判定済みのシリーズは維持する
  if (existing && existing.series !== 'その他') return existing.series;
  return seriesByTitle(fetched.title) ?? 'その他';
}

function validateArticle(a) {
  const problems = [];
  if (typeof a.title !== 'string' || a.title === '') problems.push('title');
  if (typeof a.url !== 'string' || !/^https:\/\/(note\.com|dev\.to)\//.test(a.url)) problems.push('url');
  if (!PLATFORMS.includes(a.platform)) problems.push('platform');
  if (!SERIES.includes(a.series)) problems.push('series');
  if (typeof a.publishedAt !== 'string' || Number.isNaN(Date.parse(a.publishedAt))) problems.push('publishedAt');
  if (typeof a.hidden !== 'boolean') problems.push('hidden');
  if (problems.length) throw new Error(`不正な記事データです (${problems.join(', ')}): ${JSON.stringify(a)}`);
}

async function readExisting() {
  let text;
  try {
    text = await readFile(OUTPUT, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('既存の src/data/articles.json が JSON として読めません。手で直してから再実行してください');
  }
  if (!Array.isArray(data)) throw new Error('既存の src/data/articles.json が配列ではありません');
  data.forEach(validateArticle);
  return data;
}

async function main() {
  const existing = await readExisting();
  const byUrl = new Map(existing.map((a) => [normalizeUrl(a.url), a]));

  // どちらかの取得に失敗したら、ここで例外になり何も書き込まない
  const fetched = [...(await fetchNote()), ...(await fetchDev())];

  let added = 0;
  for (const f of fetched) {
    const key = normalizeUrl(f.url ?? '');
    const old = byUrl.get(key);
    const article = {
      title: f.title,
      url: f.url,
      platform: f.platform,
      series: decideSeries(f, old),
      publishedAt: f.publishedAt,
      hidden: old ? old.hidden : false, // hidden は手で付ける項目なので引き継ぐ
    };
    validateArticle(article);
    if (!old) added++;
    byUrl.set(key, article);
  }

  // 取り込み元に無くなった既存記事も消さずに残す
  const merged = [...byUrl.values()].sort(
    (a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt) || a.url.localeCompare(b.url),
  );

  const json = `${JSON.stringify(merged, null, 2)}\n`;
  const tmp = new URL('../src/data/articles.json.tmp', import.meta.url);
  await mkdir(new URL('.', OUTPUT), { recursive: true });
  await writeFile(tmp, json, 'utf8');
  await rename(tmp, OUTPUT);

  const count = (key) =>
    Object.entries(Object.groupBy(merged, (a) => a[key])).map(([k, v]) => `${k}: ${v.length}`).join(', ');
  console.log(`取り込み完了: 取得 ${fetched.length} 件 / 新規 ${added} 件 / 合計 ${merged.length} 件`);
  console.log(`  媒体別   ${count('platform')}`);
  console.log(`  シリーズ別 ${count('series')}`);
}

main().catch((e) => {
  console.error(`取り込みに失敗しました。src/data/articles.json は変更していません。\n理由: ${e.message}`);
  process.exit(1);
});
