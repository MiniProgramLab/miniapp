/** 独立模板最终可以追踪到的数据源。 */
export const settings = { card: { title: '模板数据依赖链示例' } };

/** 静态计算属性沿常量别名查找原始字段。 */
const titleKey = 'title';

/** 工厂通过嵌套解构取得标题，不需要在导航时实际执行。 */
export function buildCard({ card: { title } }: typeof settings): { heading: string } {
  return { heading: title };
}

/** 组合解构、常量下标和工厂调用，向页面暴露统一的数据模型。 */
export function createDetails(): { heading: string } {
  const { card } = settings;
  const renamedKey = titleKey;
  return buildCard({ card: { title: card[renamedKey] } });
}
