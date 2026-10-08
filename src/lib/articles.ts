// src/data/articles.json を読むだけ（ネットにはアクセスしない）。更新は `npm run sync` で行う。
import data from '../data/articles.json';

export type Platform = 'note' | 'dev';
export type Series = '成長日記' | 'となりのnote' | 'ぷゆん速報' | 'DEV' | 'その他';

export interface Article {
  title: string;
  url: string;
  platform: Platform;
  series: Series;
  publishedAt: string;
  hidden: boolean;
}

// 一覧ページで見出しを並べる順番
export const SERIES_ORDER: Series[] = ['成長日記', 'となりのnote', 'ぷゆん速報', 'DEV', 'その他'];

export const PLATFORM_LABEL: Record<Platform, string> = {
  note: 'note',
  dev: 'DEV',
};

// hidden: true を除き、新しい順に並べた記事
export const articles: Article[] = (data as Article[])
  .filter((a) => !a.hidden)
  .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));

export function articlesBySeries(): { series: Series; items: Article[] }[] {
  return SERIES_ORDER.map((series) => ({
    series,
    items: articles.filter((a) => a.series === series),
  })).filter((group) => group.items.length > 0);
}

const dateFormat = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function formatDate(iso: string): string {
  return dateFormat.format(new Date(iso));
}

// サイト内リンクに base（/puyun-days）を付ける。例: withBase('articles/') → /puyun-days/articles/
export function withBase(path: string): string {
  const base = import.meta.env.BASE_URL.replace(/\/+$/, '');
  return `${base}/${path.replace(/^\/+/, '')}`;
}
