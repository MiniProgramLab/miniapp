import assert from 'node:assert/strict';
import test from 'node:test';
import type { LanguageRequest, OutlineSymbol } from '../src/api';
import { structure, clearStructureCache, provideSymbols, provideFolding, provideSelections } from '../src/languages/wxml/structure';
import { createWxmlPlugin } from '../src/languages/wxml';
import { provideLinkedTags } from '../src/languages/wxml/tag-editing';

/** 结构查询只需要当前快照，不提供任何文件读取能力。 */
function request(text: string): LanguageRequest { return { document: { uri: 'untitled:structure.wxml', languageId: 'wxml', version: 1, text }, offset: 0, cancellation: { isCancellationRequested: false } }; }
/** 按大纲层级收集普通显示名称。 */
function names(symbols: readonly OutlineSymbol[]): string[] { return symbols.flatMap((symbol) => [symbol.name, ...names(symbol.children ?? [])]); }

test('大纲保留标签层级、静态标识、模板与模块，不采集注释和脚本伪标签', () => {
  const text = '<!-- <fake/> --><view id="main" class="page {{active}}" wx:if="{{visible}}"><template name="card"><text/></template><wxs module="utils">var fake="<fake/>";</wxs><include src="./body.wxml"/></view>';
  const outline = provideSymbols(request(text));
  assert.deepEqual(names(outline), ['view#main .page', 'template card', 'text', 'wxs utils', 'include ./body.wxml']);
  assert.equal(outline[0]!.children![0]!.kind, 'template'); assert.equal(outline[0]!.children![1]!.kind, 'module');
  assert.match(outline[0]!.detail!, /wx:if/);
  assert.equal(text.slice(outline[0]!.selectionRange.start, outline[0]!.selectionRange.end), 'view');
  assert.equal(text.slice(outline[0]!.range.start, outline[0]!.range.end), text.slice(text.indexOf('<view')));
  assert.deepEqual(names(provideSymbols(request('<view title="<!-- 假注释 -->"><text/></view>'))), ['view', 'text']);
  assert.deepEqual(names(provideSymbols(request('<view class="page row-{{kind}}-active {{yes ? \'on\' : \'off\'}}"/>'))), ['view .page']);
});

test('语义折叠覆盖属性、注释、CDATA和模块，保留独立闭合行并恢复错误结构', () => {
  const text = '<view>\r\n  <!-- 注释\r\n  结束 -->\r\n  <card\r\n    value="{{1}}"\r\n  />\r\n  <wxs module="utils">\r\n  var fake="<view/>";\r\n  </wxs>\r\n  <![CDATA[\r\n  <fake/>\r\n  ]]>\r\n</view>';
  const folds = provideFolding(request(text));
  assert.equal(folds[0]!.range.end, text.lastIndexOf('</view>'));
  assert.ok(folds.some((fold) => fold.kind === 'comment'));
  assert.ok(folds.some((fold) => fold.kind === 'region'));
  assert.ok(folds.some((fold) => text.slice(fold.range.start, fold.range.end).startsWith('<card')));
  assert.ok(folds.some((fold) => text.slice(fold.range.start, fold.range.end).startsWith('<wxs')));
  const malformed = request('<view>\n<text>\n</view>\n</text>\n<image/>');
  assert.equal(provideFolding(malformed).length, 0);
  assert.ok(provideSymbols(malformed).some((symbol) => symbol.name === 'image'));
});

test('选区按成员、插值、属性、标签、节点和父节点逐层扩大，多光标一致', () => {
  const text = '<view><card value="{{ user.name }}"><text>中文内容</text></card></view>';
  const offsets = [text.indexOf('name') + 1, text.indexOf('中文') + 1];
  const chains = provideSelections(request(text), offsets);
  assert.equal(chains.length, 2);
  assert.deepEqual(chains[0]!.map((range) => text.slice(range.start, range.end)), ['name', 'user.name', '{{ user.name }}', '"{{ user.name }}"', 'value="{{ user.name }}"', '<card value="{{ user.name }}">', '<card value="{{ user.name }}"><text>中文内容</text></card>', text]);
  for (const chain of chains) for (let index = 1; index < chain.length; index++) {
    assert.ok(chain[index]!.start <= chain[index - 1]!.start && chain[index]!.end >= chain[index - 1]!.end);
    assert.notDeepEqual(chain[index], chain[index - 1]);
  }
  const comment = '<view><!-- 中文\n<fake/> --></view>';
  const spans = provideSelections(request(comment), [comment.indexOf('fake') + 1])[0]!;
  assert.ok(spans.some((range) => comment.slice(range.start, range.end).startsWith('<!--')));
  assert.ok(!spans.some((range) => comment.slice(range.start, range.end) === '<fake/>'));
});

test('WXS 正文和未完成模板的选区保持原文范围，不跨入无关兄弟节点', () => {
  const text = '<view><wxs module="utils">var text="{{fake}}";</wxs></view><card/>';
  const ranges = provideSelections(request(text), [text.indexOf('fake') + 1])[0]!;
  assert.ok(!ranges.some((range) => text.slice(range.start, range.end) === '{{fake}}'));
  assert.ok(ranges.some((range) => text.slice(range.start, range.end) === 'var text="{{fake}}";'));
  const incomplete = request('<view>\n<card value="{{caption}}"');
  assert.equal(provideSymbols(incomplete)[0]!.children![0]!.range.end, incomplete.document.text.length);
  assert.equal(provideSelections(incomplete, [incomplete.document.text.length]).length, 1);
});

test('共享索引复用而不混入新草稿，取消、体积及嵌套上限保持有界', () => {
  clearStructureCache();
  const text = '<view><text/></view>';
  const first = structure(text)!;
  assert.equal(structure(text), first);
  provideSymbols(request(text)); provideFolding(request(text)); provideSelections(request(text), [8]);
  assert.equal(structure(text), first);
  const next = text.replace('text', 'image'); assert.notEqual(structure(next), first);
  const cancelled = { ...request(text), cancellation: { isCancellationRequested: true } };
  assert.deepEqual(provideSymbols(cancelled), []); assert.deepEqual(provideSelections(cancelled, [1]), []);
  assert.equal(structure('x'.repeat(2_000_001)), undefined);
  assert.equal(structure('<view>'.repeat(300) + '</view>'.repeat(300)), undefined);
  assert.equal(structure('<view>' + '{{0}}'.repeat(50001) + '</view>'), undefined);
  assert.equal(structure('\n'.repeat(50000)), undefined);
  const source = { ...request('<view><text/></view>'), offset: 3 };
  assert.equal(provideLinkedTags(source)!.ranges.length, 2, '原有联动复用同一严格配对');
  assert.equal(provideLinkedTags({ ...request('<view></view/>'), offset: 3 }), undefined, '非法自闭合结束标签不能形成新配对');
  clearStructureCache(); assert.notEqual(structure(text), first);
});

test('WXML 注册结构提供器，卸载后共享缓存被释放', async () => {
  const resources: { dispose(): void }[] = [];
  const features = createWxmlPlugin().setup({ logger: { info() {}, error() {} }, subscriptions: { add: <T extends { dispose(): void }>(item: T): T => { resources.push(item); return item; } } });
  const source = request('<template name="card"><view/></template>');
  const cached = structure(source.document.text);
  assert.equal((await features.documentSymbols!.provide(source))[0]!.name, 'template card');
  assert.equal((await features.selectionRanges!.provide(source, [20])).length, 1);
  for (const resource of resources) resource.dispose();
  assert.notEqual(structure(source.document.text), cached);
});
