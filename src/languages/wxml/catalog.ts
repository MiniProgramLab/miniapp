import type { SemanticType } from '../../api';
import { componentEvents } from './component-events';

/** 平台和外部元数据共用版本、弃用及文档说明字段。 */
export interface DocumentationData {
  readonly description: string;
  readonly since?: string;
  readonly deprecated?: string;
  readonly references?: readonly { readonly name: string; readonly url: string }[];
  readonly source?: string;
}

/** 属性的静态文档与元数据使用同一补全结构。 */
export interface AttributeData extends DocumentationData {
  readonly name: string;
  readonly type: string;
  readonly values?: readonly string[];
  readonly boolean?: boolean;
  readonly defaultValue?: string;
  readonly required?: boolean;
  readonly valueDescriptions?: Readonly<Record<string, string>>;
  readonly detail?: SemanticType;
}

/** 组件名称、用途与自身属性在语言模块内部维护。 */
export interface TagData extends DocumentationData {
  readonly name: string;
  readonly attributes: readonly AttributeData[];
}

/** 说明保留原始文档文字，宿主统一按普通文本安全渲染。 */
export function documentation(data: DocumentationData & { readonly defaultValue?: string; readonly required?: boolean; readonly detail?: SemanticType }): string {
  return [data.description, data.defaultValue === undefined ? '' : `默认值：${data.defaultValue}`, data.required ? '必填参数' : '', data.since ? `最低基础库：${data.since}` : '', data.deprecated ? `弃用说明：${data.deprecated}` : '',
    data.detail ? `事件 detail：${data.detail.display}` : '', data.source ? `元数据来源：${data.source}` : '', ...(data.references ?? []).map((reference) => `文档：${reference.name} ${reference.url}`)].filter(Boolean).join('\n');
}

/** 平台标签不参与组件注册检查；目录覆盖基础组件和 Skyline 的结构组件。 */
export const nativeTags: ReadonlySet<string> = new Set([
  'view', 'text', 'image', 'button', 'input', 'textarea', 'scroll-view', 'block', 'template', 'import', 'include', 'wxs', 'slot',
  'swiper', 'swiper-item', 'movable-area', 'movable-view', 'cover-view', 'cover-image', 'icon', 'progress', 'rich-text',
  'form', 'label', 'checkbox', 'checkbox-group', 'radio', 'radio-group', 'picker', 'picker-view', 'picker-view-column', 'slider', 'switch', 'editor',
  'navigator', 'functional-page-navigator', 'audio', 'video', 'camera', 'live-player', 'live-pusher', 'map', 'canvas', 'web-view',
  'ad', 'ad-custom', 'open-data', 'official-account', 'navigation-bar', 'page-meta', 'page-container', 'match-media', 'root-portal',
  'grid-view', 'list-view', 'list-builder', 'grid-builder', 'sticky-header', 'sticky-section', 'draggable-sheet', 'span',
  'channel-live', 'channel-video', 'voip-room', 'snapshot', 'share-element', 'xr-frame', 'xr-scene', 'selection', 'app-bar',
]);

/** 基础节点属性与 WXML 指令，文档随扩展版本静态交付。 */
const commonAttributes: readonly AttributeData[] = [
  { name: 'id', type: 'string', description: '节点的唯一标识。' },
  { name: 'class', type: 'string', description: '节点样式类，多个类名使用空格分隔。' },
  { name: 'style', type: 'string', description: '节点的内联样式。' },
  { name: 'hidden', type: 'boolean', description: '是否隐藏节点。', values: ['{{true}}', '{{false}}'] },
  { name: 'wx:if', type: 'expression', description: '表达式为真时渲染该节点，通常使用 {{condition}}。' },
  { name: 'wx:elif', type: 'expression', description: '与相邻的 wx:if 或 wx:elif 配合进行条件分支判断。' },
  { name: 'wx:else', type: 'boolean', description: '前面的条件分支均不成立时渲染，无需填写属性值。', boolean: true },
  { name: 'wx:for', type: 'expression', description: '遍历数组并重复渲染节点，默认变量名为 item 和 index。' },
  { name: 'wx:for-item', type: 'string', description: '指定循环中当前项的变量名，默认是 item。' },
  { name: 'wx:for-index', type: 'string', description: '指定循环中下标的变量名，默认是 index。' },
  { name: 'wx:key', type: 'string', description: '指定列表项的唯一标识字段；基础类型且自身唯一时可使用 *this。' },
  { name: 'bindtap', type: 'event', description: '绑定点击事件处理函数，允许事件继续冒泡。' },
  { name: 'catchtap', type: 'event', description: '绑定点击事件处理函数，并阻止事件继续冒泡。' },
];

