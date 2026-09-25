# P0 解析与源码映射验证记录

本记录保存 P0 技术路线的原型结论，表内“尚未证明”指 P0 当时的状态，不代表当前产品进度。当前已有 CLI 诊断与受控集成测试，但原 case 1 缺失业务依赖、首版尚未验收；进度以[实施计划](implementation-plan.md)和[case 1 矩阵](../tests/cases/1/matrix.json)为准。

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

`matrix.json` 包含 **5 正例、13 反例、5 受阻例**。P0 时只检查解析和锚点；现在 23 个场景均有 CLI 诊断或受控运行时 oracle。合成依赖下的静态通过不等于原 fixture 可通过，原文件诊断位置、动态副作用和完整发布验收仍需继续核查。

当前 `resources/**` overlays 仍缺失，完整检查须报告相应 `PIPE204`；真实 `.github/workflows/do-rollout-restart.yaml` 已收录，但尚未静态验收，华为路径所需的 `.github/tool-versions.env` 也缺失。不能因合成正例通过声称原 case 1 通过。OMP allowlist 的重复 repository 是单独的数据质量问题，矩阵正例选择唯一行，不把它误报为 JSON 接口错误。不得直接执行整个 workflow，也不得在测试中运行 git/gh/云操作。五个正例的 parse/update 运行时回归仅在临时副本与合成 overlays 上进行。

复现：`pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration && pnpm test:package`。本机 jq 1.8.2 是语义基准，已有少量参考差分测试；完整差分、分段映射及正式持久发布仍是后续工作。CLI tarball 已携带第三方许可证清单，并通过空 pnpm store 的临时离线安装冒烟。
