import ts from 'typescript';
import type { CallSignature, ComponentMember, ComponentEvent, ComponentLocation, ComponentProperty, ComponentScriptInfo, ComponentScriptResolver, LanguageRequest, SemanticType, WorkspaceReader } from '../../api';
import { ScriptProject } from './project';
import type { ScriptOptions } from './project';
import { Values } from './values';
import type { Value } from './values';
import { documentation } from './documentation';
import { componentEvents, componentFunctions } from './events';
import { semanticType } from './semantic-types';

/** 只返回实现源码；类型声明可以参与推断，但不能成为跳转目标。 */
function location(node: ts.Node, project: ScriptProject): ComponentLocation | undefined {
  const source = node.getSourceFile();
  if (source.isDeclarationFile) return undefined;
  const version = project.documents.get(source.fileName)?.version;
  const quote = Number(ts.isStringLiteralLike(node));
  return { uri: source.fileName, range: { start: node.getStart(source) + quote, end: node.getEnd() - quote }, ...(version !== undefined ? { version } : {}) };
}

/** 注册表达式的注释可能属于外层的导出语句或变量声明。 */
function registrationDocumentation(node: ts.Node): string {
  for (let current: ts.Node | undefined = node; current && !ts.isSourceFile(current); current = current.parent) {
    const description = documentation(current);
    if (description) return description;
  }
  return '';
}

/** 将静态值呈现为源码文本，不执行默认值工厂。 */
function render(values: Values, value: Value): string {
  return values.resolve(value).map((item) => item.node.getText().trim()).filter(Boolean).join(' | ') || value.node.getText().trim();
}

/** 读取构造函数、联合构造类型及 PropType 显式断言。 */
function propertyType(values: Values, value: Value | undefined): string {
  if (!value) return 'unknown';
  const node = ts.isPropertyAssignment(value.node) ? value.node.initializer : value.node;
  if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
    const type = node.type;
    if (ts.isTypeReferenceNode(type) && /(?:^|\.)PropType$/.test(type.typeName.getText()) && type.typeArguments?.[0]) return type.typeArguments[0].getText();
  }
  const constructors: Readonly<Record<string, string>> = { String: 'string', Number: 'number', Boolean: 'boolean', Object: 'object', Array: 'unknown[]', Function: '(...args: unknown[]) => unknown', null: 'any' };
  const direct = constructors[node.getText().trim()];
  if (direct) return direct;
  const resolvedConstructor = values.resolve(value).find((item) => ts.isVariableDeclaration(item.node) && constructors[item.node.name.getText()]);
  if (resolvedConstructor && ts.isVariableDeclaration(resolvedConstructor.node)) return constructors[resolvedConstructor.node.name.getText()]!;
  const candidates = values.elements(value);
  if (candidates.length) return [...new Set(candidates.map((item) => propertyType(values, item)))].join(' | ');
  return constructors[render(values, value)] ?? render(values, value);
}

/** 显式 PropType 使用真实声明，运行时构造函数只提供确定的基础类型。 */
function propertySemanticType(values: Values, value: Value | undefined, display: string): SemanticType {
  const node = value && (ts.isPropertyAssignment(value.node) ? value.node.initializer : value.node);
  if (node && (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) && ts.isTypeReferenceNode(node.type) && /(?:^|\.)PropType$/.test(node.type.typeName.getText()) && node.type.typeArguments?.[0]) {
    const type = node.type.typeArguments[0];
    return semanticType(values.checker, values.checker.getTypeFromTypeNode(type), type);
  }
  if (display.includes(' | ')) return { display, kind: 'unknown', alternatives: display.split(' | ').map((part) => propertySemanticType(values, undefined, part)) };
  const kind = ({ string: 'string', number: 'number', boolean: 'boolean', object: 'object', 'unknown[]': 'array', '(...args: unknown[]) => unknown': 'function' } as const)[display as 'string'];
  return { display, kind: kind ?? 'unknown' };
}

/** 原生 properties 未提供 value 时采用平台默认值。 */
function nativeDefault(type: string): string {
  const primary = type.split(' | ')[0];
  return ({ string: '""', number: '0', boolean: 'false', object: 'null', 'unknown[]': '[]' } as Readonly<Record<string, string>>)[primary ?? ''] ?? '未设置';
}

