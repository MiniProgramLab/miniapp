import { Status as LocalStatus, title as caption, open as handler, PageModel, createDetails } from './scripts';
import type { Row } from './scripts';

/** 示例在扩展开发窗口中静态读取，不依赖小程序运行环境。 */
declare function Page(options: object): void;

/** 显式类型使空数组的循环项也能跳到接口字段。 */
const rows: Row[] = [];

Page({
  data: { caption, Status: LocalStatus, model: new PageModel(), rows, openAction: handler, details: createDetails() },
  methods: {
    onOpen: handler,
    /** 页面直接声明的方法。 */
    onLocalTap(): void {},
  },
});
