import type ts from 'typescript/lib/tsserverlibrary';

/** 使用宿主注入的编译器，兼容工程版和编辑器内置的 TypeScript。 */
export default function initialize({ typescript }: { typescript: typeof ts }): ts.server.PluginModule {
  return {
    /** 只修正已存在样式文件的副作用导入诊断，其他语言能力交给原服务。 */
    create(info) {
      const service = info.languageService;
      const proxy = Object.create(null) as ts.LanguageService;
      for (const key of Object.keys(service) as (keyof ts.LanguageService)[]) {
        const method = service[key];
        if (typeof method === 'function') Reflect.set(proxy, key, (...args: unknown[]) => Reflect.apply(method, service, args));
      }

      /** 借用原生模块解析处理相对路径、paths 和包路径，不写入虚拟声明。 */
      function exists(specifier: string, filename: string, options: ts.CompilerOptions): boolean {
        const host: ts.ModuleResolutionHost = {
          readFile: (file) => info.serverHost.readFile(file),
          directoryExists: (directory) => info.serverHost.directoryExists(directory),
          getCurrentDirectory: () => info.languageServiceHost.getCurrentDirectory(),
          /** 仅在本次探测中将任意扩展声明映射到实际样式文件。 */
          fileExists(file) {
            if (info.serverHost.fileExists(file)) return true;
            const style = file.match(/^(.*)\.d\.(css|wxss|scss|less)\.ts$/i);
            return !!style && info.serverHost.fileExists(`${style[1]}.${style[2]}`);
          },
        };
        const resolved = typescript.resolveModuleName(specifier, filename, { ...options, allowArbitraryExtensions: true }, host).resolvedModule;
        const style = resolved?.resolvedFileName.match(/^(.*)\.d\.(css|wxss|scss|less)\.ts$/i);
        return !!style && info.serverHost.fileExists(`${style[1]}.${style[2]}`);
      }

      /** 每次查询核对真实文件，避免删除样式后仍沿用已消除的诊断。 */
      proxy.getSemanticDiagnostics = (filename) => {
        const diagnostics = service.getSemanticDiagnostics(filename);
        if (!diagnostics.some((item) => item.code === 2307 || item.code === 2882)) return diagnostics;
        const program = service.getProgram();
        const source = program?.getSourceFile(filename);
        if (!source || !program) return diagnostics;
        const imports = source.statements.filter((node): node is ts.ImportDeclaration => typescript.isImportDeclaration(node)
          && !node.importClause && typescript.isStringLiteral(node.moduleSpecifier) && /\.(css|wxss|scss|less)$/i.test(node.moduleSpecifier.text));
        return diagnostics.filter((item) => {
          if ((item.code !== 2307 && item.code !== 2882) || item.start === undefined) return true;
          const start = item.start;
          const statement = imports.find((node) => start >= node.moduleSpecifier.getStart(source) && start < node.moduleSpecifier.end);
          return !statement || !exists((statement.moduleSpecifier as ts.StringLiteral).text, filename, program.getCompilerOptions());
        });
      };
      return proxy;
    },
  };
}