/** 静态提取参数，同时保留对象展开与 Behavior 中的实际字段位置。 */
function properties(values: Values, project: ScriptProject, value: Value, seen = new Set<ts.Node>()): Map<string, ComponentProperty> {
  const result = new Map<string, ComponentProperty>();
  for (const resolved of values.resolve(value)) {
    if (seen.has(resolved.node) || seen.size > 80 || project.cancelled) continue;
    const visited = new Set(seen).add(resolved.node);
    const fields = values.fields(resolved);
    for (const group of ['behaviors', 'mixins']) for (const list of fields.get(group) ?? []) for (const inherited of values.elements(list)) {
      for (const [name, property] of properties(values, project, inherited, visited)) result.set(name, property);
    }
    for (const group of ['properties', 'props']) for (const section of fields.get(group) ?? []) {
      for (const [name, declarations] of values.fields(section)) {
        const implementations = declarations.filter((item) => !item.node.getSourceFile().isDeclarationFile);
        if (!implementations.length) continue;
        const item = implementations[0]!;
        const spec = values.fields(item);
        const type = [...new Set([propertyType(values, spec.get('type')?.[0] ?? item), ...spec.get('optionalTypes')?.flatMap((entry) => values.elements(entry).map((type) => propertyType(values, type))) ?? []])].join(' | ');
        const defaults = spec.get('value') ?? spec.get('default');
        const targets = implementations.map((entry) => location(entry.declaration ?? entry.node, project)).filter((entry): entry is ComponentLocation => !!entry);
        result.set(name, { name, type, valueType: propertySemanticType(values, spec.get('type')?.[0] ?? item, type), defaultValue: defaults?.length ? defaults.map((entry) => render(values, entry)).join(' | ') : nativeDefault(type),
          required: spec.get('required')?.some((entry) => render(values, entry) === 'true') ?? false,
          description: implementations.map((entry) => documentation(entry.node)).filter(Boolean).join('\n'), definitions: targets });
      }
    }
  }
  return result;
}

/** 将 usingComponents 和泛型默认组件转换为静态注册表。 */
function registrations(values: Values, value: Value): Record<string, string> {
  const result: Record<string, string> = {};
  const fields = values.fields(value);
  for (const section of fields.get('componentGenerics') ?? []) for (const [name, definitions] of values.fields(section)) {
    result[name] = '';
    for (const definition of definitions) for (const fallback of values.fields(definition).get('default') ?? []) {
      const path = values.keys(fallback)[0];
      if (path) result[name] = path;
    }
  }
  for (const section of fields.get('usingComponents') ?? []) for (const [name, definitions] of values.fields(section)) {
    const path = definitions.flatMap((definition) => values.keys(definition))[0];
    if (path) result[name] = path;
  }
  return result;
}

/** 动态注册表和未知展开保持开放，只有完整静态配置才检查缺少注册。 */
function completeRegistrations(values: Values, value: Value): boolean {
  if (!values.closed(value)) return false;
  const fields = values.fields(value);
  return (fields.get('usingComponents') ?? []).every((section) => values.closed(section)
    && [...values.fields(section).values()].every((items) => items.every((item) => values.keys(item).length === 1)));
}

