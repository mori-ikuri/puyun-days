import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchBounded, identifyImage, syncThumbnail, validateRights, validateRemoteUrl, validThumbnail, MAX_IMAGE_BYTES } from '../scripts/thumbnail-sync.mjs';
import { parseRss, parseDev, rssThumbnail, fetchSources, runSync, NOTE_RSS, NOTE_MAGAZINES, DEV_API } from '../scripts/article-sync-core.mjs';
import { verifyPublicAssets } from '../scripts/verify-public-assets.mjs';

// All responses are in-memory fixtures. Never call global fetch from tests.
const imageUrl = 'https://assets.st-note.com/production/uploads/images/1/test.png';
const articleUrl = 'https://note.com/puyun_days/n/fixture';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5n8AAAAASUVORK5CYII=', 'base64');
const hash = createHash('sha256').update(png).digest('hex');
const rights = { version: 1, approved: [{ articleUrl, sourceUrl: imageUrl, sha256: hash, basis: 'test fixture only' }] };
const oldArticle = { title: '元タイトル', url: articleUrl, platform: 'note', series: 'その他', publishedAt: '2026-10-16T00:00:00.000Z', hidden: false };
const xml = (items = '') => `<rss xmlns:media="http://search.yahoo.com/mrss/"><channel>${items}</channel></rss>`;
const rssItem = (extra = '') => `<item><title><![CDATA[道草【道草#001】]]></title><link>${articleUrl}</link><pubDate>Fri, 16 Oct 2026 00:00:00 GMT</pubDate>${extra}</item>`;
const mockImage = async () => new Response(png, { headers: { 'content-type': 'image/png', 'content-length': String(png.length) } });
function mockSources({ image = false, failDev = false } = {}) {
  const calls = [];
  return { calls, fetchImpl: async (url) => {
    calls.push(url);
    if (url === NOTE_RSS) return new Response(xml(rssItem(image ? `<media:thumbnail>${imageUrl}</media:thumbnail>` : '')));
    if (NOTE_MAGAZINES.some((m) => m.rss === url)) return new Response(xml());
    if (url === `${DEV_API}&page=1`) { if (failDev) throw new Error('fixture outage'); return new Response('[]'); }
    if (url === imageUrl) return mockImage();
    throw new Error(`unexpected fixture request: ${url}`);
  } };
}
async function tempRoot(manifest = rights) {
  const tempBase = process.env.PUYUN_TEST_TMP || tmpdir();
  await mkdir(tempBase, { recursive: true });
  const root = await mkdtemp(join(tempBase, 'puyun-sync-test-'));
  await mkdir(join(root, 'src/data'), { recursive: true });
  await writeFile(join(root, 'src/data/articles.json'), JSON.stringify([oldArticle]));
  await writeFile(join(root, 'src/data/thumbnail-rights.json'), JSON.stringify(manifest));
  await writeFile(join(root, 'src/data/article-series-overrides.json'), '{}');
  return root;
}

test('note RSS media:thumbnail text is decoded', () => assert.equal(parseRss(xml(rssItem(`<media:thumbnail>${imageUrl}?a=1&amp;b=2</media:thumbnail>`)))[0].thumbnailSource, `${imageUrl}?a=1&b=2`));
test('media:thumbnail URL attribute is supported', () => assert.equal(rssThumbnail(`<media:thumbnail url="${imageUrl}" />`), imageUrl));
test('image enclosure is supported', () => assert.equal(rssThumbnail(`<enclosure type='image/png' url='${imageUrl}'/>`), imageUrl));
test('audio enclosure and creatorImage are not article thumbnails', () => assert.equal(rssThumbnail(`<enclosure type="audio/mpeg" url="${imageUrl}"/><note:creatorImage>${imageUrl}</note:creatorImage>`), undefined));
test('truncated or non-RSS responses fail closed', () => { assert.throws(() => parseRss('<html>error</html>')); assert.throws(() => parseRss('<rss><channel>')); });
test('DTD/entity declarations rejected', () => assert.throws(() => parseRss(`<!DOCTYPE rss>${xml()}`)));
test('DEV only uses cover_image, never social/profile image', () => { const data = [{ title: 'DEV', url: 'https://dev.to/puyun_days/fixture', published_at: oldArticle.publishedAt, cover_image: null, social_image: imageUrl, user: { profile_image: imageUrl } }]; assert.equal(parseDev(JSON.stringify(data))[0].thumbnailSource, undefined); data[0].cover_image = imageUrl; assert.equal(parseDev(JSON.stringify(data))[0].thumbnailSource, imageUrl); });
test('magazine supplies older known article thumbnail candidates', async () => { const fixture = mockSources(); const fetchImpl = (url, options) => url === NOTE_MAGAZINES[0].rss ? new Response(xml(rssItem(`<media:thumbnail>${imageUrl}</media:thumbnail>`))) : fixture.fetchImpl(url, options); const result = await fetchSources(fetchImpl); assert.equal(result.candidates.get(articleUrl), imageUrl); assert.equal(result.fetched[0].magazineSeries, '成長日記'); });

