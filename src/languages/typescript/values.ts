import ts from 'typescript';
import type { Definition, ScriptAdapter, StaticString } from '../../api';

/** 静态表达式携带工厂参数和原始声明，绝不执行用户函数。 */
export interface Value {
  readonly registrationKind?: 'page' | 'component' | 'behavior';
  readonly node: ts.Node;
  readonly declaration?: ts.Node;
  readonly type?: ts.Type;
  /** properties 的运行时值使用声明类型，不能把 type/value 配置对象暴露给模板。 */
  readonly runtimeType?: ts.Type;
  readonly bindings: ReadonlyMap<ts.Symbol | ts.ParameterDeclaration, Value>;
  /** 模板内构造的值保留位置及成员，避免交给脚本类型检查器误解析。 */
  readonly template?: Omit<Definition, 'originRange'>;
  readonly members?: ReadonlyMap<string, Value[]>;
  readonly items?: readonly Value[];
  /** 静态投影保留是否存在未知展开，避免把开放对象误判为完整配置。 */
  readonly closed?: boolean;
}

/** 基于 TypeScript 符号表解析别名、展开、枚举及对象成员。 */
export class Values {
  private steps = 0;

  /** 由请求级 Program 提供语义，递归额外受节点预算保护。 */
  constructor(readonly checker: ts.TypeChecker, private readonly cancelled: () => boolean, private readonly module: (reference: string, from: string) => ts.SourceFile | undefined, private readonly adapters: readonly ScriptAdapter[] = []) {}

  /** 建立尚未绑定工厂参数的表达式。 */
  value(node: ts.Node, declaration?: ts.Node): Value {
    return { node, bindings: new Map(), ...(declaration ? { declaration } : {}) };
  }

  /** 沿 import/export 别名取得实际符号，循环别名安全终止。 */
  private original(symbol: ts.Symbol): ts.Symbol {
    const seen = new Set<ts.Symbol>();
    while (symbol.flags & ts.SymbolFlags.Alias && !seen.has(symbol)) {
      seen.add(symbol);
      symbol = this.checker.getAliasedSymbol(symbol);
    }
    return symbol;
  }

