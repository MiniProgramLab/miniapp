import type { LanguageRequest, ScriptDefinitionResolver, ScriptModule, TextRange } from '../../api';
import { structure } from './structure';
import type { StructureNode } from './structure';
import { scriptExpression } from './wxs';

/** 跨文件模块保留真实声明快照；别名仅用于新组件中的词法作用域。 */
export interface TransferredModule {
  readonly request: LanguageRequest;
  readonly module: ScriptModule;
  alias: string;
}

/** 延迟生成片段，所有依赖读完后再分配不遮蔽数据的名称。 */
type Fragment = () => string;

/** 展开透明 include，复制实际调用的模板并保留每个定义文件的模块作用域。 */
export async function materializeComponent(request: LanguageRequest, range: TextRange, scripts: ScriptDefinitionResolver, target: (from: LanguageRequest, reference: string | undefined) => Promise<LanguageRequest>) {
  const modules = new Map<string, TransferredModule>();
  const templates = new Map<string, { alias: string; render: Fragment }>();
  const includes = new Map<string, Fragment>();
  const reserved = new Set<string>();
  const indexed = new Set<string>();
  let expressions = 0, regions = 0;
  /** 只记录生成名称可能碰到的前缀，避免为整份项目建立额外的单词索引。 */
  const reserve = (source: LanguageRequest): void => {
    if (indexed.has(source.document.uri)) return;
    indexed.add(source.document.uri);
    for (const match of source.document.text.matchAll(/__extract(?:Module|Template)\w*/g)) reserved.add(match[0]);
  };
  /** 属性坐标来自同一原文快照，动态路径留给明确的拒绝原因。 */
  const attribute = (source: LanguageRequest, node: StructureNode, name: string): string | undefined => {
    const part = node.opening.attributes.find((item) => item.name === name)?.valueRange;
    return part ? source.document.text.slice(part.start, part.end) : undefined;
  };
  /** 静态模板只查本文件及直接 import，导入文件不会转发其自身导入的名称。 */
  async function definition(source: LanguageRequest, name: string) {
    const index = structure(source.document.text, request.cancellation);
    if (!index) throw new Error('模板依赖超过结构解析预算。');
    const candidates = [source];
    for (const node of index.nodes) if (node.opening.name === 'import') candidates.push(await target(source, attribute(source, node, 'src')));
    const matches = candidates.flatMap((owner) => {
      const parsed = structure(owner.document.text, request.cancellation);
      if (!parsed) throw new Error('导入模板超过结构解析预算。');
      return parsed.nodes.filter((node) => node.opening.name === 'template' && attribute(owner, node, 'name') === name).map((node) => ({ request: owner, node }));
    });
    const unique = [...new Map(matches.map((item) => [item.request.document.uri + ':' + item.node.opening.start, item])).values()];
    if (unique.length !== 1) throw new Error(`模板 ${name} 的声明不能唯一确定，未生成部分迁移。`);
    return unique[0]!;
  }
  /** 声明正文只复制一次，递归调用不能通过未完成的缓存绕过循环检查。 */
  async function template(source: LanguageRequest, node: StructureNode, ancestry: ReadonlySet<string>) {
    const key = source.document.uri + '#template:' + node.opening.start;
    if (ancestry.has(key)) throw new Error('模板调用存在循环，不能完整迁移依赖。');
    const previous = templates.get(key); if (previous) return previous;
    if (!node.closing || templates.size >= 256) throw new Error('模板声明不完整或超过二百五十六个迁移上限。');
    const record = { alias: '', render: (() => '') as Fragment };
    templates.set(key, record);
    record.render = await region(source, { start: node.opening.end, end: node.closing.start }, new Set(ancestry).add(key));
    return record;
  }
  /** 所有修改先记录原文区间，父节点替换会屏蔽其内部的重复扫描。 */
  async function region(source: LanguageRequest, part: TextRange, ancestry: ReadonlySet<string>): Promise<Fragment> {
    if (request.cancellation.isCancellationRequested) throw new Error('模板依赖迁移已取消。');
    if (++regions > 2000 || ancestry.size > 64) throw new Error('模板迁移超过两千个片段或六十四层调用上限。');
    reserve(source);
    const index = structure(source.document.text, request.cancellation);
    if (!index) throw new Error('模板依赖超过结构解析预算。');
    const edits: { range: TextRange; render: Fragment }[] = [];
    const hidden: TextRange[] = [];
    const covered = (range: TextRange): boolean => hidden.some((item) => range.start >= item.start && range.end <= item.end);
    for (const node of index.nodes) {
      if (node.range.start < part.start || node.range.end > part.end || covered(node.range)) continue;
      const name = node.opening.name;
      if (['import', 'wxs'].includes(name) || name === 'template' && attribute(source, node, 'name') !== undefined) {
        edits.push({ range: node.range, render: () => '' }); hidden.push(node.range); continue;
      }
      if (name === 'include') {
        const included = await target(source, attribute(source, node, 'src'));
        const key = included.document.uri + '#include';
        if (ancestry.has(key)) throw new Error('模板 include 存在循环，不能完整迁移依赖。');
        let body = includes.get(included.document.uri);
        if (!body) { body = await region(included, { start: 0, end: included.document.text.length }, new Set(ancestry).add(key)); includes.set(included.document.uri, body); }
        const renderBody = body;
        const attributes: Fragment[] = [];
        for (const item of node.opening.attributes.filter((item) => item.name !== 'src')) {
          const end = item.valueRange ? item.valueRange.end + Number(['"', "'"].includes(source.document.text[item.valueRange.start - 1] ?? '')) : item.range.end;
          attributes.push(await region(source, { start: item.range.start, end }, ancestry));
        }
        edits.push({ range: node.range, render: () => '<block' + attributes.map((item) => ' ' + item()).join('') + '>' + renderBody() + '</block>' }); hidden.push(node.range);
      } else if (name === 'template') {
        const called = attribute(source, node, 'is');
        if (!called || called.includes('{{')) throw new Error('模板 is 不能静态确定，不能完整迁移其声明作用域。');
        const found = await definition(source, called), record = await template(found.request, found.node, ancestry);
        const range = node.opening.attributes.find((item) => item.name === 'is')!.valueRange!;
        edits.push({ range, render: () => record.alias });
      }
    }
    for (const span of index.spans) {
      if (span.kind !== 'expression' || span.range.start < part.start || span.range.end > part.end || covered(span.range)) continue;
      if (++expressions > 2000) throw new Error('模板迁移超过两千个表达式上限。');
      const current = { ...source, offset: span.content.start }, expression = scriptExpression(current);
      if (!expression || expression.event) continue;
      const names = await scripts.expressionNames?.(current, expression);
      if (!names?.complete) throw new Error('模板表达式无法完整静态分析，未生成部分迁移。');
      for (const use of names.names) {
        const module = expression.modules?.find((item) => item.name === use.name);
        if (!module) continue;
        const key = source.document.uri + '#module:' + module.nameRange.start;
        let record = modules.get(key);
        if (!record) {
          if (modules.size >= 256) throw new Error('模板迁移超过二百五十六个模块上限。');
          record = { request: source, module, alias: '' }; modules.set(key, record);
        }
        const transfer = record;
        edits.push({ range: use.range, render: () => use.shorthand ? use.name + ': ' + transfer.alias : transfer.alias });
      }
    }
    return () => {
      let text = source.document.text.slice(part.start, part.end);
      for (const edit of edits.sort((left, right) => right.range.start - left.range.start)) {
        const replacement = edit.render();
        if (text.length + replacement.length - (edit.range.end - edit.range.start) > 4_000_000) throw new Error('展开后的模板超过四百万字符上限。');
        text = text.slice(0, edit.range.start - part.start) + replacement + text.slice(edit.range.end - part.start);
      }
      if (text.length > 4_000_000) throw new Error('展开后的模板超过四百万字符上限。');
      return text;
    };
  }
  const body = await region(request, range, new Set([request.document.uri + '#include']));
  /** 所有原文已收集完毕，新增名称不会遮蔽模板数据或已有模块。 */
  const assign = (prefix: string, records: Iterable<{ alias: string }>): void => {
    let index = 0;
    for (const record of records) { while (reserved.has(prefix + index)) index++; record.alias = prefix + index++; reserved.add(record.alias); }
  };
  assign('__extractModule', modules.values()); assign('__extractTemplate', templates.values());
  const newline = request.document.text.includes('\r\n') ? '\r\n' : '\n';
  const header = [...modules.values()].map((item) => `<wxs module="${item.alias}">module.exports={};</wxs>`).join(newline) + (modules.size ? newline : '');
  const rendered = body();
  let text = header + rendered;
  for (const item of templates.values()) {
    const definition = `<template name="${item.alias}">${item.render()}</template>`;
    if (text.length + definition.length + newline.length > 4_000_000) throw new Error('展开后的组件模板超过四百万字符上限。');
    text += newline + definition;
  }
  if (text.length > 4_000_000) throw new Error('展开后的组件模板超过四百万字符上限。');
  return { request: { ...request, document: { ...request.document, text } }, range: { start: header.length, end: header.length + rendered.length }, modules: [...modules.values()] };
}
