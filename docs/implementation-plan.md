# 实施与验证计划

当前已建立 pnpm workspace、TypeScript strict、Vitest、lint 与构建入口，并提供 UTF-16 Span 基础模型及单元测试；尚无分析器、可执行命令或产品测试，P0 尚未完成。按纵向可用功能交付，不以空目录/接口数量代替完成，不在原型验证前承诺工期。

本轮仅修订 case 与规范，以下分析能力均待后续实现。首版范围为 CLI + Bash/GitHub Actions，覆盖 [case 1](../tests/cases/1/README.md) 的语法和数据流；仅以 `.github` 目录判定项目根，不读取项目级分析配置，暂不实现 LSP 适配。

## 1. 交付顺序

### P0：固定范式，验证解析和映射

- pnpm workspace、TypeScript strict、Vitest、版本锁定、WASM 加载/许可证/干净构建说明。
- JSON 模板/头部 parser；拒绝非 JSON 类型、重复声明和旧语法。类型兼容性和“检查受阻”的独立状态测试先落地。
- Bash/jq parser 与 UTF-16 Span、可组合 SourceMap；验证中文/emoji/CRLF、错误恢复、树释放及 YAML folded/转义映射原型。
- 以 `tests/cases/1/.github` 下的真实脚本与 GitHub Actions fixture 固定首版覆盖矩阵，记录输入/输出、预期诊断、依赖缺口及语法清单；GitLab 和 LSP fixture 后续加入。

验收：解析不崩溃、范围准确；明确区分非法声明/语法与暂不支持。选定 jq parser 路线；差分基准锁定 jq 1.7.1，其他版本单列兼容测试。core import 不触达 LSP、文件系统、网络或 child_process。

### P1：独立脚本最小闭环，同时建立 workspace

先打通 **头部 JSON 模板 → 赋值/printf/管道/命令替换 → 静态 jq → 已声明 stdout 检查／无返回接口 → CLI**，以[语义示例](type-system.md)为最小 fixture，再扩展到 case 1；不能以只通过最小子集代替首版覆盖目标。

随后补齐 case 1 的循环/函数/case/正则/参数展开/read/IFS/进程替换、jq reduce/动态索引/更新/条件/-e，以及 yq/外部命令模型、TSV/业务 YAML 来源和副作用摘要；逐项先建立否定与失败路径测试。循环与 reduce 先建立固定点/effect 方案，有限平台 key 展开封闭对象联合，超预算不伪造通过。workspace 此时就具备只读快照、`.github` 根发现、路径安全和依赖图；core 不承担临时磁盘扫描职责。

验收：只根据最近 `.github` 目录定位项目，无标记返回项目发现错误；不读取项目级配置。正例通过，裸文本/多值/类型不符失败；独立调用无返回脚本合法，消费其返回值失败；未知命令/不支持的调用不能通过。声明 stdout 时聚合检查所有成功路径；一次读取 stdin 后从捕获值提取多个参数，不能重复消费入口。CLI text/JSON 输出、排序、稳定 code 和退出码固定；CLI 不依赖 LSP。

### P2：GitHub Actions + case 1 CLI 闭环（首版 MVP）

- GitHub Actions Bash run、上下文优先级、step 隔离、YAML 完整位置映射、模板边界及常用 JSON 注入转换。
- case 1 的 `GITHUB_OUTPUT/GITHUB_ENV`、跨 step/job 数据流、toJSON/fromJSON/join、needs/if/result/skipped 条件依赖，以及本地 reusable workflow 输入和显式输出映射。无返回 CI 合法，但调用方不能消费不存在的 output。
- CLI 多项目入口、只读依赖快照、反向依赖失效、预算和宿主诊断聚合；不实现 LSP 服务或编辑器客户端。

验收：在补齐受控业务文件及被调 workflow 的 fixture 中验证完整调用链；当前 case 保留的缺失依赖应准确诊断，而不是因为缺少文件跳过所有脚本分析。该 case 列出的语法不再仅因首版子集太小而全部受阻；数据或效果无法证明时仍明确报告原因。反例覆盖 JSON 重复编码、漏编码、读取不存在的返回接口、条件缺失及跨项目访问。CLI 报告使用原文件位置，不执行业务命令或访问远程。

### P3：LSP 适配与主流 CI（首版之后）

- GitLab CI 本地可解析配置、同 shell/新 shell 边界及原文件映射；无法展开的远程配置明确受阻。
- LSP stdio、full sync、diagnostics/hover、补全、定义跳转、调用签名、文档符号及最小 VS Code 客户端；未保存文档、取消、版本检查、多工作区、CLI/LSP 同快照结果一致。
- 引用查找、workspace symbols、安全 rename、语义高亮和内联提示，建立字段来源与符号身份测试；未闭合引用范围不允许重命名。

验收：真实 CI fixture 获得和独立脚本一致的编辑能力，跨文件改动不漏刷新；不把同名但无关的 JSON 字段一起改掉。

### P4：按使用反馈扩展

扩展 case 1 以外的 jq builtin/flag、Bash 控制流和函数；引入精确映射的 code actions、折叠/选择范围和安全的嵌入格式化。schema 导入先定义可转换子集。其他 CI、性能优化按真实案例排优先级。

