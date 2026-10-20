import shared from './shared';

/** 展示信息并提供头部和操作插槽的卡片。 */
Component({
  behaviors: [shared],
  properties: {
    /** 展示在卡片顶部的标题。 */
    titleText: { type: String, value: '默认标题' },
  },
});
