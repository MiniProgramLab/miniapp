/** 页面状态的原始枚举声明。 */
export enum PageState {
  Ready = 'ready',
  Loading = 'loading',
}

/** 经重导出及页面别名向模板暴露的原始变量。 */
export const pageTitle = '小程序引用链示例';

/** 模板事件绑定最终定位的原始函数。 */
export function handleOpen(): void {}

/** 示例数据模型，用于验证实例方法和属性。 */
export class PageModel {
  /** 模板显示的模型名称。 */
  name = '示例模型';

  /** 模板中可查看声明的实例方法。 */
  save(): void {}
}

/** 循环项成员的类型来源。 */
export interface Row {
  /** 列表项的显示名称。 */
  label: string;
}
