import type { TagData } from './catalog';

/** 根据微信官方 miniprogram-api-typings 事件声明生成，更新使用 dev:metadata。 */
export const componentEvents: readonly TagData[] = [
  {
    "name": "cover-image",
    "description": "",
    "attributes": [
      {
        "name": "bindload",
        "type": "event",
        "description": "图片加载成功时触发",
        "since": "2.1.0",
        "detail": {
          "kind": "object",
          "display": "{ width: number; height: number }",
          "properties": {
            "width": {
              "kind": "number",
              "display": "number"
            },
            "height": {
              "kind": "number",
              "display": "number"
            }
          }
        },
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      },
      {
        "name": "binderror",
        "type": "event",
        "description": "图片加载失败时触发",
        "since": "2.1.0",
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      }
    ]
  },
  {
    "name": "movable-view",
    "description": "",
    "attributes": [
      {
        "name": "bindchange",
        "type": "event",
        "description": "拖动过程中触发的事件，event.detail = {x, y, source}",
        "since": "1.9.90",
        "detail": {
          "kind": "object",
          "display": "{ x: number; y: number; source: \"touch\" | \"touch-out-of-bounds\" | \"out-of-bounds\" | \"friction\" | \"\" }",
          "properties": {
            "x": {
              "kind": "number",
              "display": "number"
            },
            "y": {
              "kind": "number",
              "display": "number"
            },
            "source": {
              "kind": "unknown",
              "display": "\"touch\" | \"touch-out-of-bounds\" | \"out-of-bounds\" | \"friction\" | \"\"",
              "alternatives": [
                {
                  "kind": "string",
                  "display": "\"touch\"",
                  "literal": "touch"
                },
                {
                  "kind": "string",
                  "display": "\"touch-out-of-bounds\"",
                  "literal": "touch-out-of-bounds"
                },
                {
                  "kind": "string",
                  "display": "\"out-of-bounds\"",
                  "literal": "out-of-bounds"
                },
                {
                  "kind": "string",
                  "display": "\"friction\"",
                  "literal": "friction"
                },
                {
                  "kind": "string",
                  "display": "\"\"",
                  "literal": ""
                }
              ]
            }
          }
        },
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      },
      {
        "name": "bindscale",
        "type": "event",
        "description": "缩放过程中触发的事件\n\nevent.detail = {x, y, scale}\n\nx 和 y 字段在 2.1.0 之后支持",
        "since": "1.9.90",
        "detail": {
          "kind": "object",
          "display": "{ x: number; y: number; scale: number }",
          "properties": {
            "x": {
              "kind": "number",
              "display": "number"
            },
            "y": {
              "kind": "number",
              "display": "number"
            },
            "scale": {
              "kind": "number",
              "display": "number"
            }
          }
        },
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      }
    ]
  },
  {
    "name": "scroll-view",
    "description": "",
    "attributes": [
      {
        "name": "binddragstart",
        "type": "event",
        "description": "滑动开始事件 (同时开启 enhanced 属性后生效)\n\ndetail { scrollTop, scrollLeft }",
        "since": "2.12.0",
        "detail": {
          "kind": "object",
          "display": "{ scrollTop: number; scrollLeft: number }",
          "properties": {
            "scrollTop": {
              "kind": "number",
              "display": "number"
            },
            "scrollLeft": {
              "kind": "number",
              "display": "number"
            }
          }
        },
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      },
      {
        "name": "binddragging",
        "type": "event",
        "description": "滑动事件 (同时开启 enhanced 属性后生效)\n\ndetail { scrollTop, scrollLeft }",
        "since": "2.12.0",
        "detail": {
          "kind": "object",
          "display": "{ scrollTop: number; scrollLeft: number }",
          "properties": {
            "scrollTop": {
              "kind": "number",
              "display": "number"
            },
            "scrollLeft": {
              "kind": "number",
              "display": "number"
            }
          }
        },
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      },
      {
        "name": "binddragend",
        "type": "event",
        "description": "滑动结束事件 (同时开启 enhanced 属性后生效)\n\ndetail { scrollTop, scrollLeft }",
        "since": "2.12.0",
        "detail": {
          "kind": "object",
          "display": "{ scrollTop: number; scrollLeft: number }",
          "properties": {
            "scrollTop": {
              "kind": "number",
              "display": "number"
            },
            "scrollLeft": {
              "kind": "number",
              "display": "number"
            }
          }
        },
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      },
      {
        "name": "bindscrolltoupper",
        "type": "event",
        "description": "滚动到顶部/左边时触发",
        "detail": {
          "kind": "object",
          "display": "{ direction: \"top\" | \"left\" }",
          "properties": {
            "direction": {
              "kind": "unknown",
              "display": "\"top\" | \"left\"",
              "alternatives": [
                {
                  "kind": "string",
                  "display": "\"top\"",
                  "literal": "top"
                },
                {
                  "kind": "string",
                  "display": "\"left\"",
                  "literal": "left"
                }
              ]
            }
          }
        },
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      },
      {
        "name": "bindscrolltolower",
        "type": "event",
        "description": "滚动到底部/右边时触发",
        "detail": {
          "kind": "object",
          "display": "{ direction: \"bottom\" | \"right\" }",
          "properties": {
            "direction": {
              "kind": "unknown",
              "display": "\"bottom\" | \"right\"",
              "alternatives": [
                {
                  "kind": "string",
                  "display": "\"bottom\"",
                  "literal": "bottom"
                },
                {
                  "kind": "string",
                  "display": "\"right\"",
                  "literal": "right"
                }
              ]
            }
          }
        },
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      },
      {
        "name": "bindscroll",
        "type": "event",
        "description": "滚动时触发\n\nevent.detail = {scrollLeft, scrollTop, scrollHeight, scrollWidth, deltaX, deltaY}",
        "detail": {
          "kind": "object",
          "display": "{ scrollLeft: number; scrollTop: number; scrollHeight: number; scrollWidth: number; deltaX: number; deltaY: number }",
          "properties": {
            "scrollLeft": {
              "kind": "number",
              "display": "number"
            },
            "scrollTop": {
              "kind": "number",
              "display": "number"
            },
            "scrollHeight": {
              "kind": "number",
              "display": "number"
            },
            "scrollWidth": {
              "kind": "number",
              "display": "number"
            },
            "deltaX": {
              "kind": "number",
              "display": "number"
            },
            "deltaY": {
              "kind": "number",
              "display": "number"
            }
          }
        },
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      },
      {
        "name": "bindrefresherpulling",
        "type": "event",
        "description": "refresherpulling 事件。",
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      },
      {
        "name": "bindrefresherrefresh",
        "type": "event",
        "description": "refresherrefresh 事件。",
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      },
      {
        "name": "bindrefresherrestore",
        "type": "event",
        "description": "refresherrestore 事件。",
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      },
      {
        "name": "bindrefresherabort",
        "type": "event",
        "description": "refresherabort 事件。",
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      }
    ]
  },
  {
    "name": "swiper",
    "description": "",
    "attributes": [
      {
        "name": "bindchange",
        "type": "event",
        "description": "current 改变时会触发 change 事件\n\nevent.detail = {current, source}\n\n**Tip**: 如果在 bindchange 的事件回调函数中使用 setData 改变 current 值，则有可能导致 setData 被不停地调用，因而通常情况下请在改变 current 值前检测 source 字段来判断是否是由于用户触摸引起。",
        "detail": {
          "kind": "object",
          "display": "{ current: number; source: \"\" | \"autoplay\" | \"touch\"; currentItemId: string }",
          "properties": {
            "current": {
              "kind": "number",
              "display": "number"
            },
            "source": {
              "kind": "unknown",
              "display": "\"\" | \"autoplay\" | \"touch\"",
              "alternatives": [
                {
                  "kind": "string",
                  "display": "\"\"",
                  "literal": ""
                },
                {
                  "kind": "string",
                  "display": "\"autoplay\"",
                  "literal": "autoplay"
                },
                {
                  "kind": "string",
                  "display": "\"touch\"",
                  "literal": "touch"
                }
              ]
            },
            "currentItemId": {
              "kind": "string",
              "display": "string"
            }
          }
        },
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      },
      {
        "name": "bindtransition",
        "type": "event",
        "description": "swiper-item 的位置发生改变时会触发 transition 事件\n\nevent.detail = {dx: dx, dy: dy}",
        "since": "2.4.3",
        "detail": {
          "kind": "object",
          "display": "{ dx: number; dy: number }",
          "properties": {
            "dx": {
              "kind": "number",
              "display": "number"
            },
            "dy": {
              "kind": "number",
              "display": "number"
            }
          }
        },
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      },
      {
        "name": "bindanimationfinish",
        "type": "event",
        "description": "动画结束时会触发 animationfinish 事件",
        "since": "1.9.0",
        "detail": {
          "kind": "object",
          "display": "{ current: number; source: \"\" | \"autoplay\" | \"touch\"; currentItemId: string }",
          "properties": {
            "current": {
              "kind": "number",
              "display": "number"
            },
            "source": {
              "kind": "unknown",
              "display": "\"\" | \"autoplay\" | \"touch\"",
              "alternatives": [
                {
                  "kind": "string",
                  "display": "\"\"",
                  "literal": ""
                },
                {
                  "kind": "string",
                  "display": "\"autoplay\"",
                  "literal": "autoplay"
                },
                {
                  "kind": "string",
                  "display": "\"touch\"",
                  "literal": "touch"
                }
              ]
            },
            "currentItemId": {
              "kind": "string",
              "display": "string"
            }
          }
        },
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      }
    ]
  },
  {
    "name": "progress",
    "description": "",
    "attributes": [
      {
        "name": "bindactiveend",
        "type": "event",
        "description": "progress 动画完成事件\n\n最低基础库 2.4.1",
        "detail": {
          "kind": "object",
          "display": "{ curPercent: number }",
          "properties": {
            "curPercent": {
              "kind": "number",
              "display": "number"
            }
          }
        },
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      }
    ]
  },
  {
    "name": "button",
    "description": "",
    "attributes": [
      {
        "name": "bindgetuserinfo",
        "type": "event",
        "description": "用户点击该按钮时，会返回获取到的用户信息，回调的 detail 数据与 `wx. getUserInfo` 返回的一致，`open-type=\"getUserInfo\"` 时有效",
        "since": "1.3.0",
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      },
      {
        "name": "bindcontact",
        "type": "event",
        "description": "客服消息回调，`open-type=\"contact\"` 时有效",
        "since": "1.5.0",
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      },
      {
        "name": "bindgetphonenumber",
        "type": "event",
        "description": "获取用户手机号回调，`open-type=getPhoneNumber` 时有效",
        "since": "1.2.0",
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      },
      {
        "name": "binderror",
        "type": "event",
        "description": "当使用开放能力时，发生错误的回调，`open-type=launchApp` 时有效",
        "since": "1.9.5",
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      },
      {
        "name": "bindopensetting",
        "type": "event",
        "description": "在打开授权设置页后回调，`open-type=openSetting` 时有效",
        "since": "2.0.7",
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      },
      {
        "name": "bindlaunchapp",
        "type": "event",
        "description": "打开 APP 成功的回调，`open-type=launchApp` 时有效",
        "since": "2.4.4",
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      }
    ]
  },
  {
    "name": "checkbox-group",
    "description": "",
    "attributes": [
      {
        "name": "bindchange",
        "type": "event",
        "description": "checkbox-group 中选中项发生改变时触发 change 事件\n\ndetail = { value: ['选中的checkbox 的 value 的数组'] }",
        "detail": {
          "kind": "object",
          "display": "{ value: string[] }",
          "properties": {
            "value": {
              "kind": "array",
              "display": "string[]",
              "element": {
                "kind": "string",
                "display": "string"
              }
            }
          }
        },
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      }
    ]
  },
  {
    "name": "editor",
    "description": "",
    "attributes": [
      {
        "name": "bindready",
        "type": "event",
        "description": "编辑器初始化完成时触发",
        "since": "2.7.0",
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      },
      {
        "name": "bindfocus",
        "type": "event",
        "description": "编辑器聚焦时触发\n\nevent.detail = {html, text, delta}",
        "since": "2.7.0",
        "detail": {
          "kind": "object",
          "display": "{ html: string; text: string; delta: unknown[] }",
          "properties": {
            "html": {
              "kind": "string",
              "display": "string"
            },
            "text": {
              "kind": "string",
              "display": "string"
            },
            "delta": {
              "kind": "array",
              "display": "unknown[]",
              "element": {
                "kind": "unknown",
                "display": "unknown"
              }
            }
          }
        },
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      },
      {
        "name": "bindblur",
        "type": "event",
        "description": "编辑器失去焦点时触发\n\ndetail = {html, text, delta}",
        "since": "2.7.0",
        "detail": {
          "kind": "object",
          "display": "{ html: string; text: string; delta: unknown[] }",
          "properties": {
            "html": {
              "kind": "string",
              "display": "string"
            },
            "text": {
              "kind": "string",
              "display": "string"
            },
            "delta": {
              "kind": "array",
              "display": "unknown[]",
              "element": {
                "kind": "unknown",
                "display": "unknown"
              }
            }
          }
        },
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      },
      {
        "name": "bindinput",
        "type": "event",
        "description": "编辑器内容改变时触发\n\ndetail = {html, text, delta}",
        "since": "2.7.0",
        "detail": {
          "kind": "object",
          "display": "{ html: string; text: string; delta: unknown[] }",
          "properties": {
            "html": {
              "kind": "string",
              "display": "string"
            },
            "text": {
              "kind": "string",
              "display": "string"
            },
            "delta": {
              "kind": "array",
              "display": "unknown[]",
              "element": {
                "kind": "unknown",
                "display": "unknown"
              }
            }
          }
        },
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      },
      {
        "name": "bindstatuschange",
        "type": "event",
        "description": "通过 Context 方法改变编辑器内样式时触发，返回选区已设置的样式",
        "since": "2.7.0",
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      }
    ]
  },
  {
    "name": "form",
    "description": "",
    "attributes": [
      {
        "name": "bindsubmit",
        "type": "event",
        "description": "携带 form 中的数据触发 submit 事件\n\nevent.detail = {value : {'name': 'value'} , formId: ''}",
        "detail": {
          "kind": "object",
          "display": "{ formId?: unknown; target: unknown; value: unknown }",
          "properties": {
            "formId": {
              "kind": "unknown",
              "display": "unknown",
              "optional": true
            },
            "target": {
              "kind": "unknown",
              "display": "unknown"
            },
            "value": {
              "kind": "unknown",
              "display": "unknown"
            }
          }
        },
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      },
      {
        "name": "bindreset",
        "type": "event",
        "description": "表单重置时会触发 reset 事件",
        "detail": {
          "kind": "object",
          "display": "{ target: unknown }",
          "properties": {
            "target": {
              "kind": "unknown",
              "display": "unknown"
            }
          }
        },
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      }
    ]
  },
  {
    "name": "input",
    "description": "",
    "attributes": [
      {
        "name": "bindinput",
        "type": "event",
        "description": "键盘输入时触发\n\nevent.detail = {value, cursor, keyCode}\n\n处理函数可以直接 return 一个字符串，将替换输入框的内容。",
        "detail": {
          "kind": "object",
          "display": "{ value: string; cursor: number; keyCode?: number }",
          "properties": {
            "value": {
              "kind": "string",
              "display": "string"
            },
            "cursor": {
              "kind": "number",
              "display": "number"
            },
            "keyCode": {
              "kind": "number",
              "display": "number",
              "optional": true
            }
          }
        },
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      },
      {
        "name": "bindfocus",
        "type": "event",
        "description": "输入框聚焦时触发\n\nevent.detail = { value, height }",
        "detail": {
          "kind": "object",
          "display": "{ value: string; height: number }",
          "properties": {
            "value": {
              "kind": "string",
              "display": "string"
            },
            "height": {
              "kind": "number",
              "display": "number"
            }
          }
        },
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      },
      {
        "name": "bindblur",
        "type": "event",
        "description": "输入框失去焦点时触发\n\nevent.detail = {value: value}",
        "detail": {
          "kind": "object",
          "display": "{ value: string }",
          "properties": {
            "value": {
              "kind": "string",
              "display": "string"
            }
          }
        },
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      },
      {
        "name": "bindconfirm",
        "type": "event",
        "description": "点击完成按钮时触发\n\nevent.detail = {value: value}",
        "detail": {
          "kind": "object",
          "display": "{ value: string }",
          "properties": {
            "value": {
              "kind": "string",
              "display": "string"
            }
          }
        },
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      },
      {
        "name": "bindkeyboardheightchange",
        "type": "event",
        "description": "键盘高度发生变化的时候触发此事件\n\nevent.detail = {height: height, duration: duration}\n\n**tip**: 键盘高度发生变化，keyboardheightchange 事件可能会多次触发，开发者对于相同的 height 值应该忽略掉\n\n最低基础库: `2.7.0`",
        "detail": {
          "kind": "object",
          "display": "{ height: number; duration: number }",
          "properties": {
            "height": {
              "kind": "number",
              "display": "number"
            },
            "duration": {
              "kind": "number",
              "display": "number"
            }
          }
        },
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      }
    ]
  },
  {
    "name": "picker",
    "description": "",
    "attributes": [
      {
        "name": "bindcancel",
        "type": "event",
        "description": "取消选择时触发",
        "since": "1.9.90",
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      },
      {
        "name": "bindchange",
        "type": "event",
        "description": "value 改变时触发 change 事件\n\nevent.detail = {value}\n\n当 mode = region 时 ()\n\nvalue 改变时触发 change 事件，event.detail = {value, code, postcode}，其中字段 code 是统计用区划代码，postcode 是邮政编码",
        "since": "1.4.0",
        "detail": {
          "kind": "object",
          "display": "{ value: string | number[] | unknown; code: unknown; postcode: string }",
          "properties": {
            "value": {
              "kind": "unknown",
              "display": "string | number[] | unknown",
              "alternatives": [
                {
                  "kind": "string",
                  "display": "string"
                },
                {
                  "kind": "array",
                  "display": "number[]",
                  "element": {
                    "kind": "number",
                    "display": "number"
                  }
                },
                {
                  "kind": "unknown",
                  "display": "unknown"
                }
              ]
            },
            "code": {
              "kind": "unknown",
              "display": "unknown"
            },
            "postcode": {
              "kind": "string",
              "display": "string"
            }
          }
        },
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      },
      {
        "name": "bindcolumnchange",
        "type": "event",
        "description": "列改变时触发 当 `mode = multiSelector` 时有效",
        "detail": {
          "kind": "object",
          "display": "{ column: number; value: number }",
          "properties": {
            "column": {
              "kind": "number",
              "display": "number"
            },
            "value": {
              "kind": "number",
              "display": "number"
            }
          }
        },
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      }
    ]
  },
  {
    "name": "picker-view",
    "description": "",
    "attributes": [
      {
        "name": "bindchange",
        "type": "event",
        "description": "滚动选择时触发 change 事件\n\nevent.detail = {value}",
        "detail": {
          "kind": "object",
          "display": "{ value: number[] }",
          "properties": {
            "value": {
              "kind": "array",
              "display": "number[]",
              "element": {
                "kind": "number",
                "display": "number"
              }
            }
          }
        },
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      },
      {
        "name": "bindpickstart",
        "type": "event",
        "description": "当滚动选择开始时候触发事件",
        "since": "2.3.1",
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      },
      {
        "name": "bindpickend",
        "type": "event",
        "description": "当滚动选择结束时候触发事件",
        "since": "2.3.1",
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      }
    ]
  },
  {
    "name": "radio-group",
    "description": "",
    "attributes": [
      {
        "name": "bindchange",
        "type": "event",
        "description": "radio-group 切换事件",
        "detail": {
          "kind": "object",
          "display": "{ value: string }",
          "properties": {
            "value": {
              "kind": "string",
              "display": "string"
            }
          }
        },
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      }
    ]
  },
  {
    "name": "slider",
    "description": "",
    "attributes": [
      {
        "name": "bindchange",
        "type": "event",
        "description": "完成一次拖动后触发的事件\n\nevent.detail = {value}",
        "detail": {
          "kind": "object",
          "display": "{ value: number }",
          "properties": {
            "value": {
              "kind": "number",
              "display": "number"
            }
          }
        },
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      },
      {
        "name": "bindchanging",
        "type": "event",
        "description": "拖动过程中触发的事件\n\nevent.detail = {value}",
        "since": "1.7.0",
        "detail": {
          "kind": "object",
          "display": "{ value: number }",
          "properties": {
            "value": {
              "kind": "number",
              "display": "number"
            }
          }
        },
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      }
    ]
  },
  {
    "name": "switch",
    "description": "",
    "attributes": [
      {
        "name": "bindchange",
        "type": "event",
        "description": "checked 改变时触发 change 事件\n\nevent.detail={ value}",
        "detail": {
          "kind": "object",
          "display": "{ value: boolean }",
          "properties": {
            "value": {
              "kind": "boolean",
              "display": "boolean"
            }
          }
        },
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      }
    ]
  },
  {
    "name": "textarea",
    "description": "",
    "attributes": [
      {
        "name": "bindfocus",
        "type": "event",
        "description": "输入框聚焦时触发\n\nevent.detail = { value, height }，height 为键盘高度\n\n在基础库 1.9.90 起支持",
        "detail": {
          "kind": "object",
          "display": "{ value: string; height: number }",
          "properties": {
            "value": {
              "kind": "string",
              "display": "string"
            },
            "height": {
              "kind": "number",
              "display": "number"
            }
          }
        },
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      },
      {
        "name": "bindblur",
        "type": "event",
        "description": "输入框失去焦点时触发\n\nevent.detail = {value, cursor}\n\n**tip**: textarea 的 blur 事件会晚于页面上的 tap 事件，如果需要在 button 的点击事件获取 textarea，可以使用 form 的 bindsubmit。",
        "detail": {
          "kind": "object",
          "display": "{ value: string }",
          "properties": {
            "value": {
              "kind": "string",
              "display": "string"
            }
          }
        },
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      },
      {
        "name": "bindlinechange",
        "type": "event",
        "description": "输入框行数变化时调用\n\nevent.detail = {height: 0, heightRpx: 0, lineCount: 0}",
        "detail": {
          "kind": "object",
          "display": "{ height: number; heightRpx: number; lineCount: number; lineHeight: number }",
          "properties": {
            "height": {
              "kind": "number",
              "display": "number"
            },
            "heightRpx": {
              "kind": "number",
              "display": "number"
            },
            "lineCount": {
              "kind": "number",
              "display": "number"
            },
            "lineHeight": {
              "kind": "number",
              "display": "number"
            }
          }
        },
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      },
      {
        "name": "bindinput",
        "type": "event",
        "description": "当键盘输入时，触发 input 事件\n\nevent.detail = {value, cursor, keyCode}\n\nkeyCode 为键值，目前工具还不支持返回 keyCode 参数。\n\n**tip**: 不建议在多行文本上对用户的输入进行修改，所以 **bindinput 处理函数的返回值并不会反映到 textarea 上**",
        "detail": {
          "kind": "object",
          "display": "{ value: string; cursor: number; keyCode?: number }",
          "properties": {
            "value": {
              "kind": "string",
              "display": "string"
            },
            "cursor": {
              "kind": "number",
              "display": "number"
            },
            "keyCode": {
              "kind": "number",
              "display": "number",
              "optional": true
            }
          }
        },
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      },
      {
        "name": "bindconfirm",
        "type": "event",
        "description": "点击完成时， 触发 confirm 事件\n\nevent.detail = {value: value}",
        "detail": {
          "kind": "object",
          "display": "{ value: string }",
          "properties": {
            "value": {
              "kind": "string",
              "display": "string"
            }
          }
        },
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      },
      {
        "name": "bindkeyboardheightchange",
        "type": "event",
        "description": "键盘高度发生变化的时候触发此事件\n\nevent.detail = {height: height, duration: duration}\n\n**tip**: 键盘高度发生变化，keyboardheightchange事件可能会多次触发，开发者对于相同的height值应该忽略掉",
        "since": "2.7.0",
        "detail": {
          "kind": "object",
          "display": "{ height: number; duration: number }",
          "properties": {
            "height": {
              "kind": "number",
              "display": "number"
            },
            "duration": {
              "kind": "number",
              "display": "number"
            }
          }
        },
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      }
    ]
  },
  {
    "name": "functional-page-navigator",
    "description": "",
    "attributes": [
      {
        "name": "bindsuccess",
        "type": "event",
        "description": "功能页返回，且操作成功时触发， detail 格式与具体功能页相关",
        "since": "2.1.0",
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      },
      {
        "name": "bindfail",
        "type": "event",
        "description": "功能页返回，且操作失败时触发， detail 格式与具体功能页相关",
        "since": "2.1.0",
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      }
    ]
  },
  {
    "name": "navigator",
    "description": "",
    "attributes": [
      {
        "name": "bindsuccess",
        "type": "event",
        "description": "当 `target=\"miniProgram\"` 时有效，跳转小程序成功",
        "since": "2.0.7",
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      },
      {
        "name": "bindfail",
        "type": "event",
        "description": "当 `target=\"miniProgram\"` 时有效，跳转小程序失败\n\n`tips`: 需要用户确认跳转 从 2.3.0 版本开始，在跳转至其他小程序前，将统一增加弹窗，询问是否跳转，用户确认后才可以跳转其他小程序。如果用户点击取消，则回调 fail cancel。",
        "since": "2.0.7",
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      },
      {
        "name": "bindcomplete",
        "type": "event",
        "description": "当 `target=\"miniProgram\"` 时有效，跳转小程序完成",
        "since": "2.0.7",
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      }
    ]
  },
  {
    "name": "audio",
    "description": "",
    "attributes": [
      {
        "name": "binderror",
        "type": "event",
        "description": "当发生错误时触发 error 事件\n\ndetail = {errMsg:MediaError.code}",
        "detail": {
          "kind": "object",
          "display": "{ errMsg: 1 | 2 | 3 | 4 }",
          "properties": {
            "errMsg": {
              "kind": "unknown",
              "display": "1 | 2 | 3 | 4",
              "alternatives": [
                {
                  "kind": "number",
                  "display": "1",
                  "literal": 1
                },
                {
                  "kind": "number",
                  "display": "2",
                  "literal": 2
                },
                {
                  "kind": "number",
                  "display": "3",
                  "literal": 3
                },
                {
                  "kind": "number",
                  "display": "4",
                  "literal": 4
                }
              ]
            }
          }
        },
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      },
      {
        "name": "bindplay",
        "type": "event",
        "description": "当开始/继续播放时触发play事件",
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      },
      {
        "name": "bindpause",
        "type": "event",
        "description": "当暂停播放时触发 pause 事件",
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      },
      {
        "name": "bindtimeupdate",
        "type": "event",
        "description": "当播放进度改变时触发 timeupdate 事件\n\ndetail = {currentTime, duration}",
        "detail": {
          "kind": "object",
          "display": "{ currentTime: number; duration: number }",
          "properties": {
            "currentTime": {
              "kind": "number",
              "display": "number"
            },
            "duration": {
              "kind": "number",
              "display": "number"
            }
          }
        },
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      },
      {
        "name": "bindended",
        "type": "event",
        "description": "当播放到末尾时触发 ended 事件",
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      }
    ]
  },
  {
    "name": "camera",
    "description": "",
    "attributes": [
      {
        "name": "bindstop",
        "type": "event",
        "description": "摄像头在非正常终止时触发，如退出后台等情况",
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      },
      {
        "name": "binderror",
        "type": "event",
        "description": "用户不允许使用摄像头时触发",
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      },
      {
        "name": "bindinitdone",
        "type": "event",
        "description": "相机初始化完成时触发",
        "since": "2.7.0",
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      },
      {
        "name": "bindscancode",
        "type": "event",
        "description": "在扫码识别成功时触发，仅在 mode=\"scanCode\" 时生效",
        "since": "2.1.0",
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      }
    ]
  },
  {
    "name": "image",
    "description": "",
    "attributes": [
      {
        "name": "binderror",
        "type": "event",
        "description": "当错误发生时触发，event.detail = {errMsg}",
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      },
      {
        "name": "bindload",
        "type": "event",
        "description": "当图片载入完毕时触发，event.detail = {height, width}",
        "detail": {
          "kind": "object",
          "display": "{ width: number; height: number }",
          "properties": {
            "width": {
              "kind": "number",
              "display": "number"
            },
            "height": {
              "kind": "number",
              "display": "number"
            }
          }
        },
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      }
    ]
  },
  {
    "name": "live-player",
    "description": "",
    "attributes": [
      {
        "name": "bindstatechange",
        "type": "event",
        "description": "播放状态变化事件，detail = {code}\n\n最低基础库 1.7.0",
        "detail": {
          "kind": "object",
          "display": "{ code: number }",
          "properties": {
            "code": {
              "kind": "number",
              "display": "number"
            }
          }
        },
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      },
      {
        "name": "bindfullscreenchange",
        "type": "event",
        "description": "全屏变化事件，detail = {direction, fullScreen}\n\n最低基础库 1.7.0",
        "detail": {
          "kind": "object",
          "display": "{ direction: \"vertical\" | \"horizontal\"; fullScreen: boolean }",
          "properties": {
            "direction": {
              "kind": "unknown",
              "display": "\"vertical\" | \"horizontal\"",
              "alternatives": [
                {
                  "kind": "string",
                  "display": "\"vertical\"",
                  "literal": "vertical"
                },
                {
                  "kind": "string",
                  "display": "\"horizontal\"",
                  "literal": "horizontal"
                }
              ]
            },
            "fullScreen": {
              "kind": "boolean",
              "display": "boolean"
            }
          }
        },
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      },
      {
        "name": "bindnetstatus",
        "type": "event",
        "description": "网络状态通知，detail = {info}\n\n最低基础库 1.9.0",
        "detail": {
          "kind": "object",
          "display": "{ info: \"videoBitrate\" | \"audioBitrate\" | \"videoFPS\" | \"videoGOP\" | \"netSpeed\" | \"netJitter\" | \"videoWidth\" | \"videoHeight\" }",
          "properties": {
            "info": {
              "kind": "unknown",
              "display": "\"videoBitrate\" | \"audioBitrate\" | \"videoFPS\" | \"videoGOP\" | \"netSpeed\" | \"netJitter\" | \"videoWidth\" | \"videoHeight\"",
              "alternatives": [
                {
                  "kind": "string",
                  "display": "\"videoBitrate\"",
                  "literal": "videoBitrate"
                },
                {
                  "kind": "string",
                  "display": "\"audioBitrate\"",
                  "literal": "audioBitrate"
                },
                {
                  "kind": "string",
                  "display": "\"videoFPS\"",
                  "literal": "videoFPS"
                },
                {
                  "kind": "string",
                  "display": "\"videoGOP\"",
                  "literal": "videoGOP"
                },
                {
                  "kind": "string",
                  "display": "\"netSpeed\"",
                  "literal": "netSpeed"
                },
                {
                  "kind": "string",
                  "display": "\"netJitter\"",
                  "literal": "netJitter"
                },
                {
                  "kind": "string",
                  "display": "\"videoWidth\"",
                  "literal": "videoWidth"
                },
                {
                  "kind": "string",
                  "display": "\"videoHeight\"",
                  "literal": "videoHeight"
                }
              ]
            }
          }
        },
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      }
    ]
  },
  {
    "name": "live-pusher",
    "description": "",
    "attributes": [
      {
        "name": "bindstatechange",
        "type": "event",
        "description": "状态变化事件，detail = {code}",
        "since": "1.7.0",
        "detail": {
          "kind": "object",
          "display": "{ code: number }",
          "properties": {
            "code": {
              "kind": "number",
              "display": "number"
            }
          }
        },
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      },
      {
        "name": "bindnetstatus",
        "type": "event",
        "description": "网络状态通知，detail = {info}",
        "since": "1.9.0",
        "detail": {
          "kind": "object",
          "display": "{ info: \"videoBitrate\" | \"audioBitrate\" | \"videoFPS\" | \"videoGOP\" | \"netSpeed\" | \"netJitter\" | \"videoWidth\" | \"videoHeight\" }",
          "properties": {
            "info": {
              "kind": "unknown",
              "display": "\"videoBitrate\" | \"audioBitrate\" | \"videoFPS\" | \"videoGOP\" | \"netSpeed\" | \"netJitter\" | \"videoWidth\" | \"videoHeight\"",
              "alternatives": [
                {
                  "kind": "string",
                  "display": "\"videoBitrate\"",
                  "literal": "videoBitrate"
                },
                {
                  "kind": "string",
                  "display": "\"audioBitrate\"",
                  "literal": "audioBitrate"
                },
                {
                  "kind": "string",
                  "display": "\"videoFPS\"",
                  "literal": "videoFPS"
                },
                {
                  "kind": "string",
                  "display": "\"videoGOP\"",
                  "literal": "videoGOP"
                },
                {
                  "kind": "string",
                  "display": "\"netSpeed\"",
                  "literal": "netSpeed"
                },
                {
                  "kind": "string",
                  "display": "\"netJitter\"",
                  "literal": "netJitter"
                },
                {
                  "kind": "string",
                  "display": "\"videoWidth\"",
                  "literal": "videoWidth"
                },
                {
                  "kind": "string",
                  "display": "\"videoHeight\"",
                  "literal": "videoHeight"
                }
              ]
            }
          }
        },
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      },
      {
        "name": "binderror",
        "type": "event",
        "description": "渲染错误事件，detail = {errMsg, errCode}\n\n`tip`: 开发者工具上暂不支持 live-pusher",
        "since": "1.7.4",
        "detail": {
          "kind": "object",
          "display": "{ errMsg: string; errCode: number }",
          "properties": {
            "errMsg": {
              "kind": "string",
              "display": "string"
            },
            "errCode": {
              "kind": "number",
              "display": "number"
            }
          }
        },
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      },
      {
        "name": "bindbgmstart",
        "type": "event",
        "description": "背景音开始播放时触发",
        "since": "2.4.0",
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      },
      {
        "name": "bindbgmprogress",
        "type": "event",
        "description": "背景音进度变化时触发，detail = {progress, duration}",
        "since": "2.4.0",
        "detail": {
          "kind": "object",
          "display": "{ progress: number; duration: number }",
          "properties": {
            "progress": {
              "kind": "number",
              "display": "number"
            },
            "duration": {
              "kind": "number",
              "display": "number"
            }
          }
        },
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      },
      {
        "name": "bindbgmcomplete",
        "type": "event",
        "description": "背景音播放完成时触发",
        "since": "2.4.0",
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      }
    ]
  },
  {
    "name": "video",
    "description": "",
    "attributes": [
      {
        "name": "bindplay",
        "type": "event",
        "description": "当开始/继续播放时触发play事件",
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      },
      {
        "name": "bindpause",
        "type": "event",
        "description": "当暂停播放时触发 pause 事件",
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      },
      {
        "name": "bindended",
        "type": "event",
        "description": "当播放到末尾时触发 ended 事件",
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      },
      {
        "name": "bindtimeupdate",
        "type": "event",
        "description": "播放进度变化时触发，event.detail = {currentTime, duration} 。触发频率 250ms 一次",
        "detail": {
          "kind": "object",
          "display": "{ currentTime: number; duration: number }",
          "properties": {
            "currentTime": {
              "kind": "number",
              "display": "number"
            },
            "duration": {
              "kind": "number",
              "display": "number"
            }
          }
        },
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      },
      {
        "name": "bindfullscreenchange",
        "type": "event",
        "description": "视频进入和退出全屏时触发，event.detail = {fullScreen, direction}",
        "since": "1.4.0",
        "detail": {
          "kind": "object",
          "display": "{ fullScreen: boolean; direction: \"vertical\" | \"horizontal\" }",
          "properties": {
            "fullScreen": {
              "kind": "boolean",
              "display": "boolean"
            },
            "direction": {
              "kind": "unknown",
              "display": "\"vertical\" | \"horizontal\"",
              "alternatives": [
                {
                  "kind": "string",
                  "display": "\"vertical\"",
                  "literal": "vertical"
                },
                {
                  "kind": "string",
                  "display": "\"horizontal\"",
                  "literal": "horizontal"
                }
              ]
            }
          }
        },
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      },
      {
        "name": "bindwaiting",
        "type": "event",
        "description": "视频出现缓冲时触发",
        "since": "1.7.0",
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      },
      {
        "name": "binderror",
        "type": "event",
        "description": "视频播放出错时触发",
        "since": "1.7.0",
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      },
      {
        "name": "bindpregress",
        "type": "event",
        "description": "加载进度变化时触发，只支持一段加载。",
        "since": "2.4.0",
        "detail": {
          "kind": "object",
          "display": "{ buffered: number }",
          "properties": {
            "buffered": {
              "kind": "number",
              "display": "number"
            }
          }
        },
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      }
    ]
  },
  {
    "name": "voip-room",
    "description": "",
    "attributes": [
      {
        "name": "binderror",
        "type": "event",
        "description": "加载进度变化时触发，只支持一段加载。",
        "since": "2.4.0",
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      }
    ]
  },
  {
    "name": "map",
    "description": "",
    "attributes": [
      {
        "name": "bindtap",
        "type": "event",
        "description": "点击地图时触发\n\n2.9.0 起返回经纬度信息",
        "detail": {
          "kind": "object",
          "display": "{ longitude: number; latitude: number }",
          "properties": {
            "longitude": {
              "kind": "number",
              "display": "number"
            },
            "latitude": {
              "kind": "number",
              "display": "number"
            }
          }
        },
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      },
      {
        "name": "bindupdated",
        "type": "event",
        "description": "在地图渲染更新完成时触发",
        "since": "1.6.0",
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      }
    ]
  },
  {
    "name": "label",
    "description": "",
    "attributes": [
      {
        "name": "bindtap",
        "type": "event",
        "description": "点击 label 时触发\n\ne.detail = {markerId}",
        "since": "2.9.0",
        "detail": {
          "kind": "object",
          "display": "{ markerId: number }",
          "properties": {
            "markerId": {
              "kind": "number",
              "display": "number"
            }
          }
        },
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      }
    ]
  },
  {
    "name": "ad",
    "description": "",
    "attributes": [
      {
        "name": "bindload",
        "type": "event",
        "description": "广告加载成功的回调",
        "since": "2.2.1",
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      },
      {
        "name": "binderror",
        "type": "event",
        "description": "广告加载失败的回调，event.detail = {errCode: 1002}\n\n`tip`: 监听到error回调后，开发者可以针对性的处理，比如隐藏广告组件的父容器，以保证用户体验，但不要移除广告组件，否则将无法收到bindload的回调。",
        "since": "2.2.1",
        "detail": {
          "kind": "object",
          "display": "{ errCode: number }",
          "properties": {
            "errCode": {
              "kind": "number",
              "display": "number"
            }
          }
        },
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      },
      {
        "name": "bindclose",
        "type": "event",
        "description": "广告关闭的回调",
        "since": "2.6.5",
        "references": [
          {
            "name": "微信官方事件类型",
            "url": "https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.event.d.ts"
          }
        ]
      }
    ]
  }
];