/** 首批组件目录，后续扩展只改语言模块，无需修改底座。 */
const baseTags: readonly TagData[] = [
  { name: 'view', description: '视图容器，用于组织页面结构。', attributes: [
    { name: 'hover-class', type: 'string', description: '按下时添加的样式类，none 表示不改变样式。' },
  ] },
  { name: 'text', description: '文本组件，用于展示文字。', attributes: [
    { name: 'user-select', type: 'boolean', description: '是否允许选中文本。', values: ['{{true}}', '{{false}}'] },
    { name: 'space', type: 'string', description: '连续空格的显示方式。', values: ['ensp', 'emsp', 'nbsp'] },
    { name: 'decode', type: 'boolean', description: '是否解码部分 HTML 字符实体。', values: ['{{true}}', '{{false}}'] },
  ] },
  { name: 'image', description: '图片组件，支持缩放和裁剪。', attributes: [
    { name: 'src', type: 'string', description: '图片资源地址。' },
    { name: 'mode', type: 'string', description: '图片缩放或裁剪模式。', values: ['scaleToFill', 'aspectFit', 'aspectFill', 'widthFix', 'heightFix', 'center'] },
    { name: 'lazy-load', type: 'boolean', description: '是否延迟加载图片。', values: ['{{true}}', '{{false}}'] },
  ] },
  { name: 'button', description: '按钮组件。', attributes: [
    { name: 'type', type: 'string', description: '按钮样式类型。', values: ['primary', 'default', 'warn'] },
    { name: 'size', type: 'string', description: '按钮大小。', values: ['default', 'mini'] },
    { name: 'disabled', type: 'boolean', description: '是否禁用按钮。', values: ['{{true}}', '{{false}}'] },
    { name: 'loading', type: 'boolean', description: '是否显示加载状态。', values: ['{{true}}', '{{false}}'] },
  ] },
  { name: 'input', description: '输入框组件。', attributes: [
    { name: 'value', type: 'string', description: '输入框当前内容。' },
    { name: 'placeholder', type: 'string', description: '输入框为空时显示的提示文字。' },
    { name: 'type', type: 'string', description: '输入内容类型。', values: ['text', 'number', 'idcard', 'digit'] },
    { name: 'bindinput', type: 'event', description: '输入内容变化时触发。' },
  ] },
  { name: 'scroll-view', description: '可滚动的视图区域。', attributes: [
    { name: 'scroll-x', type: 'boolean', description: '是否允许横向滚动。', values: ['{{true}}', '{{false}}'] },
    { name: 'scroll-y', type: 'boolean', description: '是否允许纵向滚动。', values: ['{{true}}', '{{false}}'] },
  ] },
  { name: 'block', description: '不渲染为实际节点的包裹元素，常与条件和列表指令配合使用。', attributes: [] },
  { name: 'template', description: '定义可复用模板，或引用已有模板。', attributes: [
    { name: 'name', type: 'string', description: '定义模板时使用的名称。' },
    { name: 'is', type: 'string', description: '引用模板时使用的名称。' },
    { name: 'data', type: 'expression', description: '传入模板的数据对象。' },
  ] },
  { name: 'import', description: '导入其他 WXML 文件中定义的模板。', attributes: [
    { name: 'src', type: 'string', description: '待导入的 WXML 文件路径。' },
  ] },
  { name: 'include', description: '将其他 WXML 文件的内容引入当前位置。', attributes: [
    { name: 'src', type: 'string', description: '待引入的 WXML 文件路径。' },
  ] },
  { name: 'slot', description: '组件插槽，用于接收组件使用方提供的内容。', attributes: [
    { name: 'name', type: 'string', description: '具名插槽的名称。' },
  ] },
];

/** 基础属性统一描述类型与枚举，不将布尔属性误当作无值 HTML 属性。 */
function property(name: string, type: string, description: string, values?: readonly string[]): AttributeData {
  return { name, type, description, ...(values ? { values } : type === 'boolean' ? { values: ['{{true}}', '{{false}}'] } : {}) };
}

