# pipe-ls

**为约定式 Bash + jq 脚本及主流 CI 提供结构化开发体验的语言服务器。**

目标不是检查任意 Bash，而是让运维在约定脚本风格下获得字段补全、类型提示、跳转、引用、重命名和即时诊断，减少纯文本开发中的猜测与手工核对。CLI 复用同一分析核心，在 CI 中执行相同检查。

当前只有设计文档，尚未实现 CLI 或 LSP；下文均为待实现约定。

## 核心约定

- **自动探查项目，无需专用配置文件。** 从项目中的脚本、头部声明和 CI 文件发现分析目标与执行上下文。
- **脚本即函数，数据只用 JSON 传入、传出。** 所有业务参数通过 stdin JSON 或声明的环境变量传入，不使用位置参数；stdin/stdout 和业务环境变量都遵循 JSON 契约，stderr 用于日志，不是返回值。
- **接口写在脚本开头。** `stdin:`、`stdout:` 后直接写 JSON 形状的结构模板，不再套 `json<...>` 或声明普通文本通道。
- **只有 JSON 数据类型。** 对象、数组、字符串、数字、布尔值和 null；没有 `unknown`、`any` 或普通文本数据类型。JSON 字符串 `"Alice"` 合法，裸文本 `Alice` 非法。
- **一个接口值是一份 JSON 文档。** 多条记录放入数组；无业务返回值输出 JSON `null`，不以空输出替代。不使用 stdin 的脚本可省略该输入声明，这表示没有输入通道，而不是新增一种数据类型。jq 内部可以产生流，但返回前必须收集为一个 JSON 值。
- **校验发生在开发阶段。** LSP 检查调用方是否满足输入声明、脚本实现是否满足输出声明，不要求脚本重复进行运行时结构校验。外部入口的声明是信任前提，不是运行时防护。
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

优先支持独立 `.sh`、GitHub Actions 和 GitLab CI。每个平台独立处理 shell、环境、执行边界及配置文件位置映射，不把所有 CI 脚本拼成一个 Bash 文件。

LSP 能力按可靠性逐步增加，不限于 diagnostics/hover；具体阶段见实施计划。任意 Bash 的完整推导、执行用户代码获取类型、一般安全漏洞扫描不是项目目标。可以与 bash-language-server、ShellCheck 并用。

## 文档

- [总体设计](docs/design.md)：架构、契约接入、LSP 能力、CI 与安全边界。
- [类型与分析语义](docs/type-system.md)：模板语法、JSON 边界、jq 与 Bash 数据流。
- [实施与验证计划](docs/implementation-plan.md)：交付顺序、测试和验收。
