# pipe-ls

**为约定式 Bash + jq 脚本及主流 CI 提供结构化开发体验的语言服务器。**

目标不是检查任意 Bash，而是减少约定脚本开发中的猜测与手工核对。首版先交付 Bash + GitHub Actions 的 CLI 静态检查，以 `tests/cases/1` 为覆盖目标；暂不实现 LSP 适配。字段补全、类型提示、跳转、引用、重命名和即时诊断属于后续编辑器能力，复用同一分析核心。

当前已初始化工程结构、开发工具链及 UTF-16 Span 基础模型，尚未实现分析器、CLI 或 LSP；下文产品能力均为待实现约定。

## 本地开发

使用 Node.js 22.13+（推荐 `.node-version` 锁定版本）与 pnpm 11.20.0。

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

`pnpm test:watch` 启动测试监听，`pnpm format` 格式化代码与配置。构建产物位于各包的 `dist/`，不纳入版本控制；删除产物后可直接重新构建，类型检查和单元测试不依赖预先构建。

```text
packages/
  core/       纯内存分析核心；目前仅有 Span 模型与单元测试
  hosts/      脚本/CI 提取与位置映射（待实现）
  workspace/  项目探查、只读快照与依赖管理（待实现）
  cli/        命令行适配器（待实现）
  lsp/        语言服务适配器（后续阶段，首版不实现）
```

依赖方向为 `hosts → core`、`workspace → core/hosts`、`cli/lsp → workspace`。所有包暂为 private，不提供可执行命令或发布包。尚未引入 parser/WASM 资产；其版本、校验值、许可证与离线加载验证将在解析器接入时补齐。集成测试、安装包测试及 VS Code 客户端也尚未实现。

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
