# 插件发布

两个市场统一使用 `miniprogramlab.miniapp`，由 `package.json` 中的 `publisher` 和 `name` 确定。

## 短期凭据

流水线不保存市场 PAT 或客户端密码。发布任务通过 GitHub OIDC 证明身份，按需获取短期令牌，两个市场仍然使用同一个已验证的 VSIX。

在 GitHub 创建 `publish` 环境，将允许部署的来源限制为 `v*` tag。仅发布任务授予 `id-token: write`；打包任务不申请发布身份。

## Visual Studio Marketplace 配置

1. 在可管理的 Microsoft Entra 租户中注册专用应用，为其配置 GitHub Actions 联合凭据：

   | 字段 | 值 |
   | --- | --- |
   | Issuer | `https://token.actions.githubusercontent.com` |
   | Subject | `repo:MiniProgramLab@156577202/miniapp@1387995724:environment:publish` |
   | Audience | `api://AzureADTokenExchange` |

   本仓库使用 GitHub 的不可变 Subject 格式，包含组织与仓库的永久 ID。重新配置时以 Actions 中 Azure 登录步骤显示的 `subject claim` 为准，不能套用仅含名称的旧格式。

2. 在 `publish` 环境或仓库的 Actions **Variables** 中配置 `AZURE_CLIENT_ID`（应用 Client ID）和 `AZURE_TENANT_ID`（租户 ID）。这些是标识符，不是密码；无需创建 Client Secret。
3. 在已通过 OIDC 登录的 Actions 任务中执行以下命令，取得该服务身份的 Marketplace User ID；不能使用个人账户的 Profile ID 或 Entra Object ID 代替：

   ```sh
   az rest \
     --url 'https://app.vssps.visualstudio.com/_apis/profile/profiles/me?api-version=7.1' \
     --resource 499b84ac-1321-427f-aa17-267ca6975798 \
     --query '{id:id,displayName:displayName}' \
     --output json
   ```

   将返回的 `id` 加入 `miniprogramlab` 发布者，授予 **Creator**。本插件由该身份首次发布并持续更新，因此无需管理其他成员发布的扩展；只有需要管理其他成员已发布扩展时才考虑 Contributor。不要授予订阅 Owner 等无关权限，也无需为了获取 Profile ID 创建 Azure DevOps 组织或临时密码。
4. 流水线通过 `Azure/login` 执行联合身份登录，再用 `vsce publish --azure-credential` 发布。配置使用 `allow-no-subscriptions`，发布本身不依赖 Azure 资源部署。

个人 Microsoft 账户能管理 Marketplace，并不代表已经有可注册应用的 Entra 租户；缺少租户或管理权限时需要先完成账户配置。

参考：[微软扩展发布文档](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#secure-automated-publishing-to-visual-studio-marketplace)、[Azure GitHub 登录](https://github.com/Azure/login)、[配置联合身份](https://learn.microsoft.com/entra/workload-id/workload-identity-federation-create-trust)、[GitHub 不可变身份声明](https://docs.github.com/en/actions/reference/security/oidc#immutable-subject-claims)。

## Open VSX 配置

需要已签署发布者协议，并拥有 `miniprogramlab` 命名空间的 **Owner** 权限。

Open VSX 的 Trusted Publisher 要求扩展至少已有一个有效版本。首次可在 [网页发布入口](https://open-vsx.org/publish) 上传 Actions 生成的 VSIX，完成初始化；随后在 [Trusted Publishers](https://open-vsx.org/user-settings/trusted-publishers) 注册：

| 字段 | 值 |
| --- | --- |
| Namespace / Extension | `miniprogramlab` / `miniapp` |
| Organization or User name | `MiniProgramLab` |
| Repository name | `miniapp` |
| Workflow filename | `release.yml` |
| Environment name | `publish` |

后续 `ovsx publish --trusted-publishing` 会自动交换仅限该扩展、短时间有效的发布令牌，不需要 `OVSX_PAT`。

参考：[Open VSX Trusted Publishing](https://github.com/eclipse-openvsx/openvsx/wiki/Trusted-Publishing)。

## 发布新版本

1. 更新 `package.json` 的 `version`，使用正式版本号，例如 `0.0.3`。PNG 图标不得超过 `1024×1024` 像素，打包时会检查该限制。
2. 执行 `pnpm dev:release:check`、`pnpm dev:package` 和 `pnpm dev:test`，提交代码并推送 `main`。首次检出必须先构建再测试。
3. 为该提交创建与版本完全一致的 tag 并推送：

   ```sh
   git tag v0.0.3
   git push origin v0.0.3
   ```

当前双市场初始化版本为 `0.0.2`，发布对应 `v0.0.2`。Open VSX 中保留较早初始化的 `0.0.1`；该版本因图标尺寸超限未发布到微软市场。GitHub Actions 会检查 tag 与清单版本、回归验证、构建并打包，再将同一 VSIX 分别上传到两个市场。版本或身份不匹配时停止发布。

工作流只在推送 `v*` tag 时触发，普通提交、PR 和手动操作不会另起构建。每次版本发布只产生一条运行记录，其中包含打包和两个市场发布任务。产物可在 Actions 对应运行的 Artifacts 中下载，保留 30 天。

## 发布失败后重试

两个市场独立发布。修复联合身份、可信发布登记或市场权限后，在原 Actions 运行中选择 **Re-run failed jobs**；已存在的版本会跳过，防止因一个市场成功而无法补发另一个市场。不要移动已经发布的 tag，也不要用相同版本发布不同内容。
