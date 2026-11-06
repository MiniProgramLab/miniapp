# 版本变更记录

发版时根据当前 tag 与之前正式版本之间的提交记录，按当前发布版本号分类记录变更，并保留历史版本说明。

## [0.0.5](https://github.com/MiniProgramLab/miniapp/compare/v0.0.4...v0.0.5) - 2026-11-06

### 性能优化

- 优化补全悬浮跳转与后台解析性能（[00aa371](https://github.com/MiniProgramLab/miniapp/commit/00aa37119701ad66c9efd442f303faa5138026f9)）
- 优化语义查询冷启动与线程计算性能（[e8ba98c](https://github.com/MiniProgramLab/miniapp/commit/e8ba98ce9cd370126f399ce71f291f725fc2e144)）
- 优化复杂类型查询并发布 0.0.5 版本（[a2be45f](https://github.com/MiniProgramLab/miniapp/commit/a2be45f52f4107fe18611245fcf4203b3901dcf0)）

## [0.0.4](https://github.com/MiniProgramLab/miniapp/compare/v0.0.3...v0.0.4) - 2026-11-05

### 问题修复

- 修复各语言注释格式并发布 0.0.4 版本（[bd4dc96](https://github.com/MiniProgramLab/miniapp/commit/bd4dc96d7ea72c2ee64a22004e49561c10dec08a)）

## [0.0.3](https://github.com/MiniProgramLab/miniapp/compare/v0.0.2...v0.0.3) - 2026-11-02

### 新增功能

- 支持模板定义跳转并完善类型断言提示（[deb276f](https://github.com/MiniProgramLab/miniapp/commit/deb276ff84d73ec03959f0656488c24b62c7520d)）
- 按发版标签自动记录版本变更日志（[35a2ae5](https://github.com/MiniProgramLab/miniapp/commit/35a2ae5c28eaf402f0c147ac28904b5008d7b5af)）

### 问题修复

- 仅在推送版本标签时触发双市场发布（[592553d](https://github.com/MiniProgramLab/miniapp/commit/592553d63adffce9da0c0e550cecc7b96b2c63fd)）
- 修复构建自动注册页面的路由误报（[a55b348](https://github.com/MiniProgramLab/miniapp/commit/a55b3484c2a0875be863c4905072f1a250ee02cf)）

### 性能优化

- 优化变量和组件跳转性能（[7186803](https://github.com/MiniProgramLab/miniapp/commit/71868032bd3c8e8018479b439dd4cf19c924854c)）
- 优化跨文件变量和 Behavior 首次跳转（[7c58d20](https://github.com/MiniProgramLab/miniapp/commit/7c58d2003608edef63657b3461b54a78a1b6b15f)）

### 工程维护

- 发布 0.0.3 版本（[756a09a](https://github.com/MiniProgramLab/miniapp/commit/756a09a65aec883c6e47bb8b15489ecd85ba490d)）

## [0.0.2](https://github.com/MiniProgramLab/miniapp/tree/v0.0.2) - 2026-10-20

### 新增功能

- 初始化 miniapp 小程序插件及双市场发布流水线（[3b4dad2](https://github.com/MiniProgramLab/miniapp/commit/3b4dad26715393137b073a9df272a68a14c8e572)）
