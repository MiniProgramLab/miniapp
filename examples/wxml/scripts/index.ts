/** 第二层重命名导出，用于验证导航不会停留在中转层。 */
export { PageState as Status, pageTitle as title, handleOpen as open, PageModel } from './bridge';
export type { Row } from './bridge';
export { createDetails } from './bridge';
