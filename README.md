# pipe-ls

**为约定式 Bash + jq 脚本及主流 CI 提供结构化开发体验的语言服务器。**

目标不是检查任意 Bash，而是减少约定脚本开发中的猜测与手工核对。首版先交付 Bash + GitHub Actions 的 CLI 静态检查，以 `tests/cases/1` 为覆盖目标；暂不实现 LSP 适配。字段补全、类型提示、跳转、引用、重命名和即时诊断属于后续编辑器能力，复用同一分析核心。

当前已有 UTF-16 Span、Bash/jq/YAML 解析与源码映射、JSON 契约、保守的脚本与 GitHub Actions 静态分析、`.github` 根发现和只读 CLI。case 1 的 23 个矩阵场景现有可执行诊断或受控运行时测试；合成 overlays 与带 JSON 解码的本地 reusable workflow stub 下，`cloud.yaml` 可静态检查通过。**首版仍未完成验收**：原 fixture 缺少 `resources/**` overlays；真实 `do-rollout-restart.yaml` 已收录，但其工具/动作/runner 等上下文尚不能完整静态验证，且华为路径依赖的 `.github/tool-versions.env` 尚未收录。git/gh 目前只摘要固定命令族及少量参数关系，未证明动态路径、远端参数或实际副作用。CLI 已以 `@pipe-ls/cli@0.1.0` 在 npm 公开发布，空缓存离线安装和无凭据注册表安装均通过；项目采用 [MIT 许可证](LICENSE)。更广泛的性能验收仍待完成。LSP 不属于首版范围。

## 公开安装

```sh
pnpm add -g @pipe-ls/cli@0.1.0
pipe-ls --version
pipe-ls check --json .
```

在含 `.github/` 的项目目录运行检查。CLI 只读检查本地项目；`complete: false` 表示检查受阻或发现诊断，不应当作通过。

## 本地开发

使用 Node.js 22.13+（推荐 `.node-version` 锁定版本）与 pnpm 11.20.0。`test:integration` 另外需要本机 Bash、jq 1.8.2（或兼容版本）和 mikefarah/yq v4；测试不会下载工具。

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
pnpm test:package
pnpm pack:offline
```

构建后可运行 `node packages/cli/dist/bin.js check [--json] [paths...]`，或用 `--version` 查看 CLI 版本。它支持有限的 Bash 赋值、export、管道、命令替换、条件分支、read/for/JSON-lines while、本地多层脚本契约调用及静态 jq/printf 检查，并验证有限本地路径、部分 yq may-write 效果与缺失依赖；GitHub run 的 env 注入、已验证的 `GITHUB_ENV/GITHUB_OUTPUT` 写入、显式 job output 映射、有限 `needs`/`if`/本地 reusable workflow 输入及源码位置已有检查。范围外语法和无法证明的条件仍阻断，不会因解析成功而宣称通过。`externalEffects` 只列可能运行的命令族，不是动态参数或远程效果的证明。该命令只读项目文件，不执行脚本或业务命令。

`pnpm test:watch` 启动测试监听，`pnpm format` 格式化代码与配置。构建产物位于各包的 `dist/`，不纳入版本控制；删除产物后可直接重新构建，类型检查和单元测试不依赖预先构建。

```text
packages/
  core/       纯内存分析核心；已有 Span、解析、模板与保守语义切片
  hosts/      YAML/Bash/jq 源码映射及 GitHub run 提取原型
  workspace/  .github 项目探查、单次检查的按文件快照与依赖边；完整失效管理待实现
  cli/        只读 check 命令；0.1.0 已公开发布，完整首版验收仍待完成
  lsp/        语言服务适配器（后续阶段，首版不实现）
