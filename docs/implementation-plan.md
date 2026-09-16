# 实施与验证计划

当前只有设计文档，没有已实现的包、命令或产品测试。按纵向可用功能交付，不以空目录/接口数量代替完成，不在原型验证前承诺工期。

## 1. 交付顺序

### P0：固定范式，验证解析和映射

- pnpm workspace、TypeScript strict、Vitest、版本锁定、WASM 加载/许可证/干净构建说明。
- JSON 模板/头部 parser；拒绝非 JSON 类型、重复声明和旧语法。类型兼容性和“检查受阻”的独立状态测试先落地。
- Bash/jq parser 与 UTF-16 Span、可组合 SourceMap；验证中文/emoji/CRLF、错误恢复、树释放及 YAML folded/转义映射原型。
- 收集一小组真实风格的独立脚本、GitHub Actions 和 GitLab CI fixture，记录预期 LSP 操作、能发现的错误及尚不支持的语法。用它们决定后续优先级。

验收：解析不崩溃、范围准确；明确区分非法声明/语法与暂不支持。选定 jq parser 路线；差分基准锁定 jq 1.7.1，其他版本单列兼容测试。core import 不触达 LSP、文件系统、网络或 child_process。

### P1：独立脚本最小闭环，同时建立 workspace

先打通 **头部 JSON 模板 → 赋值/printf/管道/命令替换 → 静态 jq → 完整 stdout 检查 → CLI**，以[语义示例](type-system.md)为首批 fixture，不一开始铺开所有语法。

随后补齐有限分支、重定向、stdin 消费、外部命令签名、本地脚本调用与循环检测。workspace 此时就具备只读文件访问、项目自动探查、路径安全、目标/依赖快照和最小符号索引；core 不承担临时磁盘扫描职责。

验收：无需专用配置文件即可发现独立脚本，CLI 省略 paths 时自动探查项目；正例通过，裸文本/多值/类型不符失败；无契约/不支持的调用不能通过；stdout 聚合和多次读取 stdin 正确。CLI text/JSON 输出、排序、稳定 code 和退出码固定；CLI 不依赖 LSP。

### P2：可用的编辑器体验 + GitHub Actions（MVP）

- LSP stdio、full sync、diagnostics/hover、jq 字段与接口补全、定义跳转、调用签名、文档符号；提供最小 VS Code 接入以实际体验，不只有协议测试。
- GitHub Actions Bash run、上下文优先级、step 隔离、YAML 完整位置映射、模板边界及常用 JSON 注入转换。
- workspace 未保存文档、反向依赖失效、缓存、取消/预算、多工作区、宿主诊断聚合。

验收：独立脚本与 YAML 内都能完成“补全字段 → 查看来源 → 跳转接口 → 修改后即时诊断”的编辑闭环；同快照 CLI/LSP code/range 一致。旧任务不发布结果，不出现虚拟 URI；无法确定的源码插值不能产生虚假结论。

### P3：主流 CI 与跨文件编辑能力

- GitLab CI 本地可解析配置、同 shell/新 shell 边界及原文件映射；无法展开的远程配置明确受阻。
- GitHub 单行 JSON 编码的 outputs/env 跨 step 数据流，条件缺失性和覆盖规则；跨 job 在独立依赖模型验证后再启用。
- 引用查找、workspace symbols、安全 rename、语义高亮和内联提示，建立字段来源与符号身份测试；未闭合引用范围不允许重命名。

验收：真实 CI fixture 获得和独立脚本一致的编辑能力，跨文件改动不漏刷新；不把同名但无关的 JSON 字段一起改掉。

### P4：按使用反馈扩展

增加常用 jq builtin/flag、Bash 控制流和函数；引入精确映射的 code actions、折叠/选择范围和安全的嵌入格式化。循环分析先有固定点/effect 方案；schema 导入先定义可转换子集。其他 CI、性能优化按真实案例排优先级。

每项能力先加否定用例和受阻传播测试，再开放。补全/导航可先于完整类型分析支持某种语法，但不能因此增加“已检查”覆盖率。

## 2. 必测矩阵

| 层 | 核心断言 |
| --- | --- |
| 接口/模板 | 只有 JSON 类型；仅支持 stdin/stdout/env 声明，拒绝位置参数声明和位置业务参数输入；string 编码与裸文本分开；字段必需/封闭、null 与缺失不同；数组/备选模板与字面量兼容性正确 |
| 信任边界 | 入口声明是前提，不要求运行时校验；已知反例不能被声明覆盖；缺少契约阻断检查而不是产生兜底类型 |
| jq | 字段、null、select、//、map(empty)、对象多结果符合参考 jq；基数包围实际值；flag 和转换不忽略 |
| Bash 编码 | 引号、拼接、IFS/glob、尾 LF、NUL、固定 printf、stderr 混入与重定向顺序正确 |
| stdin/stdout | 无 stdin 接口与 JSON null 分开；连续消费者、命令替换共享消费、jq -n 不读、分支可能耗尽；所有成功路径 stdout 整体恰好一份 JSON |
| 作用域/状态 | export、命令前 env、子 shell、函数遮蔽不误用事实；失败后继续、pipefail/set -e 不伪造成功证明 |
| 项目探查 | 无专用配置即可发现脚本和已支持的 CI 文件；排除目录不扫描，路径不越界；显式 paths 限定目标；文件新增/删除/修改及时更新目标与依赖；缺少上下文不猜测 |
| 依赖 | 调用 stdin/env、缺文件、循环、坏输出契约、CI 文件与未保存依赖变更都传播结果 |
| CI | shell/cwd/env 优先级、step 隔离、条件缺失、平台文本的显式 JSON 编码和重复编码；原始 secret 不进日志 |
| 映射 | literal/folded/chomping、引号转义、中文/emoji/CRLF、模板 hole；非精确位置不提供编辑 |
| 编辑功能 | 字段补全随输入变化；跳转来源、引用身份正确；rename 不越过外部 API/动态引用；编辑带版本检查 |
| 协议/CLI | 快速连续编辑、取消、关闭、多工作区、多 unit 聚合；CLI/LSP 一致；空输入/全部排除不返回成功 |
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

待实现验证入口：`pnpm install --frozen-lockfile`、`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build`、`pnpm test:integration`、`pnpm test:package`。

安装包在独立临时目录离线加载 WASM、执行 check、启动/关闭 LSP，携带版本与许可清单，不依赖开发仓库绝对路径。初始性能目标为 100KB 文档暖分析 p95 < 200ms、100 个典型 unit 冷 CLI < 5s；记录机器/版本/fixture hash 和峰值内存，未实测前不作为宣传结论。

MVP 完成须同时满足：支持范围内正例/反例/受阻例稳定；编辑闭环可用；CLI 与 LSP 共用规则；不完整检查不返回通过；不执行用户代码、不访问远程资源、不泄露敏感数据；README 只描述真实已实现能力。

设计阶段只验证文档链接、示例语法及本机可运行的受控样例，不宣称产品测试已通过。