/** 常用原生组件属性与官方事件快照分开维护，未知版本不补造最低要求。 */
const extraAttributes: Readonly<Record<string, readonly AttributeData[]>> = {
  view: [property('hover-stop-propagation', 'boolean', '按下态是否阻止祖先节点进入按下态。'), property('hover-start-time', 'number', '进入按下态前的延迟毫秒数。'), property('hover-stay-time', 'number', '松开后保留按下态的毫秒数。')],
  image: [property('mode', 'string', '图片缩放与裁剪方式。', ['scaleToFill', 'aspectFit', 'aspectFill', 'widthFix', 'heightFix', 'top', 'bottom', 'center', 'left', 'right', 'top left', 'top right', 'bottom left', 'bottom right']), property('show-menu-by-longpress', 'boolean', '长按时显示图片菜单。'), property('webp', 'boolean', '是否启用 WebP 支持。')],
  button: [property('plain', 'boolean', '是否使用镂空按钮样式。'), property('form-type', 'string', '按钮对应的表单操作。', ['submit', 'reset']), property('open-type', 'string', '平台开放能力类型。', ['contact', 'share', 'getPhoneNumber', 'openSetting', 'launchApp', 'chooseAvatar', 'agreePrivacyAuthorization']), property('hover-class', 'string', '按钮按下态的样式类。')],
  input: [property('password', 'boolean', '是否隐藏输入内容。'), property('disabled', 'boolean', '是否禁用输入。'), property('maxlength', 'number', '允许输入的最大长度。'), property('focus', 'boolean', '是否获取焦点。'), property('confirm-type', 'string', '键盘确认按钮的文字。', ['send', 'search', 'next', 'go', 'done']), property('confirm-hold', 'boolean', '确认后是否保留键盘。'), property('cursor', 'number', '指定输入光标位置。'), property('selection-start', 'number', '文本选择起始位置。'), property('selection-end', 'number', '文本选择结束位置。'), property('adjust-position', 'boolean', '键盘弹起时是否自动调整页面位置。'), property('placeholder-class', 'string', '占位文本样式类。')],
  textarea: [property('value', 'string', '文本内容。'), property('placeholder', 'string', '占位提示。'), property('disabled', 'boolean', '是否禁用输入。'), property('maxlength', 'number', '允许输入的最大长度。'), property('auto-height', 'boolean', '是否根据内容自动调整高度。'), property('focus', 'boolean', '是否获取焦点。'), property('show-confirm-bar', 'boolean', '是否显示键盘上方的确认栏。'), property('adjust-position', 'boolean', '键盘弹起时是否自动调整页面位置。')],
  'scroll-view': [property('upper-threshold', 'number | string', '触发上边界事件的距离。'), property('lower-threshold', 'number | string', '触发下边界事件的距离。'), property('scroll-top', 'number | string', '竖向滚动位置。'), property('scroll-left', 'number | string', '横向滚动位置。'), property('scroll-into-view', 'string', '滚动到的子节点 id。'), property('scroll-with-animation', 'boolean', '滚动位置变化时是否使用动画。'), property('enable-flex', 'boolean', '是否启用内部 Flex 布局。'), property('enhanced', 'boolean', '是否开启增强滚动能力。'), property('refresher-enabled', 'boolean', '是否开启自定义下拉刷新。'), property('refresher-triggered', 'boolean', '当前下拉刷新状态。'), property('refresher-default-style', 'string', '下拉刷新指示器样式。', ['black', 'white', 'none'])],
  swiper: [property('indicator-dots', 'boolean', '是否显示分页指示点。'), property('autoplay', 'boolean', '是否自动播放。'), property('current', 'number', '当前项目下标。'), property('interval', 'number', '自动切换间隔毫秒数。'), property('duration', 'number', '切换动画时长毫秒数。'), property('circular', 'boolean', '是否循环切换。'), property('vertical', 'boolean', '是否竖向切换。'), property('previous-margin', 'string', '前一个项目露出的边距。'), property('next-margin', 'string', '后一个项目露出的边距。')],
  'swiper-item': [property('item-id', 'string', '项目标识。')],
  navigator: [property('url', 'string', '导航页面地址。'), property('open-type', 'string', '页面导航方式。', ['navigate', 'redirect', 'switchTab', 'reLaunch', 'navigateBack', 'exit']), property('target', 'string', '导航目标。', ['self', 'miniProgram']), property('delta', 'number', '返回的页面层数。'), property('hover-class', 'string', '按下态样式类。')],
  picker: [property('mode', 'string', '选择器模式。', ['selector', 'multiSelector', 'time', 'date', 'region']), property('range', 'array', '选择器候选项。'), property('range-key', 'string', '对象候选项的展示字段。'), property('value', 'number | string | array', '当前选中值。'), property('disabled', 'boolean', '是否禁用选择。'), property('start', 'string', '可选时间或日期的起点。'), property('end', 'string', '可选时间或日期的终点。')],
  'picker-view': [property('value', 'array', '各列的当前选中下标。'), property('indicator-style', 'string', '选中行的内联样式。'), property('indicator-class', 'string', '选中行的样式类。')],
  switch: [property('checked', 'boolean', '是否选中。'), property('disabled', 'boolean', '是否禁用。'), property('type', 'string', '展示类型。', ['switch', 'checkbox']), property('color', 'string', '选中颜色。')],
  slider: [property('min', 'number', '最小值。'), property('max', 'number', '最大值。'), property('step', 'number', '步长。'), property('value', 'number', '当前值。'), property('disabled', 'boolean', '是否禁用。'), property('show-value', 'boolean', '是否展示当前值。')],
  checkbox: [property('value', 'string', '选项值。'), property('checked', 'boolean', '是否选中。'), property('disabled', 'boolean', '是否禁用。'), property('color', 'string', '选中颜色。')],
  radio: [property('value', 'string', '选项值。'), property('checked', 'boolean', '是否选中。'), property('disabled', 'boolean', '是否禁用。'), property('color', 'string', '选中颜色。')],
  form: [property('report-submit', 'boolean', '是否提交表单标识。')],
  label: [property('for', 'string', '关联控件的 id。')],
  icon: [property('type', 'string', '图标类型。', ['success', 'success_no_circle', 'info', 'warn', 'waiting', 'cancel', 'download', 'search', 'clear']), property('size', 'number | string', '图标大小。'), property('color', 'string', '图标颜色。')],
  progress: [property('percent', 'number', '进度百分比。'), property('show-info', 'boolean', '是否显示百分比。'), property('stroke-width', 'number | string', '进度条宽度。'), property('active', 'boolean', '是否启用进度动画。')],
  'rich-text': [property('nodes', 'array | string', '富文本节点。'), property('selectable', 'boolean', '文本是否可选。')],
  canvas: [property('type', 'string', '画布类型。', ['2d', 'webgl']), property('canvas-id', 'string', '画布标识。'), property('disable-scroll', 'boolean', '触摸时是否禁止页面滚动。')],
  map: [property('longitude', 'number', '中心经度。'), property('latitude', 'number', '中心纬度。'), property('scale', 'number', '缩放级别。'), property('markers', 'array', '标记点集合。'), property('polyline', 'array', '折线集合。'), property('show-location', 'boolean', '是否显示当前位置。')],
  video: [property('src', 'string', '视频地址。'), property('poster', 'string', '封面地址。'), property('controls', 'boolean', '是否显示播放控件。'), property('autoplay', 'boolean', '是否自动播放。'), property('loop', 'boolean', '是否循环播放。'), property('muted', 'boolean', '是否静音。'), property('object-fit', 'string', '视频缩放方式。', ['contain', 'fill', 'cover'])],
  'web-view': [property('src', 'string', '网页地址。')],
  camera: [property('device-position', 'string', '摄像头方向。', ['front', 'back']), property('flash', 'string', '闪光灯模式。', ['auto', 'on', 'off', 'torch']), property('mode', 'string', '相机模式。', ['normal', 'scanCode'])],
  'movable-area': [property('scale-area', 'boolean', '是否将缩放手势区域扩展到整个容器。')],
  'movable-view': [property('direction', 'string', '允许移动的方向。', ['all', 'vertical', 'horizontal', 'none']), property('x', 'number | string', '横向偏移。'), property('y', 'number | string', '纵向偏移。'), property('scale', 'boolean', '是否允许缩放。'), property('inertia', 'boolean', '是否启用惯性。')],
};

/** 原生目录合并官方事件快照，未提供版本的声明不猜测最低基础库。 */
export const tags: readonly TagData[] = [...nativeTags].map((name) => {
  const base = baseTags.find((item) => item.name === name);
  const events = componentEvents.find((item) => item.name === name)?.attributes ?? [];
  return { name, description: base?.description ?? '微信小程序原生组件。', attributes: [...new Map([...base?.attributes ?? [], ...extraAttributes[name] ?? [], ...events].map((attribute) => [attribute.name, attribute])).values()] };
});

/** 逻辑节点仅提供适用的指令，避免提示样式和点击事件。 */
export function attributesFor(tagName: string): readonly AttributeData[] {
  const own = tags.find((tag) => tag.name === tagName)?.attributes ?? [];
  if (['import', 'include', 'slot'].includes(tagName)) return own;
  const common = ['block', 'template'].includes(tagName) ? commonAttributes.filter((attribute) => attribute.name.startsWith('wx:')) : commonAttributes;
  return [...common, ...own];
}
