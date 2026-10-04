# P0 解析与源码映射验证记录

本记录验证技术路线，不表示 case 1 已通过静态分析。当前测试执行解析、位置映射和矩阵完整性检查；`PIPE` 诊断、Bash/jq 数据流、外部命令效果及 CI 契约仍待分析器实现。参见 [case 1 矩阵](../tests/cases/1/matrix.json)。

## 路线与固定资产

| 层 | 原型 | 已验证 | 尚未证明 |
| --- | --- | --- | --- |
| Bash | `web-tree-sitter@0.27.0`（MIT）+ `@vscode/tree-sitter-wasm@0.3.1` 的 Bash grammar（MIT）；由调用方注入运行时与 grammar WASM bytes | 两份脚本、五段 `run` 无语法错误；错误恢复保留 `ERROR`；索引按 JS UTF-16 可定位中文、emoji、CRLF | 所有 Bash 语义、资源预算、增量编辑、最终离线安装包 |
| jq | 自有 lexer + Pratt/递归下降的 **语法原型** | case 1 的 46 个静态单引号 filter 全部解析；token/AST 保留 UTF-16 span；语法错误与已知不支持项分开 | jq 1.8.2 完整语法/语义、flag、类型/数量/失败路径；动态 filter 不按静态通过 |
| YAML | `yaml@2.9.1`（ISC）的 AST + `keepSourceTokens` | workflow 解码、五段 run 提取；plain/literal/folded/quoted、chomping、CRLF 和转义的代表性映射 | alias/tag、多行复杂转义的精确映射；未支持形态只给整段非精确位置 |

Bash grammar 测试资产 SHA-256：`a14e9ed880b2c3f16cd00c796c38d237a3e9b028bdec5b4315c76976e67b01ca`；`web-tree-sitter` 运行时 WASM SHA-256：`c03bccdc3b448a32848f5ae327e209c982bbb0840d43eec8bc2d5759544a1ed3`。两份校验和均在测试中断言；解析核心不自行读取文件或下载资产。当前根目录的 grammar WASM 包是开发/验证依赖，正式 CLI 打包仍须只带所需 grammar，离线验证与许可证清单尚未完成。`web-tree-sitter` 上游声明缺少 `EmscriptenModule` 类型，项目中有仅供编译的 ambient shim，不改变运行时行为。

没有采用 `tree-sitter-jq@1.0.2`：其公开包许可证为 GPL-3.0-or-later，与本项目当前依赖路线不合。自有原型保留字段、对象 key、动态索引、reduce 等语法节点，但**不**做类型推断。jq 字符串插值等范围外形式返回 `JqUnsupportedSyntaxError`，而不是伪装成已支持的合法 filter；原型的 `JqSyntaxError` 也不应直接等同于最终 `PIPE001`，仍需语法边界验证。

## 映射链

`MappedText` 以 UTF-16 code unit 为单位保存原始来源，验证链路为 **jq token → Bash 单引号正文 → YAML scalar → 原始 workflow**。同一行不经转换的字段可得到 `exact`；折叠换行、转义、CRLF 归一化及跨剥离缩进的范围标为 `decoded`，可用于解释性诊断，不能用于自动编辑。尚未覆盖的 YAML 解码形态回退为整段 scalar 的 `decoded` 位置，不制造假精度。后续应将逐字符原型压缩为有预算的分段映射，并增加跨片段 related locations。

## case 1 矩阵与执行边界

`matrix.json` 包含 **5 正例、13 反例、5 受阻例**，给出具体输入、正例所需合成依赖、可物化的源文件变更/片段、预期事实及未来诊断码。测试目前断言：引用确实来自 allowlist 且唯一、JSON 特殊字符往返、变更锚点唯一、变更后仍可被 Bash/YAML/jq 解析、缺失依赖确实缺失；**不**断言分析器已经产生预期 `PIPE` 诊断。待 P1/P2 实现后，应把这些 oracle 接入 CLI fixture runner 并检查原文件诊断位置和退出码。

当前 `resources/**` 与 `.github/workflows/do-rollout-restart.yaml` 故意缺失，完整检查须报告 `PIPE204`，不能因解析成功声称 case 1 通过。OMP allowlist 的重复 repository 是单独的数据质量问题，矩阵正例选择唯一行，不把它误报为 JSON 接口错误。不得直接执行整个 workflow，也不得在测试中运行 git/gh/云操作。完整运行时回归只能在临时副本与合成 overlays 上做；本轮未运行。

复现：`pnpm lint && pnpm typecheck && pnpm test && pnpm build`。本机 jq 1.8.2 已设为语义基准，尚未完成以该版本为基准的差分测试。P0 的 JSON 模板 parser、完整分段映射及离线包装仍是后续工作。
