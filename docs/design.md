# 总体设计

## 1. 产品与交付边界

pipe-ls 面向愿意采用 **JSON 接口 + 头部结构声明 + Bash/jq 实现** 的运维脚本。首要价值是结构化编辑体验，静态检查核心同时服务 LSP 和 CI CLI。

- 首个可用版本覆盖 `.github` 项目内的独立 Bash 与 GitHub Actions，以 `tests/cases/1` 的语法和数据流为覆盖目标，提供 CLI 检查和诊断；暂不实现 LSP 适配，也不读取项目级配置文件。
- GitLab CI、引用查找、安全重命名、语义高亮、内联提示、代码操作等按阶段增加；不是永久排除的能力。
- 不追求任意 Bash/jq 的完整推导。动态行为暂不能分析时，要说明受影响范围，而不是猜类型或悄悄通过。
- 不生成运行时 JSON 校验器。类型结论基于声明的外部输入与命令契约，不保证网络、权限等操作性成功。

## 2. 接口与信任边界

### 脚本接口

```bash
#!/usr/bin/env bash
# @pipe stdin: {"user_id": number, "enabled": boolean}
# @pipe env OPTIONS: {"region": string}
# @pipe stdout: {"id": number, "enabled": boolean, "region": string}
jq -c --argjson options "$OPTIONS" \
  '{id: .user_id, enabled: .enabled, region: $options.region}'
```

有业务返回值时声明 `stdout`，无返回值时省略；调用方不得把没有 `stdout` 声明的脚本输出作为业务值消费。读取业务 stdin 时必须声明 `stdin`，不读取时可省略，表示没有该输入接口而非接受任意文本。每条注解占一行，位于 shebang 后、首条可执行语句前的注释/空行区。缺少必需输入声明、重复或非法声明给契约错误；单纯省略 `stdout` 合法。所有业务参数只能通过 stdin JSON 或声明的环境变量传入，不支持位置参数声明或通过位置参数传入业务数据。声明的输入均必需；env 声明不创建或设置环境变量，由调用方提供。

每个已声明的数据通道传递一个 JSON 值；stdin 或业务环境变量中的 `true` 是 JSON 布尔编码，`"prod"` 才是 JSON 字符串编码。省略 `stdout` 表示不存在返回接口，不等同于 `stdout: null`；显式声明后者时必须输出字面量 `null`。无返回接口时 stdout 可以为空或包含不可作为业务数据消费的命令日志，建议日志仍走 stderr。若显式声明 `stdin: null`，调用方仍须传入字面量 `null`，不能用 EOF 替代；省略 stdin 的脚本不得读取继承的 stdin 或接收调用者的业务管道输入。

命令名、flag、jq filter、路径和宿主执行环境属于控制信息，不要求把 shell 语法变成 JSON。未声明的系统环境变量不自动成为业务数据输入；作为业务数据使用时必须有接口契约或显式 JSON 编码转换。stderr 日志不受数据模板约束，混入已声明的 stdout 后仍需检查。

JSON 限制针对脚本/CI 业务接口，不要求改变 jq/yq/gh 等外部工具的原生调用协议。内置命令模型必须明确其 argv、env 编解码和副作用，例如 JSON env 解码后传给 gh 的 `GH_TOKEN`、yq 的 `strenv`；不能把任意无签名命令视为可信转换。脚本内部日志辅助函数（如 `fail "$message"`）可用原生参数，但须分析函数体和失败路径，不能借函数绕过脚本接口限制。

### 检查责任

| 边界 | 责任 |
| --- | --- |
| 外部调用工作区入口 | 输入声明作为调用者必须遵守的前提；不读取真实输入或要求脚本自行校验 |
| 工作区内脚本调用 | 在调用点检查实际 stdin/env，拒绝位置业务参数；独立检查被调脚本正文与输出声明 |
| 外部业务命令 | 显式签名作为信任契约，报告保留来源；不执行命令采样 |
| CI 注入数据 | 区分平台文本与 JSON 编码；已知平台转换/常量不能被矛盾的注解覆盖 |
| 缺少证据或超出分析能力 | 报告检查受阻，受影响结论不能通过；不引入兜底数据类型 |

声明不是覆盖推断的强制断言。调用已违反契约、正文输出不匹配或依赖未完成分析时，不能仅凭头部声明证明整条调用链正确。外部输入合法性的承诺与工作区内可检查的错误必须分开显示。

