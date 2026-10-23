// 更新時だけ外部通信する。通常の build はローカル JSON と画像だけを読む。
import { fileURLToPath } from 'node:url';
import { runSync } from './article-sync-core.mjs';

runSync({ rootDir: fileURLToPath(new URL('..', import.meta.url)) }).then((result) => {
  console.log(`取り込み完了: 取得 ${result.fetched} 件 / 新規 ${result.added} 件 / 合計 ${result.total} 件 / 確認済みサムネイル ${result.thumbnails} 件`);
}).catch((error) => {
  console.error(`取り込みに失敗しました。articles.json は変更していません。\n理由: ${error.message}`);
  process.exitCode = 1;
});