/** 实例数据和方法按继承顺序覆盖，函数签名包含参数名和返回值。 */
function instanceMembers(values: Values, project: ScriptProject, registered: Value, props: readonly ComponentProperty[]): ComponentMember[] {
  const result = new Map<string, ComponentMember>();
  const context = values.context(registered);
  /** 运行时字段使用声明类型避免字面量过窄，参数名称与完整签名分别显示。 */
  const describe = (name: string, path: readonly string[], declared: readonly Value[]): ComponentMember => {
    const actual = declared.flatMap((member) => values.resolve(member));
    const nodeType = (member: Value): ts.Type => member.type ?? values.checker.getTypeAtLocation(member.declaration?.parent && ts.isPropertyAssignment(member.declaration.parent) ? member.declaration.parent : member.node);
    const types = actual.map((member) => semanticType(values.checker, nodeType(member), member.node));
    const type = types.length === 1 ? types[0]! : { kind: 'unknown' as const, display: types.map((item) => item.display).join(' | ') || 'unknown', alternatives: types };
    const definitions = actual.map((member) => location(member.declaration ?? member.node, project)).filter((item): item is ComponentLocation => !!item);
    const declarations = declared.map((member) => location(member.declaration ?? member.node, project)).filter((item): item is ComponentLocation => !!item);
    const signatures: CallSignature[] = actual.flatMap((member) => values.checker.getSignaturesOfType(nodeType(member), ts.SignatureKind.Call).map((signature) => ({
      label: name + values.checker.signatureToString(signature, member.node, ts.TypeFormatFlags.NoTruncation), documentation: documentation(member.node),
      parameters: signature.parameters.map((parameter) => {
        const declaration = parameter.declarations?.find(ts.isParameter);
        const label = declaration && (ts.isObjectBindingPattern(declaration.name) || ts.isArrayBindingPattern(declaration.name)) ? ts.createPrinter().printNode(ts.EmitHint.Unspecified, declaration.name, declaration.getSourceFile()) : parameter.name;
        return { label, documentation: parameter.getDocumentationComment(values.checker).map((part) => part.text).join('') };
      }),
    })));
    return { path, type, description: actual.map((member) => documentation(member.node)).filter(Boolean).join('\n'), definitions, declarations, ...(signatures.length ? { signatures } : {}) };
  };
  let customExport = false;
  let exports: Value[] = [];
  /** 只暴露 methods 与 data，配置对象中的钩子不是普通实例方法。 */
  const visit = (value: Value, seen = new Set<ts.Node>()): void => {
    for (const resolved of values.resolve(value)) {
      if (seen.has(resolved.node) || seen.size > 80) continue;
      const fields = values.fields(resolved);
      const visited = new Set(seen).add(resolved.node);
      for (const group of ['behaviors', 'mixins']) for (const list of fields.get(group) ?? []) for (const inherited of values.elements(list)) visit(inherited, visited);
      for (const list of fields.get('behaviors') ?? []) if (values.elements(list).some((item) => values.keys(item).includes('wx://component-export'))) customExport = true;
      if (fields.has('export')) exports = fields.get('export')!.flatMap((member) => values.resolve(member));
      for (const group of ['data', 'methods']) for (const section of fields.get(group) ?? []) for (const [name, members] of values.fields(section)) {
        const actual = group === 'methods' ? context.get(name) ?? members : members;
        const path = group === 'methods' ? [name] : ['data', name];
        result.set(path.join('.'), describe(name, path, actual));
      }
    }
  };
  visit(registered);
  for (const property of props) for (const prefix of ['data', 'properties']) {
    const path = [prefix, property.name];
    if (prefix === 'data' && result.has(path.join('.'))) continue;
    result.set(path.join('.'), { path, type: property.valueType ?? { kind: 'unknown', display: property.type }, description: property.description, definitions: property.definitions });
  }
  if (customExport && exports.length) {
    const returned = exports.flatMap((member) => values.returns(member));
    const exported = new Map<string, ComponentMember>();
    if (returned.some((member) => member.node.kind === ts.SyntaxKind.ThisKeyword)) for (const [name, member] of result) exported.set(name, member);
    for (const value of returned) if (value.node.kind !== ts.SyntaxKind.ThisKeyword) for (const [name, members] of values.fields(value)) exported.set(name, describe(name, [name], members));
    return [...exported.values()];
  }
  return [...result.values()];
}

/** 组件引用支持静态字典、路径数组和标签路径元组，不绑定任何构建框架。 */
function referencedComponents(values: Values, options: Value, path: string): { paths: Record<string, string>; complete: boolean } {
  const paths: Record<string, string> = {};
  const sections = values.section(options, path);
  let complete = sections.length ? true : values.closed(options);
  for (const section of sections) {
    complete &&= values.closed(section) || values.closed(section, true);
    const elements = values.elements(section);
    if (!elements.length) {
      for (const [name, items] of values.fields(section)) {
        const reference = items.flatMap((item) => values.keys(item))[0];
        if (reference) paths[name] = reference; else complete = false;
      }
      continue;
    }
    for (const item of elements) {
      const tuple = values.elements(item);
      const fields = values.fields(item);
      const declaredName = tuple[0] ? values.keys(tuple[0])[0] : fields.get('tag')?.flatMap((value) => values.keys(value))[0] ?? fields.get('name')?.flatMap((value) => values.keys(value))[0];
      const targets = tuple[1] ? [tuple[1]] : fields.get('component') ?? fields.get('path') ?? [item];
      const reference = targets.flatMap((value) => values.keys(value))[0];
      if (!reference) { complete = false; continue; }
      const fallback = reference.replace(/\/index$/, '').split('/').at(-1)!;
      const name = declaredName ?? fallback.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/([A-Z])([A-Z][a-z])/g, '$1-$2').toLowerCase();
      if (name) paths[name] = reference;
    }
  }
  return { paths, complete };
}

