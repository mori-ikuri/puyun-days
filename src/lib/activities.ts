// src/data/activities.json（手書き）と activity-repos.json（npm run sync が作る）を読むだけ。
// activities.json に間違いがあれば、ここで例外を投げてビルドを失敗させる（安全装置）。
import rawActivities from '../data/activities.json';
import rawRepos from '../data/activity-repos.json';

export type Status = 'active' | 'paused' | 'done';

export interface Activity {
  id: string;
  name: string;
  summary: string;
  status: Status;
  updatedAt: string;
  repo?: string;
  link?: string;
}

// ページで見出しを並べる順番
export const STATUS_ORDER: { status: Status; label: string }[] = [
  { status: 'active', label: '進行中' },
  { status: 'paused', label: 'おやすみ中' },
  { status: 'done', label: '完了' },
];

const STATUSES: Status[] = STATUS_ORDER.map((s) => s.status);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
// 公開してはいけない文字列: ローカルパス（例 C:\）とメールアドレスらしきもの
const LOCAL_PATH_PATTERN = /[A-Za-z]:\\/;
const EMAIL_PATTERN = /[^\s@]+@[^\s@]+\.[^\s@]+/;

function isValidDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function validate(data: unknown): { reviewedAt: string; activities: Activity[] } {
  const errors: string[] = [];
  const root = data as { reviewedAt?: unknown; activities?: unknown };

  if (!isValidDate(root?.reviewedAt)) errors.push(`reviewedAt は YYYY-MM-DD の形の日付にしてください: ${JSON.stringify(root?.reviewedAt)}`);
  if (!Array.isArray(root?.activities)) {
    errors.push('activities の配列がありません');
  } else {
    const ids = new Set<string>();
    root.activities.forEach((a: Record<string, unknown>, i: number) => {
      const where = `activities[${i}]${isNonEmptyString(a?.id) ? ` (${a.id})` : ''}`;
      for (const key of ['id', 'name', 'summary']) {
        if (!isNonEmptyString(a?.[key])) errors.push(`${where}: ${key} がありません`);
      }
      if (isNonEmptyString(a?.id)) {
        if (ids.has(a.id)) errors.push(`${where}: id が重複しています`);
        ids.add(a.id);
      }
      if (!STATUSES.includes(a?.status as Status)) errors.push(`${where}: status は ${STATUSES.join(' / ')} のどれかにしてください: ${JSON.stringify(a?.status)}`);
      if (!isValidDate(a?.updatedAt)) errors.push(`${where}: updatedAt は YYYY-MM-DD の形の日付にしてください: ${JSON.stringify(a?.updatedAt)}`);
      if (a?.repo !== undefined && !(typeof a.repo === 'string' && REPO_PATTERN.test(a.repo))) errors.push(`${where}: repo は "owner/name" の形にしてください: ${JSON.stringify(a.repo)}`);
      if (a?.link !== undefined && !(typeof a.link === 'string' && /^https:\/\/\S+$/.test(a.link))) errors.push(`${where}: link は https:// で始まるURLにしてください: ${JSON.stringify(a.link)}`);
      for (const key of ['name', 'summary']) {
        const text = a?.[key];
        if (typeof text !== 'string') continue;
        if (LOCAL_PATH_PATTERN.test(text)) errors.push(`${where}: ${key} にローカルパスのような文字列があります`);
        if (EMAIL_PATTERN.test(text)) errors.push(`${where}: ${key} にメールアドレスのような文字列があります`);
      }
    });
  }

  if (errors.length > 0) {
    throw new Error(`src/data/activities.json に問題があります:\n- ${errors.join('\n- ')}`);
  }
  return root as { reviewedAt: string; activities: Activity[] };
}

const { reviewedAt, activities } = validate(rawActivities);
const repos = rawRepos as Record<string, { lastCommitAt: string | null }>;

export { reviewedAt };

// ISO 日時を日本時間の YYYY-MM-DD にする
const jstDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

// 表示する最終更新日 = updatedAt とリポジトリの最終更新日の新しいほう（YYYY-MM-DD）
export function lastUpdated(activity: Activity): string {
  const commitAt = activity.repo ? repos[activity.repo]?.lastCommitAt : null;
  const repoDate = commitAt ? jstDate.format(new Date(commitAt)) : null;
  return repoDate && repoDate > activity.updatedAt ? repoDate : activity.updatedAt;
}

// YYYY-MM-DD → 2026/10/08（記事一覧と同じ見た目）
export function formatDay(day: string): string {
  return day.replaceAll('-', '/');
}

export function activitiesByStatus(): { label: string; items: Activity[] }[] {
  return STATUS_ORDER.map(({ status, label }) => ({
    label,
    items: activities
      .filter((a) => a.status === status)
      .sort((a, b) => lastUpdated(b).localeCompare(lastUpdated(a)) || a.name.localeCompare(b.name)),
  })).filter((group) => group.items.length > 0);
}
