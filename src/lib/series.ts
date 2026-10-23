import type { Series } from './articles';

// Colors live once in styles/cards.css; these keys connect every view to that palette.
export const SERIES_DISPLAY: Record<Series, { key: string; label: string }> = {
  '成長日記': { key: 'growth', label: 'ぷゆんの成長日記' },
  'となりのnote': { key: 'neighbor', label: 'となりのnote' },
  'ぷゆんの道草': { key: 'michikusa', label: 'ぷゆんの道草' },
  'ぷゆん速報': { key: 'news', label: 'ぷゆん速報' },
  'DEV': { key: 'dev', label: 'DEV' },
  'その他': { key: 'other', label: 'その他' },
};
