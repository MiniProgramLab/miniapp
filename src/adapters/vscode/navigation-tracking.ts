import { AsyncLocalStorage } from 'node:async_hooks';
import type { Disposable, NavigationStep, NavigationTracking } from '../../api';

/** 追踪仅在主动说明请求中启用，最多保存二百条去重步骤。 */
export function createNavigationTracking(): NavigationTracking & Disposable {
  const scopes = new AsyncLocalStorage<{ steps: NavigationStep[]; seen: Set<string> }>();
  return {
    /** 是否处于当前异步请求的说明作用域。 */
    get active() { return scopes.getStore() !== undefined; },
    /** 解析器可在缓存和异步读取路径中使用同一记录端口。 */
    record(step) {
      const scope = scopes.getStore();
      if (!scope) return;
      const key = JSON.stringify([step.code, step.message, step.uri]);
      if (scope.seen.has(key)) return;
      if (scope.steps.length >= 200) {
        // 显示上限不能隐藏真实解析预算，工作区检查依赖该标记判断完整性。
        if (step.code === 'budget' || step.code === 'error') {
          const index = scope.steps.findIndex((item) => item.code !== 'budget' && item.code !== 'error');
          if (index >= 0) scope.steps[index] = step;
          return;
        }
        if (scope.steps.length === 200) scope.steps.push({ code: 'context', message: '追踪记录达到二百条显示上限，后续步骤未展示；解析仍按原预算继续。' });
        return;
      }
      scope.seen.add(key); scope.steps.push(step);
    },
    /** AsyncLocalStorage 隔离并发和嵌套说明，不污染后台诊断。 */
    capture: (provide) => {
      const scope = { steps: [] as NavigationStep[], seen: new Set<string>() };
      return scopes.run(scope, async () => ({ value: await provide(), steps: scope.steps }));
    },
    /** 卸载后释放异步作用域。 */
    dispose: () => scopes.disable(),
  };
}
