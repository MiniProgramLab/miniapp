/** 卡片的公共权限属性，供组件继承。 */
export default Behavior({
  properties: {
    /** 是否允许编辑卡片。 */
    hasPower: { type: Boolean, value: true },
  },
});
