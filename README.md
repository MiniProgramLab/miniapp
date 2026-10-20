<p align="center">
  <img src="https://raw.githubusercontent.com/MiniProgramLab/miniapp/main/media/icon.png" alt="miniapp 图标" width="128" height="128">
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=miniprogramlab.miniapp"><img src="https://vsmarketplacebadges.dev/downloads/miniprogramlab.miniapp.svg?label=VS%20Code%20Downloads" alt="VS Code Marketplace 下载量"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=miniprogramlab.miniapp"><img src="https://vsmarketplacebadges.dev/version/miniprogramlab.miniapp.svg?label=VS%20Code%20Version" alt="VS Code Marketplace 最新版本"></a>
  <a href="https://open-vsx.org/extension/miniprogramlab/miniapp"><img src="https://img.shields.io/open-vsx/dt/miniprogramlab/miniapp?label=Open%20VSX%20Downloads" alt="Open VSX 下载量"></a>
  <a href="https://open-vsx.org/extension/miniprogramlab/miniapp"><img src="https://img.shields.io/open-vsx/v/miniprogramlab/miniapp?label=Open%20VSX%20Version" alt="Open VSX 最新版本"></a>
</p>

miniapp 为微信小程序提供轻量的编辑与源码导航支持，适用于 VS Code / Cursor 中的 TypeScript 和 JavaScript 工程。

## 功能介绍

- **WXML 编辑**：语法高亮、标签与属性补全、自动闭合、成对标签同步改名及常用代码片段；表达式补全支持对象成员、循环项、模板传参和 Behavior 方法。
- **模板结构**：大纲显示标签层级、静态 id/class、具名模板和 WXS 模块；支持语义折叠及按单词、插值、属性、节点逐层扩大选区，多光标共享结构索引。
- **结构检查**：定位标签错配、缺失或多余结束标签、重复属性、孤立或冲突条件分支及不规范 `wx:key`；灯泡支持补齐标签、删除重复属性和纠正确定的列表键写法，保留正文、缩进与换行，未完成输入不产生尾部级联提示。
- **模板提取**：选择完整兄弟节点，通过灯泡提取为当前文件的具名模板；自动传递外部数据，保留局部循环、条件链和事件及样式归属，支持原生改动预览、勾选应用及整体撤销。
- **组件提取**：从完整节点选区生成组件文件、注册、数据传参与原始事件转发；展开静态 include，迁移实际调用的具名模板、嵌套组件及 WXS，保持数据和模块作用域。修改通过原生预览审核，依赖变化时取消旧预览；不能确认作用域时显示原因。
- **组件提示**：查看自定义组件的参数类型、默认值、注释和插槽，支持补全与定义跳转。
- **组件元数据**：扩充原生属性及官方事件 detail，支持组件库 Custom Data 的标签、属性、枚举和文档补充，展示实际来源包版本；检查明确的基础库要求与弃用声明，源码提示保持优先。
- **脚本追踪**：通过 F12 定位变量、事件方法和对象成员，沿导入别名、重导出及 Behavior 追踪源码；悬浮显示原声明注释。
- **导航说明**：主动查看当前导航的配置、路径与声明引用链，区分动态来源、缺失路径、多个候选及扫描超限；报告支持取消并排除过期草稿。
- **模板导航**：沿独立模板的 data 传参逐层追踪变量，支持模板引用、包含文件和组件注册路径跳转。
- **WXS 语义**：外部及内联 WXS 支持成员补全、函数跳转、注释悬浮和调用参数提示，沿 `require` 与导出链追踪源码；检查已知参数数量、类型、语法及平台 API 限制，内联位置映射到所属 WXML。
- **自定义事件**：提取组件及 Behavior 的静态事件，补全绑定属性、定位发出位置并展示 `detail` 类型；显式处理参数不兼容时显示诊断。
- **跨文件重命名**：通过 F2 联动脚本、模板、Behavior 和组件实例的静态访问，支持模板传参、循环别名、WXS 模块及静态 `setData`、`observers` 字段；使用编辑器原生预览和撤销，冲突或预算不足时停止生成编辑。
- **引用与修复**：查找脚本和模板的全部引用，检查名称、方法可调用性、组件注册、参数及静态模板和 WXS 资源路径；原生灯泡支持修正拼写、创建方法、补充参数和选择组件源码进行注册。
- **工作区检查**：复用已注册诊断规则检查未打开的源码，支持目录与 glob 范围、严重程度和文件筛选、取消及 JSON / Markdown 导出；问题面板显示稳定快照，源码变化后提示重新检查。
- **通用框架适配**：静态追踪原生注册包装器；声明宏可按导入符号、参数位置和字段路径配置适配，补全、导航、诊断和改名使用同一规则。
- **dataset 语义**：沿事件绑定定位节点数据，支持字段及嵌套成员补全、类型悬浮、双向跳转和引用；静态 `currentTarget` 字段可联动改名，解构局部变量保持原名。
- **组件实例**：将静态 `selectComponent` / `selectAllComponents` 选择器关联到模板节点，补全公开方法与数据成员，显示参数和返回值并导航实现；支持实例别名、集合元素、Behavior、模板包含和自定义导出。
- **页面路由**：在脚本 URL、`navigator` 和应用注册路径上补全与导航页面源码，追踪静态常量及包装器，检查分包和 TabBar 规则；查询字段支持 `onLoad` 类型及声明式 schema，保留注释、默认值和声明跳转。相对路由沿实际组件使用关系定位，多个来源保留全部候选。
- **数据路径**：补全 `setData` 和 `observers` 中的嵌套对象、数组元素及观察通配符，显示类型与注释并跳转声明；只检查已有声明的确定赋值类型，新增字段保持开放。
- **样式支持**：支持 CSS、WXSS、SCSS、Less 的导入链、变量、混入和函数导航；WXML 静态类名及三元分支字符串支持补全和跳转。
- **样式导入**：识别 TypeScript 中已存在的样式副作用导入，支持相对路径与路径别名，保留错误路径的诊断。
- **智能路径**：自动识别源码根、项目别名和常见构建复制规则，让跳转落到原始源码；支持未保存内容和多工作区。
- **关联操作**：快捷切换模板、脚本、实际导入的样式与配置；文件移动时联动静态注册、模板、WXS、样式和已确认的页面路由，跨分包迁移页面注册数组，保留常量来源、查询参数、注释及 Sass 命名空间；常规脚本导入沿用编辑器能力。
- **连续查询**：有界复用脚本语义图、增量反向导入索引及共享配置，未变源码不重复读取，按实际文件和目录依赖失效；诊断只刷新受影响的打开文档，支持草稿、磁盘与配置变化。

