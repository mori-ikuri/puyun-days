import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const IMAGE_HOSTS = new Set(['assets.st-note.com', 'media2.dev.to', 'media.dev.to', 'dev-to-uploads.s3.amazonaws.com', 'dev-to-uploads.s3.us-east-2.amazonaws.com']);
export const THUMBNAIL_PATH = /^images\/article-thumbnails\/([a-f0-9]{64})\.(png|jpg|webp)$/;
const USER_AGENT = 'puyun-days-sync (+https://mori-ikuri.github.io/puyun-days/)';

export function validateRemoteUrl(input, hosts = IMAGE_HOSTS) {
  let url;
  try { url = new URL(input); } catch { throw new Error('画像 URL が不正です'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || !hosts.has(url.hostname)) {
    throw new Error('許可されていない URL です');
  }
  return url.href;
}

// 自動 redirect に任せず全 hop を検査。ストリームも上限以内でのみ読み込む。
export async function fetchBounded(input, { fetchImpl = fetch, hosts = IMAGE_HOSTS, maxBytes = MAX_IMAGE_BYTES } = {}) {
  let url = validateRemoteUrl(input, hosts);
  const signal = AbortSignal.timeout(20_000);
  for (let redirects = 0; redirects <= 3; redirects++) {
    let response;
    try {
      response = await fetchImpl(url, { redirect: 'manual', signal, headers: { 'User-Agent': USER_AGENT } });
    } catch (cause) {
      throw Object.assign(new Error('取得先に一時的に接続できませんでした', { cause }), { transient: true });
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || redirects === 3) throw new Error('redirect の上限または移動先が不正です');
      url = validateRemoteUrl(new URL(location, url).href, hosts);
      continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw Object.assign(new Error(`HTTP ${response.status}`), { transient: response.status >= 500 || response.status === 429 }); }
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
      await response.body?.cancel(); throw new Error('データのサイズが上限を超えています');
    }
    if (!response.body) throw new Error('空の応答です');
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > maxBytes) throw new Error('データのサイズが上限を超えています');
      chunks.push(Buffer.from(chunk));
    }
    if (!size) throw new Error('空の応答です');
    return { bytes: Buffer.concat(chunks), contentType: (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase(), finalUrl: url };
  }
  throw new Error('redirect の上限です');
}

export function identifyImage(bytes, contentType) {
  let extension;
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString('ascii', 12, 16) === 'IHDR') extension = 'png';
  else if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes.at(-2) === 255 && bytes.at(-1) === 217) extension = 'jpg';
  else if (bytes.length >= 16 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' && bytes.readUInt32LE(4) + 8 === bytes.length) extension = 'webp';
  if (!extension || contentType !== { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' }[extension]) throw new Error('画像の MIME と実体が一致しません（PNG/JPEG/WebP のみ）');
  return extension;
}

export function validateRights(manifest) {
  if (manifest?.version !== 1 || !Array.isArray(manifest.approved)) throw new Error('thumbnail-rights.json の形式が不正です');
  const seen = new Set();
  for (const entry of manifest.approved) {
    if (!entry || !/^https:\/\/(note\.com|dev\.to)\/puyun_days\//.test(entry.articleUrl ?? '') || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? '') || typeof entry.basis !== 'string' || !entry.basis.trim()) throw new Error('権利確認には記事 URL・画像 URL・SHA256・確認根拠が必要です');
    validateRemoteUrl(entry.sourceUrl);
    const key = `${entry.articleUrl}\n${entry.sourceUrl}`;
    if (seen.has(key)) throw new Error('権利確認の記録が重複しています');
    seen.add(key);
  }
}

export function approvedEntry(articleUrl, sourceUrl, manifest) {
  return manifest.approved.find((entry) => entry.articleUrl === articleUrl && entry.sourceUrl === sourceUrl);
}

export function validThumbnail(thumbnail, articleUrl, manifest) {
  if (!thumbnail || !THUMBNAIL_PATH.test(thumbnail.path ?? '')) return false;
  const entry = approvedEntry(articleUrl, thumbnail.sourceUrl, manifest);
  return Boolean(entry && entry.sha256 === thumbnail.sha256 && THUMBNAIL_PATH.exec(thumbnail.path)[1] === entry.sha256);
}

// 許諾未確認の画像は取得しない。URLまたはbytesが変われば未確認に戻す。
export async function syncThumbnail(article, sourceUrl, manifest, { publicDir, fetchImpl = fetch, onWarning = () => {}, previousThumbnail = article.thumbnail } = {}) {
  if (!sourceUrl || !approvedEntry(article.url, sourceUrl, manifest)) return undefined;
  try {
    const entry = approvedEntry(article.url, sourceUrl, manifest);
    const result = await fetchBounded(sourceUrl, { fetchImpl });
    const extension = identifyImage(result.bytes, result.contentType);
    const sha256 = createHash('sha256').update(result.bytes).digest('hex');
    if (sha256 !== entry.sha256) throw new Error('画像が権利確認時から変わりました');
    const path = `images/article-thumbnails/${sha256}.${extension}`;
    const target = join(publicDir, path);
    await mkdir(join(publicDir, 'images/article-thumbnails'), { recursive: true });
    let current;
    try { current = await readFile(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!current?.equals(result.bytes)) {
      await writeFile(`${target}.tmp`, result.bytes);
      await rename(`${target}.tmp`, target);
    }
    return { path, sourceUrl, sha256 };
  } catch (error) {
    // 一時通信障害のみ、同じURLに対して承認済みのローカル実体を保持する。
    // hash変更・権利取消・別URL・MIME不一致・404には適用しない。
    if (error.transient && previousThumbnail?.sourceUrl === sourceUrl && validThumbnail(previousThumbnail, article.url, manifest)) {
      try {
        const bytes = await readFile(join(publicDir, previousThumbnail.path));
        if (createHash('sha256').update(bytes).digest('hex') === previousThumbnail.sha256) {
          onWarning(`${article.url}: 一時通信障害のため確認済みローカル画像を保持しました`);
          return previousThumbnail;
        }
      } catch { /* ローカル欠損・破損は fallback。 */ }
    }
    onWarning(`${article.url}: サムネイルは未表示 (${error.message})`);
    return undefined;
  }
}