### 自动探查项目

首版仅以 `.github` 目录判断项目 path：从 CLI 当前目录或显式入口的所在目录向上，找到最近包含真实 `.github/` 目录的目录作为项目根。入口为目录时从该目录开始；入口位于 `.github` 内时根为其所属项目目录。找不到标记时报告项目发现错误（退出码 2），不回退到 `.git`、`.jj`、`package.json` 或当前目录。多个入口分别确定所属项目，不跨根解析依赖。`tests/cases/1/.github` 对应的项目根是 `tests/cases/1`。

不读取任何项目级分析配置文件，不通过配置覆盖根、目标、规则或命令签名。显式 paths 限定检查目标；省略 paths 时从已确定项目根发现目标。依赖路径经 realpath 校验，不允许 `.github` 标记或依赖 symlink 越出项目边界；遇到嵌套项目根时不混入外层项目。LSP 工作区接入留待后续实现。

在项目根内自动发现 `**/*.sh`、`.github/workflows/*.{yml,yaml}`，GitLab 适配器加入后识别 `.gitlab-ci.yml` 及其本地引用。始终排除 `.git/.jj/node_modules`。从脚本头部、shebang、本地调用关系和 CI 文件提取接口及执行上下文；新增、删除或修改相关文件时更新目标与依赖快照。

本地脚本只解析工作区内静态路径及 `bash <path>`，依据已知 cwd，不搜索本机 PATH。无 shebang 的文件可由 `bash <path>` 调用或 CI 宿主确定 Bash 上下文；仅凭 `.sh` 扩展名不能把 `sh/zsh` 当 Bash，缺少上下文时报告检查受阻。

自动探查不等于猜测契约：缺少必需输入声明、消费不存在的返回接口、缺少外部命令签名或执行上下文时仍按对应规则诊断，不执行脚本或业务命令来获取信息。命令摘要必须保留正常/失败路径的 stdin 消费事实；无法确定读取行为时阻断后续相关检查。首版所需外部命令模型随工具版本内置，不从项目配置加载；不能覆盖 jq/printf 等核心语义或绕过同名 Bash 函数遮蔽。

首版不引入独立 JSON Schema 方言或泛型系统；后续若导入 schema，必须转换为同一 JSON 模板模型，不支持的约束明确诊断，不静默放宽。

## 3. 架构与技术选型

```text
独立 .sh / GitHub Actions / GitLab CI
  → hosts：脚本单元 + 执行上下文 + 可组合源码映射
  → core：Bash/jq 解析 → 接口/符号 → 数据流与契约检查
  → 分析结果：诊断 + 类型事实 + 符号/引用 + 依赖 + 完整性
  → LSP 编辑功能 / CLI 检查报告
```

- `core`：纯内存分析；不依赖文件系统、网络、子进程、宿主或 LSP。
- `hosts`：脚本提取、平台执行边界、模板表达式、源位置映射，依赖 core 公共模型。
- `workspace`：注入的只读文件访问、项目自动探查、不可变快照、依赖图、符号索引、缓存和调度。**最小实现从 P1 开始**，不是等 LSP 阶段再补。
- `cli/lsp`：共用 workspace，不重复实现规则；VS Code 客户端只做注册和协议接入。

选型：TypeScript strict、Node.js 22 或更新的受支持 LTS、pnpm workspace；Bash 使用 `web-tree-sitter` + `tree-sitter-bash` WASM；jq 使用带 span 的 lexer + Pratt/递归下降子集 parser，P0 同时评估现成 JS/WASM parser；YAML 使用 `yaml` AST/CST；测试 Vitest；协议使用 `vscode-languageserver`。首个实现提交锁定版本、WASM 来源/校验值和许可证。

参考 bash-language-server 的 WASM 加载、文档缓存和协议组织，不 fork 整个服务或继承其分析器；不复制 PATH 扫描、业务子进程等行为。若复用 MIT 代码或 parser 资产，保留并核对许可；构建不可依赖本机参考仓库路径。

核心输入为源码、项目探查结果、依赖快照和显式执行上下文；输出除诊断外，还应保留带来源的字段路径、声明、读写引用及映射精度，支持补全和导航。不要到实现重命名时再从诊断文本反推符号。对象字段不能仅因名字相同就视为同一符号，JSON 编解码或 jq 重构需维护明确来源关系。

## 4. LSP 功能设计（后续阶段，首版不实现）

