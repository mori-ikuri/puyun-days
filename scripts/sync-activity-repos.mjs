// src/data/activities.json に書かれた repo の「最終更新日時」を GitHub の公開 API から取得し、
// src/data/activity-repos.json に保存する。activities.json は読むだけで、絶対に書き換えない。
// 実行: npm run sync（記事の取り込みと一緒に動く）/ npm run sync:repos（これだけ）
//
// 最終更新日時 = デフォルトブランチで、bot 以外が作った一番新しいコミットの日時。
// pushed_at を使うと、毎朝の自動取り込みの bot コミットで日付が毎日動き、
// それを保存する bot コミットがまた日付を動かす…というループになるため。

import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';

const ACTIVITIES = new URL('../src/data/activities.json', import.meta.url);
const OUTPUT = new URL('../src/data/activity-repos.json', import.meta.url);
const TIMEOUT_MS = 20_000;
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

async function fetchJson(url) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'puyun-days-sync (+https://mori-ikuri.github.io/puyun-days/)',
  };
  // GitHub Actions では GITHUB_TOKEN を使って API の回数制限を緩める（ローカルでは無くても動く）
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  let res;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    throw new Error(`${url} に接続できませんでした (${e.cause?.code ?? e.name})`);
  }
  if (!res.ok) throw new Error(`${url} の取得に失敗しました (HTTP ${res.status})`);
  try {
    return await res.json();
  } catch {
    throw new Error(`${url} の応答が JSON ではありません`);
  }
}

async function readRepos() {
  let data;
  try {
    data = JSON.parse(await readFile(ACTIVITIES, 'utf8'));
  } catch (e) {
    throw new Error(`src/data/activities.json が読めません (${e.message})`);
  }
  if (!Array.isArray(data?.activities)) throw new Error('src/data/activities.json に activities の配列がありません');
  const repos = data.activities.map((a) => a.repo).filter((r) => r !== undefined);
  for (const repo of repos) {
    if (typeof repo !== 'string' || !REPO_PATTERN.test(repo)) {
      throw new Error(`activities.json の repo の形式が正しくありません ("owner/name" の形にする): ${JSON.stringify(repo)}`);
    }
  }
  return [...new Set(repos)].sort();
}

async function lastHumanCommitAt(repo) {
  const commits = await fetchJson(`https://api.github.com/repos/${repo}/commits?per_page=100`);
  if (!Array.isArray(commits)) throw new Error(`${repo} のコミット一覧が配列ではありません`);
  const human = commits.find((c) => c.author?.type !== 'Bot');
  if (!human) {
    console.warn(`  注意: ${repo} の直近100コミットがすべて bot のため、日付は記録しません`);
    return null;
  }
  const date = human.commit?.committer?.date;
  if (Number.isNaN(Date.parse(date ?? ''))) throw new Error(`${repo} のコミット日時が読めません: ${date}`);
  return new Date(date).toISOString();
}

async function main() {
  const repos = await readRepos();

  // 1件でも失敗したら、ここで例外になり何も書き込まない
  const result = {};
  for (const repo of repos) {
    result[repo] = { lastCommitAt: await lastHumanCommitAt(repo) };
  }

  const json = `${JSON.stringify(result, null, 2)}\n`;
  const tmp = new URL('../src/data/activity-repos.json.tmp', import.meta.url);
  await mkdir(new URL('.', OUTPUT), { recursive: true });
  await writeFile(tmp, json, 'utf8');
  await rename(tmp, OUTPUT);

  console.log(`リポジトリ情報の取得完了: ${repos.length} 件`);
  for (const [repo, info] of Object.entries(result)) console.log(`  ${repo}: ${info.lastCommitAt ?? '(なし)'}`);
}

main().catch((e) => {
  console.error(`リポジトリ情報の取得に失敗しました。src/data/activity-repos.json は変更していません。\n理由: ${e.message}`);
  process.exit(1);
});