  /** 获取可静态确定的声明名称。 */
  name(node: ts.Node | undefined): string | undefined {
    if (node && (ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node))) return node.text;
    return undefined;
  }

  /** 从真实声明生成值，函数重载优先落到有实现的方法。 */
  private symbols(symbol: ts.Symbol, bindings: ReadonlyMap<ts.Symbol | ts.ParameterDeclaration, Value>): Value[] {
    const declarations = this.original(symbol).declarations ?? [];
    const implementations = declarations.filter((node) => ts.isFunctionLike(node) && 'body' in node && node.body);
    return (implementations.length ? implementations : declarations).map((node) => {
      const declaration = 'name' in node && node.name && typeof node.name === 'object' ? node.name as ts.Node : node;
      return { node, declaration, bindings };
    });
  }

  /** 下标沿常量别名取值，不能把变量名本身误当作对象属性名。 */
  keys(value: Value, seen = new Set<ts.Node>()): string[] {
    return this.resolve(value, seen).flatMap(({ node, type }) => {
      if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return [node.text];
      if (ts.isEnumMember(node)) {
        const constant = this.checker.getConstantValue(node);
        if (constant !== undefined) return [String(constant)];
      }
      /** 类型声明中的路径字面量允许与品牌类型相交，不猜测普通 string。 */
      const literals = (type: ts.Type): string[] => type.isStringLiteral() ? [type.value] : type.isUnionOrIntersection() ? type.types.flatMap(literals) : [];
      return literals(type ?? this.checker.getTypeAtLocation(node));
    });
  }

  /** 静态字符串保留动态片段标记，路径明确而查询值动态时仍可定位页面。 */
  strings(value: Value, seen = new Set<ts.Node>()): readonly StaticString[] {
    if (seen.has(value.node) || seen.size > 40 || this.cancelled()) return [];
    const visited = new Set(seen).add(value.node);
    const result: StaticString[] = [];
    /** 模板片段去除边界符，转义后的文字没有一一对应坐标时不声明可编辑来源。 */
    const literal = (node: ts.Node, text: string, leading = 1, trailing = 1): StaticString => {
      const range = { start: node.getStart() + leading, end: node.end - trailing };
      const source = node.getSourceFile();
      return { text, complete: true, ...(source.text.slice(range.start, range.end) === text && !source.isDeclarationFile ? { sources: [{ uri: source.fileName, range, offset: 0 }] } : {}) };
    };
    /** 拼接分支数量有界，未知部分不能被当成空字符串删除。 */
    const join = (left: readonly StaticString[], right: readonly StaticString[]): StaticString[] => left.flatMap((a) => right.map((b) => ({ text: a.text + b.text, complete: a.complete && b.complete, sources: [...a.sources ?? [], ...(b.sources ?? []).map((source) => ({ ...source, offset: source.offset + a.text.length }))] }))).slice(0, 32);
    for (const resolved of this.resolve(value)) {
      const { node } = resolved;
      if (ts.isStringLiteralLike(node)) result.push(literal(node, node.text));
      else if (ts.isNumericLiteral(node)) result.push({ text: node.text, complete: true });
      else if (ts.isEnumMember(node) && node.initializer) result.push(...this.strings({ ...resolved, node: node.initializer }, visited));
      else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        result.push(...join(this.strings({ ...resolved, node: node.left }, visited), this.strings({ ...resolved, node: node.right }, visited)));
      } else if (ts.isTemplateExpression(node)) {
        let parts: StaticString[] = [literal(node.head, node.head.text, 1, 2)];
        for (const span of node.templateSpans) parts = join(join(parts, this.strings({ ...resolved, node: span.expression }, visited)), [literal(span.literal, span.literal.text, 1, ts.isTemplateTail(span.literal) ? 1 : 2)]);
        result.push(...parts);
      } else {
        const keys = this.keys(resolved);
        if (keys.length) result.push(...keys.map((text) => ({ text, complete: true })));
        else result.push({ text: '{动态}', complete: false });
      }
    }
    return result.length ? [...new Map(result.map((part) => [part.text + ':' + JSON.stringify(part.sources), part])).values()].slice(0, 32) : this.cancelled() ? [] : [{ text: '{动态}', complete: false }];
  }

  /** 静态追踪包装器里的指定平台调用，复用参数绑定并跳过未执行的回调。 */
  calls(value: Value, match: (call: ts.CallExpression) => boolean, seen = new Set<ts.Node>()): Value[] {
    const node = value.node;
    if (!ts.isCallExpression(node) || seen.has(node) || seen.size >= 32 || this.cancelled()) return [];
    if (match(node)) return [value];
    const visited = new Set(seen).add(node);
    const result: Value[] = [];
    for (const target of this.resolve({ ...value, node: this.callTarget(node) })) {
      const invoked = this.invoke(target, node.arguments.map((argument) => ({ ...value, node: argument })));
      if (!ts.isFunctionLike(invoked.node) || !('body' in invoked.node) || !invoked.node.body || visited.has(invoked.node)) continue;
      const branch = new Set(visited).add(invoked.node);
      /** 当前函数调用可继续追踪，嵌套回调不能视为立即执行。 */
      const visit = (child: ts.Node): void => {
        if (ts.isFunctionLike(child)) return;
        if (ts.isCallExpression(child)) result.push(...this.calls({ ...invoked, node: child }, match, branch));
        else ts.forEachChild(child, visit);
      };
      visit(invoked.node.body);
    }
    return result;
  }

  /** 静态键优先读取对象成员；未知数组下标保留元素候选。 */
  access(value: Value, keys: readonly string[], seen = new Set<ts.Node>()): Value[] {
    if (!keys.length) return this.elements(value, seen);
    const fields = this.fields(value, seen);
    return [...new Set(keys)].flatMap((key) => fields.get(key) ?? (/^(?:0|[1-9]\d*)$/.test(key) ? this.element(value, Number(key), seen) : []));
  }

  /** 逐层还原解构的容器，包括嵌套对象、数组及工厂参数的调用实参。 */
  private destructure(value: Value, node: ts.BindingElement, seen: Set<ts.Node>): Value[] {
    const pattern = node.parent;
    const owner = pattern.parent;
    let parents: Value[] = [];
    if (ts.isBindingElement(owner)) {
      parents = this.resolve({ node: owner, bindings: value.bindings }, seen);
    } else if (ts.isParameter(owner)) {
      const argument = value.bindings.get(owner);
      parents = argument ? [argument] : [{ node: owner, bindings: value.bindings }];
    } else if (ts.isVariableDeclaration(owner) && owner.initializer) {
      parents = [{ node: owner.initializer, bindings: value.bindings }];
    }
    // 剩余解构构造新对象/数组，不能作为一个同名字段向原始对象查找。
    if (node.dotDotDotToken) {
      if (ts.isArrayBindingPattern(pattern)) return [{ ...value, items: parents.flatMap((parent) => this.elements(parent, seen)).slice(pattern.elements.indexOf(node)) }];
      const excluded = new Set(pattern.elements.filter((element) => !element.dotDotDotToken).map((element) => this.name(element.propertyName ?? element.name)).filter(Boolean));
      const members = new Map(parents.flatMap((parent) => [...this.fields(parent, seen)]).filter(([name]) => !excluded.has(name)));
      return [{ ...value, members, closed: parents.every((parent) => this.closed(parent)) }];
    }
    let members: Value[];
    if (ts.isObjectBindingPattern(pattern)) {
      const property = node.propertyName ?? node.name;
      const keys = ts.isComputedPropertyName(property)
        ? this.keys({ node: property.expression, bindings: value.bindings }, seen)
        : [this.name(property)].filter((name): name is string => name !== undefined);
      members = keys.length ? parents.flatMap((parent) => this.access(parent, keys, seen)) : [];
    } else {
      members = parents.flatMap((parent) => this.element(parent, pattern.elements.indexOf(node), seen));
    }
    if (members.length) return members.flatMap((member) => this.resolve(member, seen));
    return node.initializer ? this.resolve({ node: node.initializer, bindings: value.bindings, declaration: node.name }, seen) : [value];
  }

  /** 还原转译调用的实际函数，逗号表达式左侧不会被静态执行。 */
  private callTarget(call: ts.CallExpression): ts.Expression {
    let target: ts.Expression = call.expression;
    // 转译后的 CommonJS 常以 (0, module.method)(...) 调用原始注册函数。
    while (ts.isParenthesizedExpression(target) || (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.CommaToken)) {
      target = ts.isParenthesizedExpression(target) ? target.expression : (target as ts.BinaryExpression).right;
    }
    return target;
  }

  /** 识别实际导入名，允许未安装类型包的声明宏继续工作。 */
  callName(call: ts.CallExpression): string {
    const target = this.callTarget(call);
    const symbol = this.checker.getSymbolAtLocation(ts.isPropertyAccessExpression(target) ? target.name : target);
    const imported = symbol?.declarations?.find(ts.isImportSpecifier);
    if (imported) return (imported.propertyName ?? imported.name).text;
    return ts.isIdentifier(target) ? target.text : ts.isPropertyAccessExpression(target) ? target.name.text : '';
  }

  /** 导入别名和局部函数别名保留实际入口，模块条件只匹配明确的 import/require。 */
  adapter(call: ts.CallExpression): ScriptAdapter | undefined {
    const names = new Set([this.callName(call)]);
    const modules = new Set<string>();
    const seen = new Set<ts.Node>();
    const visit = (node: ts.Node): void => {
      if (seen.has(node) || seen.size >= 40) return;
      seen.add(node);
      if (ts.isPropertyAccessExpression(node)) { names.add(node.name.text); visit(node.expression); }
      if (ts.isCallExpression(node) && this.callName(node) === 'require' && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) modules.add(node.arguments[0].text);
      const symbol = this.checker.getSymbolAtLocation(node);
      if (!symbol) return;
      names.add(this.original(symbol).name);
      for (const declaration of symbol.declarations ?? []) {
        if (ts.isVariableDeclaration(declaration) && declaration.initializer) visit(declaration.initializer);
        for (let parent: ts.Node | undefined = declaration; parent; parent = parent.parent) {
          if (ts.isImportDeclaration(parent) && ts.isStringLiteralLike(parent.moduleSpecifier)) { modules.add(parent.moduleSpecifier.text); break; }
        }
      }
    };
    visit(this.callTarget(call));
    return this.adapters.find((adapter) => names.has(adapter.name) && (!adapter.module || modules.has(adapter.module)));
  }

  /** 字段路径允许包装器使用 state/actions 等名称，空路径表示配置对象本身。 */
  section(value: Value, path: string): Value[] {
    return path === '.' || path === '' ? [value] : path.split('.').reduce((items, name) => items.flatMap((item) => this.access(item, [name])), [value]);
  }

  /** 只有字面量及确定的展开证明配置完整，类型上的已知字段不能排除动态注册。 */
  closed(value: Value, array = false, seen = new Set<ts.Node>()): boolean {
    if (seen.has(value.node) || seen.size > 40 || this.cancelled()) return false;
    const resolved = this.resolve(value);
    if (!resolved.length) return false;
    const visited = new Set(seen).add(value.node);
    return resolved.every((item) => {
      if (item.closed !== undefined) return item.closed;
      if (array && ts.isArrayLiteralExpression(item.node)) return item.node.elements.every((element) => !ts.isSpreadElement(element) || this.closed({ ...item, node: element.expression }, true, visited));
      if (!array && ts.isObjectLiteralExpression(item.node)) return item.node.properties.every((property) => ts.isSpreadAssignment(property)
        ? this.closed({ ...item, node: property.expression }, false, visited) : !!this.name(property.name));
      return false;
    });
  }

  /** 包装器调用共享实参绑定，静态查找原生注册不进入回调或执行函数。 */
  private invoke(value: Value, arguments_: readonly Value[]): Value {
    const bindings = new Map(value.bindings);
    if (ts.isFunctionLike(value.node)) value.node.parameters.forEach((parameter, index) => {
      const argument = arguments_[index] ?? (parameter.initializer ? { ...value, node: parameter.initializer } : undefined);
      if (!argument) return;
      bindings.set(parameter, argument);
      const symbol = this.checker.getSymbolAtLocation(parameter.name);
      if (symbol) bindings.set(symbol, argument);
    });
    return { ...value, bindings };
  }

  /** 没有返回值的原生包装器仍可识别，循环调用按函数声明终止。 */
  private nativeCalls(value: Value, seen: Set<ts.Node>): Value[] {
    const node = value.node;
    if (!ts.isCallExpression(node) || seen.has(node) || seen.size >= 24) return [];
    const result: Value[] = [];
    const visited = new Set(seen).add(node);
    for (const target of this.resolve({ ...value, node: this.callTarget(node) })) {
      const invoked = this.invoke(target, node.arguments.map((argument) => ({ ...value, node: argument })));
      if (!ts.isFunctionLike(invoked.node) || !('body' in invoked.node) || !invoked.node.body || visited.has(invoked.node)) continue;
      visited.add(invoked.node);
      /** 当前函数的条件分支保留候选，嵌套函数不会被当成立即注册。 */
      const visit = (child: ts.Node): void => {
        if (ts.isFunctionLike(child)) return;
        if (ts.isCallExpression(child)) {
          const candidate = { ...invoked, node: child };
          const resolved = this.resolve(candidate, visited);
          result.push(...resolved.filter((item) => item.registrationKind), ...(!resolved.some((item) => item.registrationKind) ? this.nativeCalls(candidate, visited) : []));
        } else ts.forEachChild(child, visit);
      };
      visit(invoked.node.body);
    }
    return result;
  }

  /** 仅静态解释声明、别名和简单工厂返回值，递归路径独立检测循环。 */
  resolve(value: Value, seen = new Set<ts.Node>()): Value[] {
    const { node, bindings } = value;
    if (this.cancelled() || ++this.steps > 12000 || seen.has(node) || seen.size > 80) return [];
    if (value.template || value.members || value.items || value.runtimeType) return [value];
    seen = new Set(seen).add(node);
    /** 子表达式重新计算类型，避免把父对象类型错误传递给其成员。 */
    const next = (target: ts.Node, declaration = value.declaration): Value => ({ node: target, bindings, ...(declaration ? { declaration } : {}) });
    if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node)) {
      const type = this.checker.getTypeAtLocation(node);
      return this.resolve({ ...next(node.expression), type }, seen);
    }
    if (ts.isIdentifier(node)) {
      const symbol = this.checker.getSymbolAtLocation(node);
      if (!symbol) return [value];
      const bound = bindings.get(symbol);
      if (bound) return this.resolve(bound, seen);
      // CommonJS 注册函数的返回类型常为 any，默认导入需读取真实导出表达式。
      const imported = symbol.declarations?.find(ts.isImportClause);
      const reference = imported?.parent.moduleSpecifier;
      const source = reference && ts.isStringLiteralLike(reference) ? this.module(reference.text, node.getSourceFile().fileName) : undefined;
      if (source) for (const statement of [...source.statements].reverse()) {
        if (ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression) && statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken && statement.expression.left.getText(source).replace(/\s/g, '') === 'module.exports') {
          return this.resolve(next(statement.expression.right), seen);
        }
      }
      return this.symbols(symbol, bindings).flatMap((item) => this.resolve(item, seen));
    }
    if (ts.isShorthandPropertyAssignment(node)) {
      const symbol = this.checker.getShorthandAssignmentValueSymbol(node);
      return symbol ? this.symbols(symbol, bindings).flatMap((item) => this.resolve(item, seen)) : [value];
    }
    if (ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node) || ts.isParameter(node)) {
      const symbol = this.checker.getSymbolAtLocation(node.name);
      const bound = ts.isParameter(node) ? bindings.get(node) ?? (symbol && bindings.get(symbol)) : symbol && bindings.get(symbol);
      if (bound) return this.resolve(bound, seen);
      if (!node.initializer) return [value];
      const initial = next(node.initializer, node.name);
      return this.resolve('type' in node && node.type ? { ...initial, type: this.checker.getTypeAtLocation(node) } : initial, seen);
    }
    if (ts.isBindingElement(node)) {
      return this.destructure(value, node, seen);
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      if (ts.isBinaryExpression(node.parent) && node.parent.left === node && node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        return this.resolve(next(node.parent.right, ts.isPropertyAccessExpression(node) ? node.name : node), seen);
      }
      const keys = ts.isPropertyAccessExpression(node) ? [node.name.text] : this.keys(next(node.argumentExpression), seen);
      const parent = next(node.expression);
      const members = this.access(parent, keys, seen);
      return members.flatMap((item) => this.resolve(item, seen));
    }
    if (ts.isConditionalExpression(node)) return [node.whenTrue, node.whenFalse].flatMap((item) => this.resolve(next(item), seen));
    if (ts.isCallExpression(node)) {
      const name = this.callName(node);
      const adapter = this.adapter(node);
      if (adapter) {
        const argument = node.arguments[adapter.argument ?? 0];
        if (!argument) return [];
        return this.resolve(next(argument), seen).map((options) => {
          const members = this.fields(options);
          for (const [group, path] of [['data', adapter.data], ['properties', adapter.properties], ['methods', adapter.methods], ['setup', adapter.setup], ['query', adapter.query]] as const) if (path !== undefined) {
            members.set(group, this.section(options, path));
            if (group === 'properties') members.delete('props');
          }
          return { ...options, members, closed: this.closed(options), registrationKind: adapter.kind };
        });
      }
      if (name === 'require' && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
        const source = this.module(node.arguments[0].text, node.getSourceFile().fileName);
        if (source) return [next(source)];
      }
      if (['Page', 'Component', 'Behavior', 'VantComponent', 'definePageConfig', 'defineComponentConfig'].includes(name)) {
        const kind = name === 'Page' ? 'page' : name === 'Behavior' ? 'behavior' : ['Component', 'VantComponent'].includes(name) ? 'component' : undefined;
        return node.arguments[0] ? this.resolve(next(node.arguments[0]), seen).map((item) => ({ ...item, ...(kind ? { registrationKind: kind as NonNullable<Value['registrationKind']> } : {}) })) : [];
      }
      const target = this.callTarget(node);
      if (name === '__assign' || ts.isPropertyAccessExpression(target) && target.name.text === 'assign' && ts.isIdentifier(target.expression) && target.expression.text === 'Object') {
        // 合并仅复制静态成员，保留声明位置，并按实参顺序覆盖同名字段。
        const members = new Map<string, Value[]>();
        for (const argument of node.arguments) for (const [key, items] of this.fields(next(argument), seen)) members.set(key, items);
        return [{ ...value, members, closed: node.arguments.every((argument) => this.closed(next(argument))) }];
      }
      const result: Value[] = [];
      for (const callee of this.resolve(next(target), seen)) result.push(...this.returns(callee, node.arguments.map((item) => next(item)), seen));
      if (result.length) return result;
      const native = this.nativeCalls(value, new Set([...seen].filter((item) => item !== node)));
      return native.length ? native : [value];
    }
    if (ts.isExportAssignment(node)) return this.resolve(next(node.expression), seen);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) return this.resolve(next(node.right), seen);
    return [value];
  }

  /** 解析函数直接或分支返回值，跳过未执行的嵌套函数声明。 */
  returns(value: Value, arguments_: readonly Value[] = [], seen = new Set<ts.Node>()): Value[] {
    const { node } = value;
    if (!(ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)) || !node.body) return [];
    const bindings = this.invoke(value, arguments_).bindings;
    const expressions: ts.Expression[] = [];
    /** 静态收集当前函数中的返回分支，不进入其他函数体。 */
    const visit = (child: ts.Node): void => {
      if (ts.isFunctionLike(child)) return;
      if (ts.isReturnStatement(child) && child.expression) expressions.push(child.expression);
      else ts.forEachChild(child, visit);
    };
    if (ts.isBlock(node.body)) visit(node.body);
    else expressions.push(node.body);
    return expressions.flatMap((expression) => this.resolve({ node: expression, bindings }, seen));
  }

  /** 合并对象成员时遵循展开顺序；条件分支保留多个可能定义。 */
  fields(value: Value, seen = new Set<ts.Node>()): Map<string, Value[]> {
    const result = new Map<string, Value[]>();
    for (const resolved of this.resolve(value, seen)) {
      if (seen.has(resolved.node)) continue;
      if (resolved.members) {
        for (const [name, items] of resolved.members) result.set(name, [...(result.get(name) ?? []), ...items]);
        continue;
      }
      if (resolved.template || resolved.items) continue;
      const visited = new Set(seen).add(resolved.node);
      const own = new Map<string, Value[]>();
      if (!resolved.runtimeType && ts.isObjectLiteralExpression(resolved.node)) {
        for (const property of resolved.node.properties) {
          if (ts.isSpreadAssignment(property)) {
            for (const [name, values] of this.fields({ ...resolved, node: property.expression }, visited)) own.set(name, values);
          } else {
            const name = this.name(property.name);
            if (name) own.set(name, [{ node: property, declaration: property.name, bindings: resolved.bindings }]);
          }
        }
      } else if (ts.isEnumDeclaration(resolved.node)) {
        for (const member of resolved.node.members) {
          const name = this.name(member.name);
          if (name) own.set(name, [{ node: member, declaration: member.name, bindings: resolved.bindings }]);
        }
      } else if (ts.isSourceFile(resolved.node)) {
        if (/\.json$/i.test(resolved.node.fileName)) {
          const statement = resolved.node.statements[0];
          if (statement && ts.isExpressionStatement(statement)) for (const [name, items] of this.fields({ ...resolved, node: statement.expression }, visited)) own.set(name, items);
        }
        const symbol = this.checker.getSymbolAtLocation(resolved.node);
        if (symbol && !/\.json$/i.test(resolved.node.fileName)) for (const member of this.checker.getExportsOfModule(symbol)) own.set(member.name, this.symbols(member, resolved.bindings));
        // CommonJS 的运行时导出没有可靠的类型别名链，按静态赋值顺序读取。
        for (const statement of resolved.node.statements) {
          if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression) || statement.expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) continue;
          const { left, right } = statement.expression;
          const path = left.getText(resolved.node).replace(/\s/g, '');
          if (path === 'module.exports') {
            own.clear();
            for (const [name, items] of this.fields({ node: right, bindings: resolved.bindings }, visited)) own.set(name, items);
          } else if (/^(?:module\.)?exports\.[\w$]+$/.test(path) && ts.isPropertyAccessExpression(left)) {
            own.set(left.name.text, [{ node: right, declaration: left.name, bindings: resolved.bindings }]);
          }
        }
      }
      if (!ts.isSourceFile(resolved.node)) {
        const classSymbol = (ts.isClassDeclaration(resolved.node) || ts.isClassExpression(resolved.node)) && resolved.node.name ? this.checker.getSymbolAtLocation(resolved.node.name) : undefined;
        const type = resolved.runtimeType ?? resolved.type ?? (classSymbol ? this.checker.getTypeOfSymbolAtLocation(classSymbol, resolved.node) : this.checker.getTypeAtLocation(resolved.node));
        const inferred = new Map<string, Value[]>();
        for (const part of type.isUnion() ? type.types : [type]) {
          for (const member of this.checker.getPropertiesOfType(part)) {
            const declared = !!(resolved.runtimeType || resolved.type);
            if (!own.has(member.name) || declared) {
              // 显式对象类型覆盖初始化值的窄类型，成员仍保留原始声明位置。
              const items = own.get(member.name) ?? this.symbols(member, resolved.bindings);
              inferred.set(member.name, [...(inferred.get(member.name) ?? []), ...items.map((item) => declared ? { ...item, runtimeType: this.checker.getTypeOfSymbolAtLocation(member, resolved.node) } : item)]);
            }
          }
        }
        for (const [name, items] of inferred) own.set(name, items);
      }
      for (const [name, values] of own) result.set(name, [...(result.get(name) ?? []), ...values]);
    }
    return result;
  }

  /** 静态数组下标只返回对应元素，未知长度则保留类型候选。 */
  element(value: Value, index: number, seen = new Set<ts.Node>()): Value[] {
    return this.resolve(value, seen).flatMap((resolved) => {
      const items = this.elements(resolved, seen);
      if (resolved.items) return items.slice(index, index + 1);
      return ts.isArrayLiteralExpression(resolved.node) && !resolved.node.elements.some(ts.isSpreadElement) ? items.slice(index, index + 1) : items;
    });
  }

  /** 读取数组元素或类型中的数字索引，用于循环项及静态下标。 */
  elements(value: Value, seen = new Set<ts.Node>()): Value[] {
    const result: Value[] = [];
    for (const resolved of this.resolve(value, seen)) {
      if (resolved.items) { result.push(...resolved.items); continue; }
      if (resolved.template || resolved.members || ts.isSourceFile(resolved.node)) continue;
      if (ts.isArrayLiteralExpression(resolved.node)) {
        for (const element of resolved.node.elements) {
          if (ts.isSpreadElement(element)) result.push(...this.elements({ ...resolved, node: element.expression }, new Set(seen).add(resolved.node)));
          else result.push({ node: element, bindings: resolved.bindings });
        }
      }
      const type = resolved.type ?? this.checker.getTypeAtLocation(resolved.node);
      const element = this.checker.getIndexTypeOfType(type, ts.IndexKind.Number);
      if (element && !result.length) result.push({ ...resolved, type: element });
    }
    return result;
  }

  /** 只选取实际顶层注册或默认导出，排除无关导入中的同名符号。 */
  registration(source: ts.SourceFile, includeFactories = false): Value[] {
    const calls: Value[] = [];
    const behaviors: Value[] = [];
    /** 页面工厂体不等于当前文件已经注册的页面。 */
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionLike(node) && !includeFactories) return;
      if (ts.isCallExpression(node) && ['Page', 'Component', 'VantComponent'].includes(this.callName(node))) calls.push(this.value(node));
      else if (ts.isCallExpression(node) && this.callName(node) === 'Behavior') behaviors.push(this.value(node));
      else if (ts.isCallExpression(node)) {
        const value = this.value(node);
        const registered = this.resolve(value).filter((item) => item.registrationKind);
        if (registered.some((item) => item.registrationKind !== 'behavior')) calls.push(value);
        else if (registered.length) behaviors.push(value);
        else ts.forEachChild(node, visit);
      }
      else ts.forEachChild(node, visit);
    };
    visit(source);
    if (includeFactories && (calls.length || behaviors.length)) return [...calls, ...behaviors];
    if (calls.length) return calls;
    if (behaviors.length) return behaviors;
    for (const statement of source.statements) {
      if (ts.isExportAssignment(statement)) return [this.value(statement.expression)];
      if (ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression) && statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken && statement.expression.left.getText(source).replace(/\s/g, '') === 'module.exports') return [this.value(statement.expression.right)];
    }
    const symbol = this.checker.getSymbolAtLocation(source);
    const exported = symbol && this.checker.getExportsOfModule(symbol).find((item) => item.name === 'default' || item.name === 'export=');
    return exported ? this.symbols(exported, new Map()) : [];
  }

  /** 原生参数构造类型及显式 PropType 投影为运行时值，定义仍保留参数声明。 */
  private propertyValues(items: readonly Value[]): Value[] {
    const result: Value[] = [];
    for (const item of items) {
      const before = result.length;
      const spec = this.fields(item);
      const constructors = [...spec.get('type') ?? [item], ...spec.get('optionalTypes')?.flatMap((value) => this.elements(value)) ?? []];
      for (const candidate of constructors) {
        const node = ts.isPropertyAssignment(candidate.node) ? candidate.node.initializer : candidate.node;
        let type: ts.Type | undefined;
        if ((ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) && ts.isTypeReferenceNode(node.type) && /(?:^|\.)PropType$/.test(node.type.typeName.getText()) && node.type.typeArguments?.[0]) type = this.checker.getTypeFromTypeNode(node.type.typeArguments[0]);
        else {
          const name = this.resolve(candidate).map((value) => ts.isVariableDeclaration(value.node) ? this.name(value.node.name) : value.node.getText()).find((name) => ['String', 'Number', 'Boolean', 'Object', 'Array', 'Function'].includes(name ?? '')) ?? node.getText();
          type = name === 'String' ? this.checker.getStringType() : name === 'Number' ? this.checker.getNumberType() : name === 'Boolean' ? this.checker.getBooleanType() : undefined;
          if (!type && ['Object', 'Array', 'Function'].includes(name)) {
            const constructor = this.checker.getTypeAtLocation(node);
            const signature = this.checker.getSignaturesOfType(constructor, ts.SignatureKind.Construct)[0];
            type = signature ? this.checker.getReturnTypeOfSignature(signature) : this.checker.getAnyType();
          }
        }
        if (type) result.push({ ...item, type, runtimeType: type });
      }
      if (result.length === before) {
        const defaults = spec.get('value') ?? spec.get('default') ?? [];
        const unknown = this.checker.getAnyType();
        result.push(...defaults.length ? defaults.flatMap((value) => this.resolve(value)).map((value) => ({ ...value, declaration: item.declaration ?? value.node })) : [{ ...item, type: unknown, runtimeType: unknown }]);
      }
    }
    return result;
  }

  /** 数据路径只读取状态和属性，实例方法或自定义导出不会覆盖内部 data 字段。 */
  dataContext(value: Value, seen = new Set<ts.Node>()): Map<string, Value[]> {
    const result = new Map<string, Value[]>();
    for (const resolved of this.resolve(value)) {
      if (seen.has(resolved.node) || seen.size > 80 || this.cancelled()) continue;
      const visited = new Set(seen).add(resolved.node);
      const fields = this.fields(resolved);
      for (const group of ['behaviors', 'mixins']) for (const list of fields.get(group) ?? []) for (const inherited of this.elements(list)) {
        for (const [name, members] of this.dataContext(inherited, visited)) result.set(name, members);
      }
      for (const group of ['properties', 'props', 'data', 'template', 'setup']) for (const section of fields.get(group) ?? []) {
        const candidates = this.resolve(section).flatMap((item) => ts.isFunctionLike(item.node) ? this.returns(item) : [item]);
        for (const candidate of candidates) for (const [name, members] of this.fields(candidate)) {
          if (group === 'properties' || group === 'props') result.set(name, this.propertyValues(members));
          else if (!['setup', 'template'].includes(group) || !members.every((member) => this.resolve(member).every((item) => ts.isFunctionLike(item.node)))) result.set(name, members);
        }
      }
    }
    return result;
  }

  /** 提取页面公开上下文，Behavior 的成员允许被当前页面显式覆盖。 */
  context(value: Value, seen = new Set<ts.Node>()): Map<string, Value[]> {
    const result = new Map<string, Value[]>();
    for (const resolved of this.resolve(value)) {
      if (seen.has(resolved.node) || seen.size > 80) continue;
      const members = new Map<string, Value[]>();
      const visited = new Set(seen).add(resolved.node);
      const fields = this.fields(resolved);
      for (const group of ['behaviors', 'mixins']) {
        for (const list of fields.get(group) ?? []) for (const behavior of this.elements(list)) {
          for (const [name, values] of this.context(behavior, visited)) members.set(name, values);
        }
      }
      for (const group of ['data', 'properties', 'props', 'template', 'setup', 'methods']) {
        for (const section of fields.get(group) ?? []) {
          const values = this.resolve(section).flatMap((item) => ts.isFunctionLike(item.node) ? this.returns(item) : [item]);
          for (const candidate of values) for (const [name, values] of this.fields(candidate)) {
            if (group === 'properties' || group === 'props') {
              members.set(name, this.propertyValues(values));
            } else members.set(name, values);
          }
        }
      }
      for (const [name, values] of fields) {
        if (['data', 'properties', 'props', 'template', 'setup', 'methods', 'behaviors', 'mixins'].includes(name)) continue;
        if (values.some((item) => this.resolve(item).some((resolved) => ts.isFunctionLike(resolved.node)))) members.set(name, values);
      }
      for (const [name, items] of members) result.set(name, [...(result.get(name) ?? []), ...items]);
    }
    return result;
  }
}