| 能力 | 行为与边界 |
| --- | --- |
| diagnostics / hover | 展示 JSON 结构、编码状态、数量、契约来源及检查受阻原因；错误定位调用或字段使用处 |
| completion | jq 静态字段、头部模板、声明的 stdin 字段/env、已支持 builtin；基于当前位置输入结构，不猜测动态 key |
| definition / signature help | 字段到接口/构造来源，脚本调用到定义，stdin/env 输入到契约；多来源可返回多个位置 |
| document/workspace symbols、references | 基于声明和已解析的引用边；跨文件索引随依赖更新，覆盖不全时明确告知 |
| rename | 仅对静态、精确映射且引用范围可封闭的符号提供；涉及外部 JSON API、动态 key 或不完整依赖时拒绝，不能全局替换同名字串 |
| semantic tokens / inlay hints | 区分字段、接口、数据变量，展示必要的类型/参数信息，可关闭以减少噪声 |
| code actions | 精确定位下提供用户确认的修复；不能靠添加断言、忽略错误或无条件添加 `-r`/默认值改变业务语义 |
| folding / selection / formatting | 逐步支持结构化选择和折叠；嵌入格式化需保持宿主缩进、引用及语义，无可靠映射时不提供 |

后续 LSP 初版采用 full sync、stdio、push diagnostics；支持 initialize/shutdown、open/change/close、watched files 和多工作区。发布前校验文档及依赖版本，取消旧任务，使用未保存的内存内容；各 CI unit 诊断聚合到原文件，不能相互覆盖。修改操作同时校验所有目标文档版本，通过 WorkspaceEdit 交用户确认，不直接写盘。

核心 span 统一为 UTF-16 半开区间。映射链为 **jq → Bash 字符串 → CI scalar → 原文件**；使用分段映射，记录精确/解码/合成位置，不能只加行号偏移。范围跨片段时给主位置和 related locations；非精确映射允许解释诊断，但不允许自动编辑。必须测试中文、emoji、CRLF、转义和 folded scalar。

## 5. CI 接入

### GitHub Actions（首个适配器）

- 提取 `.github/workflows/*.{yml,yaml}` 的 `jobs.*.steps[*].run`；shell 按 step → job → workflow defaults 解析。仅静态确定为 Bash 时分析，自定义 shell 模板或缺少上下文给诊断；明确非 Bash 的 step 排除计数，`uses` 不当作 Bash。
- cwd 使用同样默认覆盖规则；env 按 workflow → job → step 覆盖。shell 变量/cwd 不跨 step。`if`、失败和 matrix 可能使输出缺失，不能按必定执行处理。
- YAML 1.2 解码需保留 scalar 的原始位置；支持 `|/>`、chomping、单/双引号及单行 plain scalar。alias/复杂 tag 暂明确报告不支持，不凭普通 JS 对象重建位置。
- `${{ ... }}` 先按宿主边界解析。能精确求值的常量按实际值映射；无法确定的直接 `run` 插值可能改变 Bash 语法，阻断该 unit 的语义证明，恢复树仅用于编辑导航。放入 env 的值不会改变脚本语法，但仍需满足 JSON 编码契约。
- CI 字符串不是自动合法的 JSON 字符串编码。支持已建模的 `toJSON` 序列化；例如字符串 input 经 `toJSON(inputs.environment)` 注入 env 后，可对应 `# @pipe env DEPLOY_ENV: string`，再用 `--argjson` 读取。具体结构来自平台声明/显式契约，不读取 secret 实值。重复编码也要检查，不能把 JSON 字符串误当对象。
- run 脚本也遵循 JSON 接口：仅从 env 取数据时省略 stdin 声明；无 stdout 返回值时省略 stdout 声明，不强制输出 null。不能假装 runner 会向 stdin 注入 JSON null。需要 stdin 的本地脚本应由 run 内的显式 JSON 管道或 here-string 调用。
- 首版覆盖 case 1 的 `GITHUB_OUTPUT/GITHUB_ENV` 单行 JSON 编码值、静态 key 写入及跨 step/job 数据流。平台 `name=value` 封装不是业务数据类型；读取方恢复 JSON 值，保留条件缺失性和覆盖顺序。`GITHUB_ENV` 只影响后续 step，跨 job 通过显式 job outputs 建依赖图。JSON 字符串必须编码，布尔文本 `true/false` 已是 JSON；不得重复编码已有 JSON 值。
- stdout 与 CI output 是不同通道：step 仅通过 `GITHUB_OUTPUT` 暴露命名 output，job 通过 `jobs.*.outputs` 映射，reusable workflow 通过 `on.workflow_call.outputs` 再显式导出。没有这些输出的 CI 合法，引用方不能从日志、内部 job 输出或 run 的 stdout 推导出不存在的 workflow output；消费缺失输出给契约诊断，而非返回 null/兜底类型。已声明但因条件跳过而缺失的输出须单独分析。
- 首版覆盖 case 1 的 `toJSON/fromJSON/join`、`needs/steps/inputs/github` 引用、布尔条件、`!cancelled()`、job result 和 skipped 分支。reusable workflow 的业务 `with` 值以 JSON 编码字符串传递；调用目标必须提供匹配的输入解释。平台原生元数据（如 action ref、shell 和 secrets 转发）不因此改写。本地 `uses` 依赖缺失必须诊断，不下载或臆造签名。

