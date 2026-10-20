import type { Disposable, LanguageHost, LanguagePlugin, Logger, MiniAppApi, PluginInfo } from '../api';
import { DisposableStore } from './disposable-store';

/** 已注册插件及其专属资源，禁止语言模块互相访问内部实例。 */
interface PluginEntry {
  readonly info: PluginInfo;
  readonly resources: DisposableStore;
}

/** 只管理注册与生命周期，不认识具体语言和 VS Code。 */
export class PluginRuntime implements Disposable {
  private readonly entries = new Map<string, PluginEntry>();
  private readonly pending = new Set<string>();
  private disposed = false;

  /** 由组合入口注入宿主与日志端口，落实依赖倒置。 */
  constructor(private readonly host: LanguageHost, private readonly logger: Logger) {}

  /** 隐藏生命周期管理细节，仅向外部扩展暴露稳定契约。 */
  createApi(): MiniAppApi {
    return Object.freeze({
      apiVersion: 1 as const,
      registerPlugin: (plugin: LanguagePlugin) => this.register(plugin),
      getPlugins: () => this.getPlugins(),
    });
  }

  /** 初始化及编辑器注册全部成功后才公开插件，失败时原子回滚。 */
  register(plugin: LanguagePlugin): Disposable {
    if (this.disposed) throw new Error('语言插件底座已关闭。');
    const info = Object.freeze({
      id: plugin.id,
      displayName: plugin.displayName,
      languages: Object.freeze([...plugin.languages]),
    });
    if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(info.id)) throw new Error('插件标识符格式无效。');
    if (!info.displayName.trim() || !info.languages.length || info.languages.some((id) => !id.trim())) {
      throw new Error(`插件 ${info.id} 必须声明名称和至少一种语言。`);
    }
    if (this.entries.has(info.id) || this.pending.has(info.id)) throw new Error(`插件 ${info.id} 已注册。`);
    const logger: Logger = {
      info: (message) => this.logger.info(`[${info.id}] ${message}`),
      error: (message, error) => this.logger.error(`[${info.id}] ${message}`, error),
    };
    const resources = new DisposableStore((error) => logger.error('释放插件资源失败。', error));
    this.pending.add(info.id);
    try {
      const features = plugin.setup({ logger, subscriptions: resources });
      if (this.disposed) throw new Error('初始化期间底座已关闭。');
      resources.add(this.host.register(info, features));
      if (this.disposed) throw new Error('注册期间底座已关闭。');
      const entry = { info, resources };
      this.entries.set(info.id, entry);
      return {
        /** 旧句柄不能卸载随后以相同标识符注册的新插件。 */
        dispose: () => {
          if (this.entries.get(info.id) !== entry) return;
          this.entries.delete(info.id);
          resources.dispose();
        },
      };
    } catch (error) {
      resources.dispose();
      throw error;
    } finally {
      this.pending.delete(info.id);
    }
  }

  /** 返回不可变描述，调用方无法修改底座的注册状态。 */
  getPlugins(): readonly PluginInfo[] {
    return Object.freeze([...this.entries.values()].map((entry) => entry.info));
  }

  /** 关闭整个底座，按注册顺序逆序清理插件。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const entries = [...this.entries.values()].reverse();
    this.entries.clear();
    for (const entry of entries) entry.resources.dispose();
  }
}
