// Astroはpublicの全ファイルをコピーするため、未承認の残存画像もbuild前に止める。
// 画像を削除・変更しない。確認または手動整理後に再実行する。
import { readFile, readdir, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { THUMBNAIL_PATH, validateRights, identifyImage } from './thumbnail-sync.mjs';

export async function verifyPublicAssets(rootDir) {
  const rights = JSON.parse(await readFile(join(rootDir, 'src/data/thumbnail-rights.json'), 'utf8'));
  validateRights(rights);
  const directory = join(rootDir, 'public/images/article-thumbnails');
  let names;
  try { names = await readdir(directory); } catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
  for (const name of names) {
    const relative = `images/article-thumbnails/${name}`;
    const match = THUMBNAIL_PATH.exec(relative);
    const file = join(directory, name);
    const stat = await lstat(file);
    if (!match || !stat.isFile() || stat.isSymbolicLink()) throw new Error(`サムネイル保存先に未確認のファイルがあります: ${name}`);
    const bytes = await readFile(file);
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (hash !== match[1] || !rights.approved.some((entry) => entry.sha256 === hash)) throw new Error(`未承認または変更されたサムネイルです: ${name}`);
    identifyImage(bytes, { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' }[match[2]]);
  }
  return names.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyPublicAssets(fileURLToPath(new URL('..', import.meta.url))).then((count) => {
    console.log(`公開サムネイル確認: ${count} 件（通信・削除なし）`);
  }).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