每项能力先加否定用例和受阻传播测试，再开放。补全/导航可先于完整类型分析支持某种语法，但不能因此增加“已检查”覆盖率。

## 2. 必测矩阵

| 层 | 核心断言 |
| --- | --- |
| 接口/模板 | 只有 JSON 类型；仅支持 stdin/stdout/env 声明，拒绝位置参数声明和位置业务参数输入；string 编码与裸文本分开；字段必需/封闭、null 与缺失不同；数组/备选模板与字面量兼容性正确 |
| 信任边界 | 入口声明是前提，不要求运行时校验；已知反例不能被声明覆盖；缺少契约阻断检查而不是产生兜底类型 |
| jq | 字段、null、select、//、map(empty)、对象多结果符合参考 jq；基数包围实际值；flag 和转换不忽略 |
| Bash 编码 | 引号、拼接、IFS/glob、尾 LF、NUL、固定 printf、stderr 混入与重定向顺序正确 |
| stdin/stdout | 无 stdin/stdout 接口与 JSON null 分开；消费不存在的返回接口失败；连续消费者、命令替换共享消费、jq -n 不读、分支可能耗尽；已声明 stdout 的所有成功路径整体恰好一份 JSON |
| 作用域/状态 | export、命令前 env、子 shell、函数遮蔽不误用事实；失败后继续、pipefail/set -e 不伪造成功证明 |
| 项目探查 | 从 cwd/文件/目录入口向上找最近 `.github`，无标记失败；不以 git/jj/package 或项目配置兜底；case 1 根为 tests/cases/1；嵌套项目隔离、symlink 不越界；显式 paths 限定目标 |
| 依赖 | 调用 stdin/env、缺文件、循环、坏输出契约、CI 文件与未保存依赖变更都传播结果 |
| CI | shell/cwd/env 优先级、step 隔离、条件缺失、JSON 编码与重复编码；跨 step/job 及 workflow 显式 outputs；无 output 的 CI 不可被消费返回值；原始 secret 不进日志 |
| 映射 | literal/folded/chomping、引号转义、中文/emoji/CRLF、模板 hole；非精确位置不提供编辑 |
| 编辑功能（后续） | 字段补全随输入变化；跳转来源、引用身份正确；rename 不越过外部 API/动态引用；编辑带版本检查 |
| CLI／后续协议 | 首版检查多 unit 聚合、退出码、空输入/全部排除不返回成功；后续增加快速连续编辑、取消、关闭、多工作区、CLI/LSP 一致 |
| 安全/资源 | 无用户代码执行/远程访问/越界读取；symlink、深 AST、YAML alias、类型组合和超时均有显式限制 |

## 3. jq 语义基准

开发测试只运行固定、受控 fixture，不执行用户脚本。jq 1.7.1 为基准，执行设超时；对结果流使用多值解码，不假定一行一个 JSON；`-r` 单独断言原始字节。

| 命令/输入 | 期望 |
| --- | --- |
| `jq -n 'empty'` / `jq -n '[empty]'` | 零项 / 一项空数组 |
| `jq -n '1, 2'` / `jq -n '[1, 2]'` | 两项 / 一项数组 |
| `jq -n '{id: (1, 2)}'` | 两个对象 |
| `jq -n '(null, 1) // 2'` / `jq -n '(false, null) // 2'` | 仅 1 / 仅 2 |
| `jq -n 'null \| length'` / `jq -n 'null \| ascii_upcase'` | 0 / 类型失败 |
| 输入 `[1,2]`，`jq 'map(empty)'` | 一个空数组 |
| 空 stdin，`jq -s '.'` | 一个空数组；不等于声明了 stdin 模板的脚本入口可接受 EOF |
| `jq -n --arg v 'true' '$v'` / `jq -n --argjson v 'true' '$v'` | JSON string / boolean |
| `jq -n --argjson v '1 2' '$v'` | 解码失败 |
| 输入 `{"name":"Alice"}`，`jq -r '.name'` | `Alice` + LF，不是 JSON string 编码 |

性质测试生成符合模板的 JSON 小值，检查实际结果落在推导的结构/数量范围内，失败缩减为 fixture。有限样本不代替证明；未完成分析的情况不能纳入通过统计。

## 4. 完成标准

已有工程验证入口：`pnpm install --frozen-lockfile`、`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build`。其中测试目前只覆盖基础模型，不代表产品能力通过验收。待实现：`pnpm test:integration`、`pnpm test:package`。

安装包在独立临时目录离线加载 WASM、执行 check，携带版本与许可清单，不依赖开发仓库绝对路径；LSP 启停验证留到适配器实现后。初始性能目标为 100KB 文档暖分析 p95 < 200ms、100 个典型 unit 冷 CLI < 5s；记录机器/版本/fixture hash 和峰值内存，未实测前不作为宣传结论。

首版 MVP 完成须同时满足：case 1 覆盖矩阵及支持范围内正例/反例/受阻例稳定；CLI 闭环可用；`.github` 根发现且不读取项目级配置；无返回接口语义正确；不完整检查不返回通过；分析时不执行用户代码、不访问远程资源、不泄露敏感数据；README 只描述真实已实现能力。LSP/编辑闭环不是首版验收条件。

工程初始化阶段只验证工具链、基础模型及构建，不宣称产品测试已通过。