最小示例：平台字符串先编码，run 内只通过 JSON 接口读取和返回。

```yaml
on:
  workflow_dispatch:
    inputs:
      environment:
        type: string
        required: true
jobs:
  inspect:
    runs-on: ubuntu-latest
    steps:
      - shell: bash
        env:
          DEPLOY_ENV: ${{ toJSON(inputs.environment) }}
        run: |
          # @pipe env DEPLOY_ENV: string
          # @pipe stdout: {"environment": string}
          jq -nc --argjson environment "$DEPLOY_ENV" '{environment: $environment}'
```

### GitLab CI（紧随其后）

分别建模 `before_script/script` 的同 shell 和 `after_script` 的新 shell、runner shell、变量以及 artifacts/dotenv。支持范围内在原 YAML 提供同一组 LSP 能力；`include/extends/!reference` 只能可靠地本地展开，否则报告受阻，不下载远程配置。后续平台复用公共接口，不硬套 GitHub step 模型。

## 6. 检查报告与安全

首版待实现入口：`pipe-ls check [paths...] [--format text|json]`、`pipe-ls --version`。省略 paths 时按 `.github` 标记自动探查项目。`pipe-ls lsp --stdio` 属于后续阶段。

| code | 含义 |
| --- | --- |
| `PIPE001` | 已支持语法中的语法错误 |
| `PIPE101` | 数据不是所需的 JSON 编码 |
| `PIPE102` | JSON 类型/字段使用不匹配 |
| `PIPE103` | 接口要求一个值，实际零个或多个 |
| `PIPE104` | 声明缺失、非法或调用/返回不符合契约 |
| `PIPE201` | 缺少来源契约或转换证据 |
| `PIPE202` | 尚不支持的语法、flag、读取行为或副作用 |
| `PIPE203` | 缺少 shell/cwd 等上下文或平台分析能力 |
| `PIPE204` | 本地依赖不可读、资源超限等检查障碍 |

确定错误与检查受阻分开分类；上游根因只报一次，下游附来源。默认两者都阻止检查通过，不提供把缺失类型当合法数据的宽松模式。分析完整性为 `complete/partial/none`，与 `passed/failed/incomplete` 结果分开：检查完整也可能发现错误。

CLI 退出码：`0` 至少一个目标完成检查且所有目标通过；`1` 存在类型/契约/语法错误或检查受阻；`2` 无目标、全部排除、参数错误、入口不可读或内部故障；中断 `130`。JSON 报告带 `schemaVersion: 1`、版本、原始 URI/range、稳定 code、完整性、未验证依赖和契约假设；按 URI/offset/code 排序。CLI 行列从 1 开始，JSON/LSP 从 0 开始，列均为 UTF-16。

项目探查和依赖解析的路径经 realpath 限制在工作区边界内；不访问远程 URI、云平台或真实 secrets，不从 `process.env` 填充业务输入，不执行用户 Bash/jq/业务命令。日志不打印源码、payload 或环境值；LSP stdout 仅传协议。

缓存键包含内容、规则/parser 版本、项目探查结果、执行上下文和依赖版本；反向依赖失效，循环调用按 SCC 报告受阻。worker 隔离 parser/tree，定期取消并以终止 worker 兜底。文件数/体积、AST 深度、分支/类型组合和时间均设预算，超限不静默丢目标。依赖安装是显式开发操作，分析时不自动下载资产。