/** 解析组件实现和配置宏，跨文件依赖统一交给脚本语义图。 */
export function createComponentScriptResolver(reader: WorkspaceReader, options: (uri: string) => ScriptOptions = () => ({})): ComponentScriptResolver {
  return {
    /** 每次查询建立只读快照，以便未保存的参数和注释立即生效。 */
    async inspect(request: LanguageRequest, uri: string, includeInstance = false): Promise<ComponentScriptInfo | undefined> {
      if (request.cancellation.isCancellationRequested || /\.d\.[cm]?ts$/i.test(uri)) return undefined;
      if (/\.json$/i.test(uri)) {
        const document = await reader.read(uri);
        if (!document || document.text.length > 2_000_000) return undefined;
        const parsed = ts.parseConfigFileTextToJson(uri, document.text);
        if (parsed.error || !parsed.config || typeof parsed.config !== 'object') return undefined;
        const paths: Record<string, string> = {};
        for (const [name, value] of Object.entries(parsed.config.componentGenerics ?? {})) {
          if (value && typeof value === 'object' && 'default' in value && typeof value.default === 'string') paths[name] = value.default;
        }
        for (const [name, value] of Object.entries(parsed.config.usingComponents ?? {})) if (typeof value === 'string') paths[name] = value;
        const registered = parsed.config.usingComponents;
        const complete = registered === undefined || registered !== null && typeof registered === 'object' && !Array.isArray(registered) && Object.values(registered).every((value) => typeof value === 'string');
        for (const name of Object.keys(parsed.config.componentGenerics ?? {})) paths[name] ??= '';
        return { ...(parsed.config.component === true ? { kind: 'component' as const } : {}), registrationComplete: complete, description: '', definitions: [], properties: [], registrations: paths };
      }
      const project = new ScriptProject(reader, request, { ...options(request.document.uri), preferImplementations: true });
      const created = await project.create(uri);
      if (!created) return undefined;
      const values = new Values(created.program.getTypeChecker(), () => project.cancelled, (reference, from) => project.module(reference, from), project.adapters);
      const definitions: ComponentLocation[] = [];
      const props = new Map<string, ComponentProperty>();
      const paths: Record<string, string> = {};
      let description = '';
      const events: ComponentEvent[] = [];
      const members = new Map<string, ComponentMember>();
      const instanceOwners: ComponentLocation[] = [];
      let kind: ComponentScriptInfo['kind'];
      let registrationComplete = false;
      /** 收集顶层配置宏，排除与组件无关的函数体。 */
      const configs = (node: ts.Node): void => {
        if (ts.isFunctionLike(node)) return;
        if (ts.isCallExpression(node) && ['definePageConfig', 'defineComponentConfig', 'defineAppConfig'].includes(values.callName(node)) && node.arguments[0]) {
          Object.assign(paths, registrations(values, values.value(node.arguments[0])));
          registrationComplete = completeRegistrations(values, values.value(node.arguments[0]));
        }
        ts.forEachChild(node, configs);
      };
      configs(created.entry);
      for (const registered of values.registration(created.entry)) {
        events.push(...componentEvents(values, project, registered));
        Object.assign(paths, registrations(values, registered));
        const candidates = values.resolve(registered);
        kind ??= candidates.find((candidate) => candidate.registrationKind)?.registrationKind;
        registrationComplete ||= !!kind && candidates.every((candidate) => completeRegistrations(values, candidate));
        if (ts.isCallExpression(registered.node) && !['Page', 'Component', 'VantComponent', 'Behavior'].includes(values.callName(registered.node))) {
          const adapter = values.adapter(registered.node);
          const argument = registered.node.arguments[adapter?.argument ?? 0];
          if (argument) {
            const options = values.value(argument);
            for (const config of values.section(options, adapter?.config ?? 'config')) Object.assign(paths, registrations(values, config));
            const components = referencedComponents(values, options, adapter?.components ?? 'components');
            Object.assign(paths, components.paths);
            registrationComplete &&= components.complete;
          }
        }
        const directCall = ts.isCallExpression(registered.node) && !!kind;
        const target = directCall ? registered.node.expression : candidates[0]?.node;
        const definition = target && location(target, project);
        if (definition) definitions.push(definition);
        description ||= registrationDocumentation(directCall ? registered.node : candidates[0]?.node ?? registered.node);
        for (const candidate of candidates) for (const [name, property] of properties(values, project, candidate)) props.set(name, property);
        if (includeInstance) {
          for (const member of instanceMembers(values, project, registered, [...props.values()])) members.set(member.path.join('.'), member);
          instanceOwners.push(...componentFunctions(values, registered).map((node) => location(node, project)).filter((item): item is ComponentLocation => !!item));
        }
      }
      return { ...(kind ? { kind } : {}), complete: !project.exhausted, dependencies: project.dependencies, registrationComplete: !project.exhausted && registrationComplete, description, definitions, properties: [...props.values()], registrations: paths, events, ...(includeInstance ? { members: [...members.values()], instanceOwners } : {}) };
    },
  };
}
