import test from 'node:test';
import assert from 'node:assert/strict';
import { decideSeries, isExplicitMichikusaTitle, seriesByTitle } from '../scripts/article-classification.mjs';
import { mergeArticles } from '../scripts/article-sync-core.mjs';
const titleCases = [
  ['実際の道草001', '新シリーズ、いきなり激オモ。【道草#001】', true],
  ['全角番号と空白', '新シリーズ。【道草 ＃００１】', true],
  ['末尾の正式シリーズ表記', '寄り道した話｜ぷゆんの道草 #002', true],
  ['末尾の全角番号', '寄り道した話｜ぷゆんの道草　＃００２', true],
  ['括弧内の正式シリーズ名', '話【ぷゆんの道草 #003】', true],
  ['一般語の道草', '帰り道で道草した話', false],
  ['番号があっても無標識の一般語', '今日は道草#001について考える', false],
  ['番号なしの括弧', '話【道草】', false],
  ['番号なしの末尾', '話｜ぷゆんの道草', false],
  ['閉じ括弧欠け', '話【道草#001', false],
  ['開き括弧欠け', '話道草#001】', false],
  ['異なる閉じ括弧', '話【道草#001]', false],
  ['異なる開き括弧', '話[道草#001】', false],
  ['未承認の角括弧', '話[道草#001]', false],
  ['余分な閉じ括弧', '話【道草#001】】', false],
  ['余分な開き括弧', '話【【道草#001】', false],
  ['末尾に欠けた括弧', '話｜ぷゆんの道草 #002】', false],
  ['末尾形式のあとに本文', '話｜ぷゆんの道草 #002について', false],
  ['括弧内の番号あとに本文', '話【道草#001について】', false],
  ['小数は番号にしない', '話【道草#1.5】', false],
  ['番号に英字が混じる', '話【道草#001x】', false],
];
for (const [name,title,expected] of titleCases) test(name,()=>assert.equal(isExplicitMichikusaTitle(title),expected));
const url='https://note.com/puyun_days/n/example';
const item={title:'話【道草#001】',url,platform:'note'};
const priorityCases = [
  ['明示その他がマガジンより優先', { ...item, magazineSeries: '成長日記' }, { series: 'となりのnote' }, { [url]: 'その他' }, 'その他'],
  ['明示道草がマガジンより優先', { ...item, magazineSeries: '成長日記' }, { series: 'となりのnote' }, { [url]: 'ぷゆんの道草' }, 'ぷゆんの道草'],
  ['明示指定がDEVより優先', { ...item, platform: 'dev' }, undefined, { [url]: 'その他' }, 'その他'],
  ['DEVがタイトルより優先', { ...item, platform: 'dev' }, undefined, {}, 'DEV'],
  ['確認済みマガジンが既存より優先', { ...item, magazineSeries: '成長日記' }, { series: 'となりのnote' }, {}, '成長日記'],
  ['既存カテゴリが道草タイトルより優先', item, { series: '成長日記' }, {}, '成長日記'],
  ['既存その他は道草に補完', item, { series: 'その他' }, {}, 'ぷゆんの道草'],
  ['未登録マガジンは根拠にしない', { ...item, magazineSeries: '未確認' }, { series: 'その他' }, {}, 'ぷゆんの道草'],
  ['URL末尾slashの正規化', { ...item, url: `${url}/` }, undefined, { [url]: 'その他' }, 'その他'],
  ['不明なタイトルはその他', { ...item, title: 'ふつうの記事' }, undefined, {}, 'その他'],
];
for (const [name,fetched,existing,overrides,expected] of priorityCases) test(name,()=>assert.equal(decideSeries(fetched,existing,overrides),expected));
for(const [name,title,series] of [
 ['従来の成長日記includesを維持','「成長日記」という言葉を考える','成長日記'],
 ['従来のとなりのnote includesを維持','となりのnoteについて','となりのnote'],
 ['従来のぷゆん速報includesを維持','今日はぷゆん速報を振り返る','ぷゆん速報'],
 ['従来規則の順番も維持','成長日記ととなりのnoteとぷゆん速報','成長日記'],
])test(name,()=>assert.equal(seriesByTitle(title),series));
test('無効な明示カテゴリは拒否',()=>assert.throws(()=>decideSeries(item,undefined,{[url]:'未登録'})));
const article={...item,series:'その他',publishedAt:'2026-10-16T12:25:22.000Z',hidden:true};
test('hiddenは取得元の内容より既存手動値を維持',()=>assert.equal(mergeArticles([article],[{...item,publishedAt:article.publishedAt,hidden:false}])[0].hidden,true));
test('RSS掲載外の記事を削除しない',()=>assert.equal(mergeArticles([article],[]).length,1));
test('既存その他の道草分類で他の全字段を維持',()=>assert.deepEqual(mergeArticles([article],[])[0],{...article,series:'ぷゆんの道草'}));
test('取得がない既存記事にも手動指定が最優先',()=>assert.equal(mergeArticles([article],[],{[url]:'その他'})[0].series,'その他'));
test('既存URL重複を拒否',()=>assert.throws(()=>mergeArticles([article,article],[])));
test('不正取得データを拒否し入力を変更しない',()=>{const copy=structuredClone(article);assert.throws(()=>mergeArticles([article],[{...item,publishedAt:'invalid'}]));assert.deepEqual(article,copy);});