```

依赖方向为 `hosts → core`、`workspace → core/hosts`、`cli → core/hosts/workspace`、`lsp → workspace`。四个 `@pipe-ls/*` 运行时包已以 `0.1.0` 公开发布；根 workspace 和未实现的 LSP 保持 private。`pnpm test:integration` 仅在临时副本中运行 case 1 的五个矩阵输入及 support-portal 回归，不运行 workflow、git/gh 或部署命令。`pnpm test:package` 将四个运行时包及三项固定版本依赖打成 tarball，在**全新空 pnpm store** 的临时目录离线安装，并验证 CLI/WASM 不回链源码仓库、MIT `LICENSE` 和[第三方许可证清单](packages/cli/THIRD_PARTY_NOTICES.md)进入相应包。`pnpm pack:offline` 将同一套 tarball、校验值和安装说明写入 `release/offline-0.1.0/`（已有目录不覆盖；可传入其他输出路径）；这是本地分发物，与 npm 发布包分开。解析/WASM 验证资产的版本、校验值和限制见[解析原型验证记录](docs/parser-prototype.md)；VS Code 客户端尚未实现。

## 核心约定

- **仅以 `.github` 目录确定项目根。** 从入口所在目录向上寻找最近包含 `.github/` 的目录；不读取项目级配置文件，也不以版本控制或包配置推断根目录。随后从脚本、头部声明和 CI 文件发现分析目标与执行上下文。
- **脚本即函数，数据只用 JSON 传入、传出。** 所有业务参数通过 stdin JSON 或声明的环境变量传入，不使用位置参数；stdin/stdout 和业务环境变量都遵循 JSON 契约，stderr 用于日志，不是返回值。
- **接口写在脚本开头。** `stdin:`、`stdout:` 后直接写 JSON 形状的结构模板，不再套 `json<...>` 或声明普通文本通道。
- **只有 JSON 数据类型。** 对象、数组、字符串、数字、布尔值和 null；没有 `unknown`、`any` 或普通文本数据类型。JSON 字符串 `"Alice"` 合法，裸文本 `Alice` 非法。
- **一个已声明的接口值是一份 JSON 文档。** 多条记录放入数组；无返回值时省略 `stdout`，调用方不能把其输出当业务返回值。显式声明 `stdout: null` 时仍必须输出 JSON `null`。不使用 stdin 时可省略该输入声明；通道不存在不是新增一种数据类型。jq 内部可以产生流，但作为返回值时必须收集为一个 JSON 值。CI 仅暴露显式输出映射，未提供 output 的 CI 不能被调用方解析出返回数据。
- **校验发生在开发阶段。** CLI（以及后续 LSP）检查调用方是否满足输入声明、脚本实现是否满足已声明的输出接口，不要求脚本重复进行运行时结构校验。外部入口的声明是信任前提，不是运行时防护。
- **无法分析不是一种类型。** 缺少契约、不支持的语法或动态来源会产生阻断检查的诊断，不获得一个可以继续传递的兜底类型。

## 示例

```bash
#!/usr/bin/env bash
# @pipe stdin: {"user_id": number, "name": string | null}
# @pipe stdout: {"id": number, "display_name": string}
jq -c '{id: .user_id, display_name: (.name // "anonymous")}'
```

模板沿用 JSON 的对象与数组形状，用 `number`、`string` 等占位符描述数据，不是可直接 `JSON.parse` 的实例。所有字段默认必需；上例的 `name` 可以为 null，但不能缺失。

在编辑器中，应能补全 `.user_id`、悬停查看类型与声明来源、跳转到字段声明，并在字段使用、JSON 编码或返回结构不匹配时即时定位问题。

## 产品范围

首版支持 `.github` 项目内的独立 `.sh` 与 GitHub Actions，语法及跨 step/job 数据流范围覆盖 [case 1](tests/cases/1/README.md)。GitLab CI 和 LSP 适配后续实现。每个平台独立处理 shell、环境、执行边界及配置文件位置映射，不把所有 CI 脚本拼成一个 Bash 文件。

LSP 能力按可靠性逐步增加，不限于 diagnostics/hover；具体阶段见实施计划。任意 Bash 的完整推导、执行用户代码获取类型、一般安全漏洞扫描不是项目目标。可以与 bash-language-server、ShellCheck 并用。

## 文档

- [总体设计](docs/design.md)：架构、契约接入、LSP 能力、CI 与安全边界。
- [类型与分析语义](docs/type-system.md)：模板语法、JSON 边界、jq 与 Bash 数据流。
- [实施与验证计划](docs/implementation-plan.md)：交付顺序、测试和验收。
- [解析原型验证记录](docs/parser-prototype.md)：Bash/jq/YAML 路线、源码映射、case 1 场景矩阵及待验证边界。