for (const url of ['http://assets.st-note.com/a.png', 'https://assets.st-note.com.evil.test/a.png', 'https://127.0.0.1/a.png', 'https://[::1]/a.png', 'https://user:pass@assets.st-note.com/a.png', 'https://assets.st-note.com:8443/a.png', 'file:///tmp/test', 'data:image/png,a']) {
  test(`reject URL ${url}`, () => assert.throws(() => validateRemoteUrl(url)));
}
test('redirect to untrusted host rejected before request', async () => { let calls=0; await assert.rejects(fetchBounded(imageUrl,{fetchImpl:async()=>{calls++;return new Response(null,{status:302,headers:{location:'https://localhost/private'}});}})); assert.equal(calls,1); });
test('HTTPS downgrade rejected', async () => assert.rejects(fetchBounded(imageUrl, { fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'http://assets.st-note.com/a' } }) })));
test('redirect loop bounded to four requests', async () => {let calls=0;await assert.rejects(fetchBounded(imageUrl,{fetchImpl:async()=>{calls++;return new Response(null,{status:302,headers:{location:imageUrl}});}}));assert.equal(calls,4);});
test('allowed redirect works', async () => {let calls=0;const result=await fetchBounded(imageUrl,{fetchImpl:async()=>++calls===1?new Response(null,{status:302,headers:{location:'/second.png'}}):mockImage()});assert.deepEqual(result.bytes,png);assert.equal(result.finalUrl,'https://assets.st-note.com/second.png');});
test('HTTP failure rejected', async () => assert.rejects(fetchBounded(imageUrl,{fetchImpl:async()=>new Response('no',{status:403})})));
test('Content-Length over limit rejected', async () => assert.rejects(fetchBounded(imageUrl,{fetchImpl:async()=>new Response(png,{headers:{'content-length':String(MAX_IMAGE_BYTES+1)}})})));
test('body without Content-Length remains bounded', async () => assert.rejects(fetchBounded(imageUrl,{maxBytes:8,fetchImpl:async()=>new Response(png,{headers:{'content-type':'image/png'}})})));
test('stream is bounded even with false small Content-Length', async () => assert.rejects(fetchBounded(imageUrl,{maxBytes:8,fetchImpl:async()=>new Response(png,{headers:{'content-length':'1'}})})));
test('MIME and bytes must agree', () => {assert.equal(identifyImage(png,'image/png'),'png');assert.throws(()=>identifyImage(png,'image/jpeg'));assert.throws(()=>identifyImage(Buffer.from('<svg/>'),'image/png'));assert.throws(()=>identifyImage(png.subarray(0,8),'image/png'));});
test('JPEG and WebP magic recognized only with matching MIME',()=>{assert.equal(identifyImage(Buffer.from([255,216,255,224,255,217]),'image/jpeg'),'jpg');const webp=Buffer.alloc(20);webp.write('RIFF');webp.writeUInt32LE(12,4);webp.write('WEBP',8);assert.equal(identifyImage(webp,'image/webp'),'webp');});
test('rights need basis, article, source and SHA256',()=>{assert.doesNotThrow(()=>validateRights(rights));for(const key of ['basis','sourceUrl','sha256','articleUrl']){const copy=structuredClone(rights);delete copy.approved[0][key];assert.throws(()=>validateRights(copy));}});
test('duplicate rights rejected',()=>assert.throws(()=>validateRights({...rights,approved:[rights.approved[0],rights.approved[0]]})));
test('unapproved source never fetched',async()=>{let calls=0;assert.equal(await syncThumbnail(oldArticle,imageUrl,{version:1,approved:[]},{fetchImpl:async()=>{calls++;throw new Error('must not fetch');}}),undefined);assert.equal(calls,0);});
test('changed source URL never inherits approval',async()=>assert.equal(await syncThumbnail(oldArticle,imageUrl+'?new=1',rights,{fetchImpl:async()=>{throw new Error('must not fetch');}}),undefined));
test('changed image hash falls back without saving',async()=>{const root=await tempRoot();const changed={...rights,approved:[{...rights.approved[0],sha256:'0'.repeat(64)}]};assert.equal(await syncThumbnail(oldArticle,imageUrl,changed,{publicDir:join(root,'public'),fetchImpl:mockImage}),undefined);await assert.rejects(readFile(join(root,'public/images/article-thumbnails',`${hash}.png`)),{code:'ENOENT'});});
test('approved bytes saved locally with content addressed filename',async()=>{const root=await tempRoot();const thumbnail=await syncThumbnail(oldArticle,imageUrl,rights,{publicDir:join(root,'public'),fetchImpl:mockImage});assert.equal(thumbnail.path,`images/article-thumbnails/${hash}.png`);assert.deepEqual(await readFile(join(root,'public',thumbnail.path)),png);assert.equal(validThumbnail(thumbnail,articleUrl,rights),true);assert.equal(validThumbnail({...thumbnail,path:'../../outside'},articleUrl,rights),false);});
test('image outage removes thumbnail metadata but preserves article',async()=>{const root=await tempRoot();const fixture=mockSources({image:true});await runSync({rootDir:root,fetchImpl:async(url,opts)=>url===imageUrl?new Response('error',{status:500}):fixture.fetchImpl(url,opts),onWarning:()=>{}});const [article]=JSON.parse(await readFile(join(root,'src/data/articles.json'),'utf8'));assert.equal(article.thumbnail,undefined);assert.equal(article.url,articleUrl);});
test('feed outage leaves articles JSON byte-identical',async()=>{const root=await tempRoot();const before=await readFile(join(root,'src/data/articles.json'));await assert.rejects(runSync({rootDir:root,fetchImpl:mockSources({failDev:true}).fetchImpl}));assert.deepEqual(await readFile(join(root,'src/data/articles.json')),before);});
test('invalid rights leave articles byte-identical and make no network requests',async()=>{const root=await tempRoot({version:1,approved:[{}]});const before=await readFile(join(root,'src/data/articles.json'));let calls=0;await assert.rejects(runSync({rootDir:root,fetchImpl:async()=>{calls++;throw new Error();}}));assert.equal(calls,0);assert.deepEqual(await readFile(join(root,'src/data/articles.json')),before);});
test('end-to-end fixture sync stores approved thumbnail and preserves hidden',async()=>{const root=await tempRoot();const fixture=mockSources({image:true});const result=await runSync({rootDir:root,fetchImpl:fixture.fetchImpl});assert.equal(result.thumbnails,1);const [article]=JSON.parse(await readFile(join(root,'src/data/articles.json'),'utf8'));assert.equal(article.series,'ぷゆんの道草');assert.equal(article.hidden,false);assert.equal(article.thumbnail.sha256,hash);await writeFile(join(root,'src/data/articles.json'),JSON.stringify([{...article,hidden:true}]));const second=await runSync({rootDir:root,fetchImpl:fixture.fetchImpl});assert.equal(second.thumbnails,0);assert.equal(JSON.parse(await readFile(join(root,'src/data/articles.json'),'utf8'))[0].hidden,true);});
test('temporary outage retains only same-source approved local bytes',async()=>{const root=await tempRoot();const options={publicDir:join(root,'public'),fetchImpl:mockImage};const thumbnail=await syncThumbnail(oldArticle,imageUrl,rights,options);const old={...oldArticle,thumbnail};for(const fetchImpl of [async()=>{throw new Error('timeout');},async()=>new Response('down',{status:503}),async()=>new Response('slow',{status:429})])assert.deepEqual(await syncThumbnail(old,imageUrl,rights,{...options,fetchImpl}),thumbnail);});
test('HTTP404, changed bytes and revoked rights never retain cached image',async()=>{const root=await tempRoot();const options={publicDir:join(root,'public'),fetchImpl:mockImage};const thumbnail=await syncThumbnail(oldArticle,imageUrl,rights,options);const old={...oldArticle,thumbnail};assert.equal(await syncThumbnail(old,imageUrl,rights,{...options,fetchImpl:async()=>new Response('gone',{status:404})}),undefined);assert.equal(await syncThumbnail(old,imageUrl,rights,{...options,fetchImpl:async()=>new Response(Buffer.concat([png,Buffer.from('changed')]),{headers:{'content-type':'image/png'}})}),undefined);assert.equal(await syncThumbnail(old,imageUrl,{version:1,approved:[]},{...options,fetchImpl:async()=>{throw new Error('timeout');}}),undefined);});
test('temporary outage with tampered local bytes falls back',async()=>{const root=await tempRoot();const options={publicDir:join(root,'public'),fetchImpl:mockImage};const thumbnail=await syncThumbnail(oldArticle,imageUrl,rights,options);await writeFile(join(root,'public',thumbnail.path),'tampered');assert.equal(await syncThumbnail({...oldArticle,thumbnail},imageUrl,rights,{...options,fetchImpl:async()=>{throw new Error('offline');}}),undefined);});
test('prebuild permits only content-addressed approved local images',async()=>{const root=await tempRoot();assert.equal(await verifyPublicAssets(root),0);const thumbnail=await syncThumbnail(oldArticle,imageUrl,rights,{publicDir:join(root,'public'),fetchImpl:mockImage});assert.equal(await verifyPublicAssets(root),1);await writeFile(join(root,'public',thumbnail.path),'tampered');await assert.rejects(verifyPublicAssets(root));});
test('prebuild rejects lingering file after approval revoked without deleting it',async()=>{const root=await tempRoot();const thumbnail=await syncThumbnail(oldArticle,imageUrl,rights,{publicDir:join(root,'public'),fetchImpl:mockImage});await writeFile(join(root,'src/data/thumbnail-rights.json'),JSON.stringify({version:1,approved:[]}));await assert.rejects(verifyPublicAssets(root));assert.deepEqual(await readFile(join(root,'public',thumbnail.path)),png);});
test('prebuild rejects unexpected files including unfinished .tmp',async()=>{const root=await tempRoot();await mkdir(join(root,'public/images/article-thumbnails'),{recursive:true});await writeFile(join(root,'public/images/article-thumbnails',`${hash}.png.tmp`),png);await assert.rejects(verifyPublicAssets(root));});
