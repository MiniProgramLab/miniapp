import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import type { LanguageRequest, WorkspaceReader } from '../src/api';
import { createComponentScriptResolver, createDataPathPlugin, createScriptResolver, createWxsPlugin } from '../src/languages/typescript';
import { scriptExpression } from '../src/languages/wxml/wxs';
import { createProjectFileResolver, createRoutePlugin, createRouteResolver } from '../src/resolution';
import { createComponentResolver, createDatasetFeatures, createInstanceFeatures, createNavigatorPlugin, createRenameFeatures, createRouteContextResolver, createTemplateResolver, createWxmlPlugin } from '../src/languages/wxml';
import { ScriptProject } from '../src/languages/typescript/project';
import { importIndex } from '../src/languages/typescript/import-index';
import { createWorkspaceRevisions } from '../src/core/workspace-revisions';
import { createMetadataResolver } from '../src/languages/wxml/metadata';
import { checkWorkspace } from '../src/core/workspace-check';
import { createDependencyTracking } from '../src/adapters/vscode/dependency-tracking';
import { createNavigationTracking } from '../src/adapters/vscode/navigation-tracking';
import type { CheckProvider } from '../src/api';
import { createCssModule } from '../src/languages/css';

/** 可传入任意模板、查询名称和工作区目录，只读取快照，不运行或修改工程代码。 */
const file = process.argv[2];
const name = process.argv[3] ?? 'submit';
const root = pathToFileURL(resolve(process.argv[4] ?? process.cwd()) + '/').href;
const uri = file ? pathToFileURL(resolve(file)).href : root + 'page.wxml';
const fixtures = new Map<string, string>([[root + 'page.wxml', '<view bindtap="submit"/>'], [root + 'page.ts', `import shared from './shared';Component({behaviors:[shared]});`], [root + 'shared.ts', `export default Behavior({methods:{/** 提交 */ submit(){}}});`]]);
/** 基准运行期间使用固定快照，以便对比相同输入的冷查询与连续查询。 */
const snapshots = new Map<string, string | undefined>();
let reads = 0;
/** 文件发现沿工作区遍历，排除依赖和输出目录；基准快照仅在本进程保留。 */
const catalog = new Map<string, readonly string[]>();
const hostRevisions = createWorkspaceRevisions();
const reader: WorkspaceReader = { root: () => root, ...(process.argv.includes('--no-cache') ? {} : { revision: process.argv.includes('--host-revisions') ? hostRevisions.revision : () => 'benchmark' }),
  findFiles: async (_uri, pattern, limit) => {
    const cached = catalog.get(pattern);
    if (cached && cached.length < limit) return cached;
    const suffix = pattern === '**/*.wxml' ? /\.wxml$/ : pattern === '**/*.json' ? /\.json$/ : pattern === '**/*.d.ts' ? /\.d\.ts$/ : /\.(?:[cm]?[jt]sx?|wxs|wxml)$/;
    const result: string[] = [];
    /** 达到调用预算即停止，调用方用 limit+1 检查截断。 */
    async function walk(directory: string): Promise<void> {
      for (const entry of await readdir(new URL(directory), { withFileTypes: true })) {
        if (result.length >= limit) break;
        if (['node_modules', 'dist', 'build', '.git', '.pnpm-store'].includes(entry.name)) continue;
        const target = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory).href;
        if (entry.isDirectory()) await walk(target);
        else if (entry.isFile() && suffix.test(entry.name)) result.push(target);
      }
    }
    if (file) await walk(root); else result.push(...[...fixtures.keys()].filter((uri) => suffix.test(uri)));
    catalog.set(pattern, result);
    return result;
  },
  /** 与编辑器宿主使用相同的目录能力，避免基准绕过实际文件解析行为。 */
  directory: async (target) => {
    if (!file && [...fixtures.keys()].some((uri) => uri.startsWith(target.replace(/\/?$/, '/')))) return true;
    try { return (await stat(new URL(target))).isDirectory(); } catch { return false; }
  },
  fileResolver: (target, cancellation) => createProjectFileResolver(reader, target, cancellation), read: async (target) => {
  reads++;
  if (!file && fixtures.has(target)) return { text: fixtures.get(target)! };
  if (!snapshots.has(target)) {
    try { snapshots.set(target, await readFile(new URL(target), 'utf8')); } catch { snapshots.set(target, undefined); }
  }
  const text = snapshots.get(target); return text === undefined ? undefined : { text };
} };
const text = (await reader.read(uri))?.text;
if (!text || !text.includes(name)) throw new Error('模板不存在或不包含查询名称，请指定模板、名称和工作区目录。');
if (process.argv.includes('--metadata')) {
  /** 元数据基准只读取项目版本快照，普通查询不会加载脚本编译器。 */
  const resolver = createMetadataResolver(reader, () => ({}));
  const request: LanguageRequest = { document: { uri, text, version: 1, languageId: 'wxml' }, offset: 0, cancellation: { isCancellationRequested: false } };
  const results = [];
  for (let query = 0; query < 6; query++) {
    const before = reads, start = performance.now();
    const catalog = await resolver.load({ ...request });
    results.push({ query, milliseconds: Math.round((performance.now() - start) * 100) / 100, reads: reads - before, tags: catalog.tags.length, sdkVersion: catalog.sdkVersion ?? '未知' });
  }
  console.log(JSON.stringify({ uri, root, results }, null, 2));
  process.exit(0);
}
if (process.argv.includes('--imports')) {
  /** 导入索引直接使用只读工作区端口，不建立额外的语义 Program。 */
  const request: LanguageRequest = { document: { uri, text, version: 1, languageId: 'wxml' }, offset: 0, cancellation: { isCancellationRequested: false } };
  const results = [];
  for (let query = 0; query < 6; query++) {
    const before = reads, start = performance.now();
    const index = await importIndex(reader, { ...request });
    results.push({ query, milliseconds: Math.round((performance.now() - start) * 100) / 100, reads: reads - before, files: index?.files.length ?? 0, targets: index?.reverse.size ?? 0 });
  }
  console.log(JSON.stringify({ uri, root, probes: snapshots.size, results }, null, 2));
  process.exit(0);
}
const dataset = process.argv.includes('--dataset');
const component = process.argv.includes('--component');
const instance = process.argv.includes('--instance');
/** 跨语言引用与重命名只生成内存结果，不应用业务源码编辑。 */
const semanticReferences = process.argv.includes('--references');
const route = process.argv.includes('--route');
const pageQuery = process.argv.includes('--page-query');
const dataPath = process.argv.includes('--data-path');
const structureCheck = process.argv.includes('--structure');
const prepareComponent = process.argv.includes('--prepare-component');
const extractTemplate = process.argv.includes('--extract-template') || prepareComponent;
const wxsCheck = process.argv.includes('--wxs-check'), wxsSignature = process.argv.includes('--wxs-signature');
const request: LanguageRequest = { document: { uri, text, version: 1, languageId: uri.endsWith('.wxs') ? 'wxs' : dataset || instance || pageQuery || dataPath || (route || semanticReferences) && !uri.endsWith('.wxml') ? uri.endsWith('.js') ? 'javascript' : uri.endsWith('.json') ? 'json' : 'typescript' : 'wxml' }, offset: component ? text.indexOf(name) + Math.floor(name.length / 2) : text.lastIndexOf(name) + name.length, cancellation: { isCancellationRequested: false } };
const workspaceCheck = process.argv.includes('--workspace-check');
const expression = dataset || component || instance || semanticReferences || route || pageQuery || dataPath || workspaceCheck || wxsCheck || wxsSignature || structureCheck || extractTemplate ? undefined : scriptExpression(request);
if (!expression && !dataset && !component && !instance && !semanticReferences && !route && !pageQuery && !dataPath && !workspaceCheck && !wxsCheck && !wxsSignature && !structureCheck && !extractTemplate) throw new Error('查询名称必须位于模板表达式或事件处理方法中。');
const maxFiles = Number(process.argv.find((argument) => argument.startsWith('--max-files='))?.split('=')[1] ?? 400);
const options = { maxFiles, libraryUri: new URL('../node_modules/typescript/lib/lib.es5.d.ts', import.meta.url).href };
if (extractTemplate) {
  /** 以光标所在的完整节点生成提取编辑，结果仅计数，不写入项目。 */
  const { structure, nodeAt } = await import('../src/languages/wxml/structure');
  const index = structure(text, request.cancellation), node = index && nodeAt(index, request.offset);
  if (!node) throw new Error('查询位置没有完整模板节点。');
  const scripts = createTemplateResolver(reader, createScriptResolver(reader, () => options));
  const features = createWxmlPlugin(undefined, scripts, undefined, undefined, reader).setup({ logger: { info() {}, error() {} }, subscriptions: { add: (item) => item } });
  const styles = prepareComponent ? createCssModule(reader).classes : undefined;
  const results = [];
  for (let query = 0; query < 3; query++) {
    const before = reads, start = performance.now();
    if (prepareComponent && styles) {
      const { prepareComponent: prepare } = await import('../src/languages/wxml/refactor');
      try {
        const result = await prepare(request, node.range, scripts, styles, reader);
        results.push({ query, milliseconds: Math.round((performance.now() - start) * 100) / 100, reads: reads - before, data: result.data.length, classes: result.style.bindings.length, styleFiles: result.styleFiles.length, bodyCharacters: result.body.length });
      } catch (error) {
        results.push({ query, milliseconds: Math.round((performance.now() - start) * 100) / 100, reads: reads - before, issue: error instanceof Error ? error.message : String(error) });
      }
      continue;
    }
    const actions = await features.codeActions!.provide(request, node.range, 'refactor.extract');
    const action = actions.find((action) => action.input);
    if (!action?.input) throw new Error(actions[0]?.disabled ?? '当前位置没有提取入口。');
    const edits = await action.input.select('benchmark-extract', request.cancellation);
    results.push({ query, milliseconds: Math.round((performance.now() - start) * 100) / 100, reads: reads - before, edits: edits.length, generatedCharacters: edits.reduce((sum, edit) => sum + edit.newText.length, 0) });
  }
  console.log(JSON.stringify({ uri, characters: text.length, selectedCharacters: node.range.end - node.range.start, results }, null, 2)); process.exit(0);
}
if (structureCheck) {
  /** 结构提供器只使用当前文件，基准同时查询大纲、折叠及多光标选区。 */
  const features = createWxmlPlugin().setup({ logger: { info() {}, error() {} }, subscriptions: { add: (item) => item } });
  const results = [];
  for (let query = 0; query < 3; query++) {
    const before = reads, start = performance.now();
    const symbols = await features.documentSymbols!.provide(request), folds = await features.foldingRanges!.provide(request);
    const selections = await features.selectionRanges!.provide(request, [0, request.offset, text.length]);
    results.push({ query, milliseconds: Math.round((performance.now() - start) * 100) / 100, reads: reads - before, roots: symbols.length, folds: folds.length, selections: selections.map((ranges) => ranges.length) });
  }
  console.log(JSON.stringify({ uri, characters: text.length, results }, null, 2)); process.exit(0);
}
if (wxsCheck || wxsSignature) {
  /** 参数提示和检查沿真实注册入口运行，所有项目文件仅做只读输入。 */
  const scripts = createTemplateResolver(reader, createScriptResolver(reader, () => options));
  const features = (uri.endsWith('.wxs') ? createWxsPlugin(reader, () => options) : createWxmlPlugin(undefined, scripts, undefined, undefined, reader)).setup({ logger: { info() {}, error() {} }, subscriptions: { add: (item) => item } });
  const results = [];
  for (let query = 0; query < 3; query++) {
    const before = reads, start = performance.now();
    const findings = wxsCheck ? await features.diagnostics!.provide(request) : [];
    const signatures = wxsSignature ? await features.signatureHelp!.provide(request) : undefined;
    results.push({ query, milliseconds: Math.round((performance.now() - start) * 100) / 100, reads: reads - before, findings: findings.length, codes: [...new Set(findings.map((item) => item.code))], signatures: signatures?.signatures.map((item) => item.label) ?? [], activeParameter: signatures?.activeParameter });
  }
  console.log(JSON.stringify({ uri, root, results }, null, 2)); process.exit(0);
}
if (workspaceCheck) {
  /** 与宿主相同的依赖和预算追踪只读取项目，不加载业务入口或执行构建。 */
  const tracking = createDependencyTracking(reader.revision ?? (() => 'uncached'));
  const navigation = createNavigationTracking();
  const snapshot: WorkspaceReader = { ...reader, revision: tracking.observe, capture: tracking.capture, navigation,
    read: (uri) => { tracking.observe(uri); return reader.read(uri); },
    directory: async (uri) => { tracking.observe(uri); return await reader.directory?.(uri) ?? false; },
    findFiles: async (uri, pattern, limit) => { tracking.observe(root); return await reader.findFiles?.(uri, pattern, limit) ?? []; },
    fileResolver: (uri, cancellation) => createProjectFileResolver(snapshot, uri, cancellation),
  };
  const scripts = createScriptResolver(snapshot, () => options), templates = createTemplateResolver(snapshot, scripts);
  const inspector = (reader: WorkspaceReader) => createComponentScriptResolver(reader, () => options);
  const componentFactory = (reader: WorkspaceReader) => createComponentResolver(reader, inspector);
  const components = componentFactory(snapshot);
  const routes = createRouteResolver(snapshot, scripts, createRouteContextResolver(snapshot, componentFactory, inspector, scripts));
  const plugins = [createWxmlPlugin(undefined, templates, undefined, components, snapshot), createNavigatorPlugin(routes), createRoutePlugin(scripts, routes), createDataPathPlugin(snapshot, () => options),
    { id: 'benchmark.instances', displayName: '组件实例语义', languages: ['typescript', 'javascript', 'typescriptreact', 'javascriptreact'], setup: () => createInstanceFeatures(snapshot, templates, inspector(snapshot), components) }];
  const providers: CheckProvider[] = plugins.flatMap((plugin) => { const features = plugin.setup({ logger: { info() {}, error() {} }, subscriptions: { add: (value) => value } }); return features.diagnostics ? [{ id: plugin.id, name: plugin.displayName, languages: plugin.languages, active: () => true, provide: features.diagnostics.provide }] : []; });
  const supplied = [...await snapshot.findFiles!(uri, '**/*.{wxml,wxs,ts,tsx,js,jsx,mts,cts,mjs,cjs}', 10001), ...await snapshot.findFiles!(uri, '**/*.json', 10001)];
  const scoped = process.argv.find((argument) => argument.startsWith('--scope='))?.slice(8);
  const scope = scoped ? pathToFileURL(resolve(scoped) + '/').href : root;
  const selected = [...new Set(supplied)].filter((uri) => uri.startsWith(scope)).map((uri) => ({ uri, languageId: uri.endsWith('.wxml') ? 'wxml' : uri.endsWith('.json') ? 'json' : uri.endsWith('.wxs') ? 'wxs' : /\.[cm]?js$/.test(uri) ? 'javascript' : 'typescript' }));
  const results = [];
  for (let query = 0; query < 3; query++) {
    const before = reads, start = performance.now();
    const result = await checkWorkspace(snapshot, selected, providers, { cancellation: { isCancellationRequested: false }, scopes: [scope] });
    results.push({ query, milliseconds: Math.round((performance.now() - start) * 100) / 100, reads: reads - before, selected: result.report.selected, checked: result.report.checked, status: result.report.status, findings: result.report.findings.length, issues: result.report.issues.length });
  }
  console.log(JSON.stringify({ root, scope, results }, null, 2));
  tracking.dispose(); navigation.dispose(); process.exit(0);
}
const scripts = createScriptResolver(reader, () => options);
const templates = createTemplateResolver(reader, scripts);
const components = createComponentResolver(reader, (snapshot) => createComponentScriptResolver(snapshot, () => options));
const instances = createInstanceFeatures(reader, templates, createComponentScriptResolver(reader, () => options), components);
const rename = createRenameFeatures(reader, templates, components, undefined, instances);
const fields = createDatasetFeatures(reader, templates, rename.references);
if (semanticReferences) {
  /** 使用实际组合后的收集器，分别记录冷查询与连续查询的完整结果。 */
  const results = [];
  for (let query = 0; query < 3; query++) {
    const before = reads, start = performance.now();
    const references = await rename.references.provide(request, true);
    const edits = await rename.provide(request, name + 'Benchmark');
    results.push({ query, milliseconds: Math.round((performance.now() - start) * 100) / 100, reads: reads - before, references: references.length, edits: edits.length, files: new Set(edits.map((edit) => edit.uri)).size });
  }
  console.log(JSON.stringify({ uri, root, results }, null, 2)); process.exit(0);
}
const routeInspector = (snapshot: WorkspaceReader) => createComponentScriptResolver(snapshot, () => options);
const routeComponents = (snapshot: WorkspaceReader) => createComponentResolver(snapshot, routeInspector);
const routes = createRouteResolver(reader, scripts, createRouteContextResolver(reader, routeComponents, routeInspector, scripts));
const routeFeatures = (uri.endsWith('.wxml') ? createNavigatorPlugin(routes) : createRoutePlugin(scripts, routes)).setup({ logger: { info() {}, error() {} }, subscriptions: { add: (value) => value } });
/** 数据路径沿真实提供器测量，业务源码仅作为只读输入。 */
const dataPaths = createDataPathPlugin(reader, () => options).setup({ logger: { info() {}, error() {} }, subscriptions: { add: (value) => value } });
const results: { query: number; milliseconds: number; reads: number; definitions: number; completions: number }[] = [];
let queryFields: readonly { name: string; type: string; required: boolean; defaultValue?: string }[] = [];
for (let query = 0; query < 6; query++) {
  const before = reads;
  const start = performance.now();
  const current = { ...request };
  const schema = pageQuery ? await scripts.pageQuery?.(current, uri) : undefined;
  const definitions = pageQuery ? schema?.fields?.flatMap((field) => field.definitions) ?? [] : dataPath ? await dataPaths.definition!.provide(current) : route ? await routeFeatures.definition!.provide(current) : instance ? await instances.definition!.provide(request) : dataset ? await fields.definition!.provide(request) : component ? await components.definition(request) : await scripts.resolve(request, expression!);
  const completions = pageQuery ? schema?.fields ?? [] : dataPath ? await dataPaths.completion!.provide({ ...current }) : route ? await routeFeatures.completion!.provide({ ...current }) : instance ? await instances.completion!.provide(request) : dataset ? await fields.completion!.provide(request) : component ? await components.completion?.(request) ?? [] : await scripts.complete!(request, expression!);
  if (schema) queryFields = schema.fields?.map((field) => ({ name: field.name, type: field.type.display, required: field.required, ...(field.defaultValue === undefined ? {} : { defaultValue: field.defaultValue }) })) ?? [];
  results.push({ query, milliseconds: Math.round((performance.now() - start) * 100) / 100, reads: reads - before, definitions: definitions.length, completions: completions.length });
}
const graph = new ScriptProject(reader, request, options);
const created = await graph.create(dataset || instance || pageQuery || dataPath || route && !uri.endsWith('.wxml') ? uri : undefined);
console.log(JSON.stringify({ uri, name, maxFiles, graph: { sources: graph.sources.size, probes: graph.documents.size, complete: !!created && !graph.exhausted }, ...(pageQuery ? { queryFields } : {}), results }, null, 2));
