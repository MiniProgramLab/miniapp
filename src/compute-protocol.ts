import type { DocumentSnapshot, NavigationStep, WorkspaceDependency } from './api';
import type { ScriptSettings } from './api/compute';

/** 一次请求的资源设置快照，线程内不访问编辑器配置。 */
export type ComputeSettings = Record<string, ScriptSettings>;
/** 只准备固定编译器，不读取或解析工程文件。 */
export interface ComputePrepare { kind: 'prepare' }
/** 准备完成仍不表示任何工程查询已经执行。 */
export interface ComputeReady { kind: 'ready'; error?: string }
/** 工作线程只接收普通数据、共享取消位和公共端口名称。 */
export interface ComputeRequest {
  kind: 'query'; id: number; method: string; args: unknown[];
  document: DocumentSnapshot; offset: number; settings: Record<string, ComputeSettings>; roots: readonly string[];
  cancellation: SharedArrayBuffer; deferCompletionDetails: boolean; navigation: boolean;
  baseline: readonly WorkspaceDependency[];
  scope?: number;
}
/** 宿主文件系统响应保留读取前修订，过期数据由调用链丢弃。 */
export interface ComputeReply {
  kind: 'result'; id: number; value?: unknown; error?: string;
  dependencies: readonly WorkspaceDependency[]; steps: readonly NavigationStep[]; stale: boolean;
  unobserved: readonly string[];
}
/** 文件系统仍由宿主读取，工作线程兼容远程和虚拟工作区。 */
export interface ComputeRead { kind: 'read'; id: number; job: number; method: 'read' | 'directory' | 'findFiles'; args: unknown[] }
/** 单次异步文件响应不覆盖其他调用者已观察到的旧修订。 */
export interface ComputeReadReply { kind: 'read-result'; id: number; value?: unknown; error?: string; dependencies: readonly WorkspaceDependency[]; stale: boolean }
/** 配置和工作区变化清除线程内缓存，文件事件更新对应修订。 */
export interface ComputeChange { kind: 'change'; uri?: string; change?: 'content' | 'structure' | 'open' | 'close' | 'configuration' }