## 相关设置

在设置中搜索 `miniapp`。以下配置统一以 `miniprogramlab.miniapp.` 为前缀，路径相对当前工作区。

| 配置 | 默认值 | 用途 |
| --- | --- | --- |
| `wxml.autoClosingTags` | `true` | 自动闭合标签 |
| `wxml.customData` | `[]` | 工作区相对的组件库 Custom Data JSON 文件 |
| `wxml.sdkVersion` | `""` | 目标基础库，留空读取最近项目配置；未知版本不诊断 |
| `checks.include` | 小程序源码后缀 | 工作区检查的原生 glob 包含规则 |
| `checks.exclude` | 依赖及构建目录 | 检查排除规则，依赖解析仍可读取 |
| `checks.maxFiles` | `10000` | 文件扫描上限，超限标记未完成 |
| `checks.maxFindings` | `50000` | 问题数量上限，超限标记未完成 |
| `wxml.sourceRoot` | `""` | 组件源码根，留空自动识别 |
| `wxml.includePaths` | `[]` | 组件额外搜索目录 |
| `wxml.maxTemplateFiles` | `500` | 模板调用图文件上限 |
| `wxml.maxScriptFiles` | `400` | 脚本引用链文件上限 |
| `wxml.maxRenameFiles` | `5000` | 跨文件重命名扫描上限，超出时停止生成编辑 |
| `wxml.adapters` | `[]` | 声明宏的导入符号、参数位置及字段映射规则 |
| `css.sourceRoot` | `""` | 样式源码根，留空自动识别 |
| `css.includePaths` | `[]` | 样式额外搜索目录 |
| `css.maxFiles` | `300` | 样式引用链文件上限 |

命令面板中的 **miniapp: 查看已注册的语言插件** 可查看当前语言能力，**miniapp: 说明当前导航结果** 可追踪光标位置的导航结果。

通过 **miniapp: 检查工作区** 或资源管理器目录菜单开始检查；结果可筛选和导出，检查状态与覆盖文件数会保留在报告中。

组件元数据兼容 Custom Data 1/1.1，支持 `type`、`defaultValue`、`required`、`since`（最低基础库）、`deprecated` 及 `events[].detail` 的 JSON Schema 扩展；声明数据不执行脚本。

## 自动更新的架构图

架构图根据源码与扩展清单自动生成，随开发构建更新。

![miniapp 插件架构](media/architecture.svg)

[查看交互版架构图](docs/architecture.html)，支持主题切换与图片导出。
