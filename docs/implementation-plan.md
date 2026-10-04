# 实施与验证计划

P0/P1/P2 的首版 **CLI + Bash/GitHub Actions 本地验收已完成**。pnpm workspace、TypeScript strict、UTF-16 解析/源码映射、JSON 契约、保守数据流及只读 CLI 覆盖 case 1 的 25 场景；真实 caller/callee 在合成 overlays/pins 下静态通过，没有替代 workflow/Action。最新工程、真实链性能及逐项证据见[首版验收记录](#5-首版验收记录)，下方历史数据不代表当前状态。git/gh、云工具与 Action 仅有明确限定的输入/效果模型，不证明远端目标、认证、实际工具内容或部署成功。原 fixture 缺少业务 overlays 和华为 CLI metadata 时仍准确 `PIPE204` 并继续独立分析，不要求提供生产资源/URL/SHA-256。四个 `@pipe-ls/*@0.1.0` 已公开发布、MIT；本轮新增代码尚未发布，后续需递增版本。P3/P4 不属首版验收范围。

当前分析覆盖有限 Bash 赋值/export/管道/命令替换、本地多层脚本契约调用、if/case/&&/|| 分支状态合并、有限 read 数组与 for 固定点、固定 TSV 和 `jq -c '.field[]'` JSON-lines 来源的 while/read 固定点，以及已证实的非零退出路径；只读依赖与 yq may-write 模型覆盖 case 1，任意 while/函数/文件效果仍不属于完整支持。另覆盖静态 jq 字段、集合、内建函数、短路条件、链式 `as` 和 reduce 固定点；GitHub env 注入、单行 `GITHUB_ENV/GITHUB_OUTPUT`、同 job 环境传递、显式 job output 生产者、有限 `needs`/`if` 与跨 job 数据流、本地 reusable 输入及源码映射已有检查。`GITHUB_ENV` 的受保护变量不当作有效写入；条件/分支写入只撤销对应事实，分析不完整时撤销全部。workspace 提供只读快照、依赖边、反向依赖影响闭包和不修改旧视图的派生快照；单文件 1 MiB、发现过程 10,000 项/64 层、YAML AST 10,000 节点/128 层/128 alias、模板 65,536 UTF-16 units/4,096 节点/128 层，异常或超预算明确阻断。CLI 每次检查重新建立快照，无监听或跨进程缓存；仅 `.github` 判根，不读项目级配置。范围外必须阻断，不能冒充支持。

未知第三方 `uses` step 被视为同 job 的环境效果屏障：后续 run 不再沿用屏障前的 `GITHUB_ENV` 事实；屏障后的已验证写入可以重新建立事实。此屏障不构成对 action 本身输出或文件副作用的验证。

仓库内容的只读快照仅在受支持的 checkout 后可信；未知 action、分析不完整的 run 或已报告 may-write 文件效果的 run 会阻断同 job 后续对原快照的本地文件、目录和脚本契约读取。再次受支持的 checkout 可重建证明；这不等于验证 action 的实际文件效果。

`kubectl rollout restart/status` 已有有限 argv 与成功路径模型；管道、命令替换、声明 stdout、未知选项或无法证明的参数展开仍受阻。`externalEffects` 仅摘要可能运行的命令族，不证明动态目标、集群配置或远端成功；真实被调 workflow 已在合成依赖下完整静态检查。

AWS CLI v2 的 `eks list-clusters` 已有显式 JSON/`clusters` 投影、禁止 pager/auto-prompt 的有限输出模型（`[string] | null`），配合字符串 `contains`、`jq -e` 及 checked substitution/pipefail 分析真实正文。`update-kubeconfig` 只汇总命令族与未知文件写入，不虚构 kubeconfig 路径/内容，并阻断后续本地快照读取；跨本地脚本/reusable workflow 传播，受支持的再次 checkout 可恢复后续仓库事实。失败被 `printf`/`export` 掩盖、缺 pipefail、未知选项/输出配置仍受阻。不验证凭据、实际集群或云端成功。

目标未解析的写入也可能覆盖 `GITHUB_ENV/GITHUB_OUTPUT`：同 run 的命名 env/output 摘要不再作为已验证生产者，后续 step 的旧 env 事实撤销；新 step 的独立已验证写入可以重新建立事实，不因此信任未知文件内容。

静态 runner 与显式 Bash 分离：字符串/有限静态标签数组不因不是 ubuntu-latest 而受阻，不推断 OS/工具；动态/复杂/空 selector 和未知 shell 仍受阻。1Password output-only 输出开放且可缺失，env-only 不允许消费秘密 outputs。AWS 仅支持已证明 trim 后非空 AK/SK 的 IAM envelope，禁用 role/existing 并证明空 profile/proxy；默认 credential fallback/其他认证路径受阻。post cleanup 仅有 job-end may-effects，不能提前建立或清除 env。上游依据、raw INPUT/ambient 优先级、输出边界见 [action 模型审计](action-model-audit.md)。

retry 主命令与替换命令按 step env、条件和 caller wire 检查；只有内嵌命令的 callee 也会检查。限定静态 envelope 以 may-effects 并集覆盖重复/失败/中断，不传播命名 env/output/仓库证明；非空 OS 默认 shell hook、动态/未知选项仍受阻，Action 输出名称检查不等于存在性证明。

## 1. 交付顺序

### P0：固定范式，验证解析和映射

- pnpm workspace、TypeScript strict、Vitest、版本锁定、WASM 加载/许可证/干净构建说明。
- JSON 模板/头部 parser；拒绝非 JSON 类型、重复声明和旧语法。类型兼容性和“检查受阻”的独立状态测试先落地。
- Bash/jq parser 与 UTF-16 Span、可组合 SourceMap；验证中文/emoji/CRLF、错误恢复、树释放及 YAML folded/转义映射原型。
- 以 `tests/cases/1/.github` 下的真实脚本与 GitHub Actions fixture 固定首版覆盖矩阵，记录输入/输出、预期诊断、依赖缺口及语法清单；GitLab 和 LSP fixture 后续加入。

验收：解析不崩溃、范围准确；明确区分非法声明/语法与暂不支持。选定 jq parser 路线；差分基准锁定本机 jq 1.8.2，其他版本单列兼容测试。core import 不触达 LSP、文件系统、网络或 child_process。

### P1：独立脚本最小闭环，同时建立 workspace

先打通 **头部 JSON 模板 → 赋值/printf/管道/命令替换 → 静态 jq → 已声明 stdout 检查／无返回接口 → CLI**，以[语义示例](type-system.md)为最小 fixture，再扩展到 case 1；不能以只通过最小子集代替首版覆盖目标。

随后补齐 case 1 的循环/函数/case/正则/参数展开/read/IFS/进程替换、jq reduce/动态索引/更新/条件/-e，以及 yq/外部命令模型、TSV/业务 YAML 来源和副作用摘要；逐项先建立否定与失败路径测试。循环与 reduce 先建立固定点/effect 方案，有限平台 key 展开封闭对象联合，超预算不伪造通过。workspace 此时就具备只读快照、`.github` 根发现、路径安全和依赖图；core 不承担临时磁盘扫描职责。

验收：只根据最近 `.github` 目录定位项目，无标记返回项目发现错误；不读取项目级配置。正例通过，裸文本/多值/类型不符失败；独立调用无返回脚本合法，消费其返回值失败；未知命令/不支持的调用不能通过。声明 stdout 时聚合检查所有成功路径；一次读取 stdin 后从捕获值提取多个参数，不能重复消费入口。CLI text/JSON 输出、排序、稳定 code 和退出码固定；CLI 不依赖 LSP。

### P2：GitHub Actions + case 1 CLI 闭环（首版 MVP）

- GitHub Actions Bash run、上下文优先级、step 隔离、YAML 完整位置映射、模板边界及常用 JSON 注入转换。
- case 1 的 `GITHUB_OUTPUT/GITHUB_ENV`、跨 step/job 数据流、toJSON/fromJSON/join、needs/if/result/skipped 条件依赖，以及本地 reusable workflow 输入、必需 secret 绑定和显式输出映射。无返回 CI 合法，但调用方不能消费不存在的 output。
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

开发测试只运行固定、受控 fixture，不执行用户脚本。以 `jq --version` 输出 `jq-1.8.2` 的本机版本为基准，执行设超时；对结果流使用多值解码，不假定一行一个 JSON；`-r` 单独断言原始字节。

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

现有有界差分测试以固定种子为 case 1 的 reduce 去重、数组投影、条件分支及目标唯一性四种 filter 各生成 32 份符合输入模板的 JSON 小值，对照本机 jq 1.8.2 检查单份输出落在静态推导类型内，并用错误 stdout 模板反例确认分析器不会一概放行。后续仍需扩大语法/失败路径样本并把失败缩减为独立 fixture；有限样本不代替证明，未完成分析的情况不能纳入通过统计。

## 4. 完成标准

工程入口：`pnpm install --frozen-lockfile`、`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm test:integration`、`pnpm build`、`pnpm test:package`、`pnpm audit:case1`、`pnpm bench:case1`。单测覆盖模型、映射、完整矩阵与失败/受阻传播；受控集成覆盖五个正例、support-portal、两个本地 caller run 及已审阅的 guard/filter/checksum/staging 切片。audit 保留真实 caller/callee 并检查缺依赖与依赖齐备两侧；benchmark 同样使用真实链。原 fixture 缺生产文件仍受阻，运行时切片不等于云端/Action 执行验收。

临时 tarball 已将四个运行时包与三项固定版本依赖在**空 pnpm store** 的独立目录离线安装、加载 WASM 并执行 check；检查依赖链接不回到源码仓库、各运行时包携带项目 MIT 许可证，以及 CLI 包内第三方许可证清单与实际安装的许可证原文一致。`pnpm pack:offline` 可将同一 bundle 持久写入 `release/offline-0.1.0/`，包含七个 tarball、SHA-256 清单和已通过安装冒烟的说明，拒绝覆盖已有目录。依赖 tarball 从已安装包的临时副本打包，去掉生命周期脚本；四个运行时包已作为 public `@pipe-ls/*@0.1.0` 发布，并通过无凭据、全新 pnpm store 的注册表安装及 CLI 冒烟。LSP 启停验证留到适配器实现后。初始性能目标为 100KB 文档暖分析 p95 < 200ms、100 个典型 unit 冷 CLI < 5s；记录机器/版本/fixture hash 和峰值内存，不能把简单样本当成全域保证。

首版 MVP 完成须同时满足：case 1 覆盖矩阵及支持范围内正例/反例/受阻例稳定；CLI 闭环可用；`.github` 根发现且不读取项目级配置；无返回接口语义正确；不完整检查不返回通过；分析时不执行用户代码、不访问远程资源、不泄露敏感数据；README 只描述真实已实现能力。现有负例已验证畸形 YAML、模板和 jq token 不进入 CLI 文字/JSON 诊断，YAML EOF 错误范围不越界；带本地写盘副作用的可执行脚本在 `checkPaths` 和 CLI 检查时也没有被执行。意外内部异常只返回通用错误，不回显异常消息。LSP/编辑闭环不是首版验收条件。

### 历史开发记录（旧阶段结果，不是当前状态）

一次受控性能抽样（Apple M1 / macOS arm64 / Node 22.23.1）：102,429 字节的单 Bash 文档（仅注释填充与一个 `jq -n`，SHA-256 `4f13640df681551623ea1587695583f635f370168422b57d2dbbe4110fbcae52`）预热 3 次后测 20 次，p95 为 22.54 ms，父进程峰值 RSS 约 274 MiB；100 个相同简单 unit（单文件 SHA-256 `0d9648f737d8deff52cc84d7afe3a8a190c88ff356ac90bedde44f814bbf06d6`）冷 CLI 为 381 ms，子进程峰值 RSS 约 99 MiB。仅是合成样本，不代表“100 个典型 unit”或真实 case 1 的性能验收；第二次分析曾出现约 300 ms 的一次性 JIT/初始化尖峰，需扩大样本并稳定预热方案。

再以 100 份 case 1 `parse-cloud-images.sh` 副本和一份共享 allowlist 测冷 CLI（同机、同 Node；脚本 SHA-256 `d01d1c52cc9a83656db3f08e2f9a2c857ae090a7ed3822661b30c72f38a54ba0`，4,238 字节）：100 unit 全部静态通过、零诊断，耗时约 2.05 s，峰值 RSS 约 253 MiB。该样本仅覆盖目标脚本的真实解析/语义路径，不能外推为所有项目的 5 s 保证。

可复现的混合抽样入口为 `pnpm bench:case1`：在临时项目生成 40 份 parse、40 份 update 和 20 份 `cloud.yaml`，共享合成 overlays、allowlist 与本地 JSON 解码 reusable workflow stub；绝不执行这些脚本或 workflow。生成清单 SHA-256 为 `bb3a107ee502dd847d1c6747cf44b87d25a8a51bd1d1e706591b689b977cf523`。Apple M1 / macOS arm64 / Node 22.23.1 上三次独立冷 CLI 用时 2.56、2.55、2.53 s，峰值 RSS 分别约 283、281、274 MB；每次实际检查 220 个内部 unit，零诊断、完整通过并汇总 60 个 may-write 路径。该样本满足初始 5 s 目标，但采用合成依赖，不代表真实第三方 action、云命令或所有项目的性能保证。

工程初始化阶段只验证工具链、基础模型及构建，不宣称产品测试已通过。

AWS EKS 切片后的验证：lint/typecheck、179 单测、9 集成测试、构建和空 store 离线打包冒烟通过；同一混合抽样清单三次冷 CLI 为 2.481、2.492、2.475 s，每次 220 unit、零诊断、60 个有限 may-write 路径，峰值 RSS 约 278、272、271 MB。以合成 overlays 和**真实**被调 workflow 审计完整 caller 链，检查 19 unit，缺版本文件时仍有 28 条诊断；仅在临时副本提供明确标记的合成版本文件后仍有 27 条（非真实下载 URL/校验值，不下载或执行）。EKS run 区间已无诊断；剩余根因是 runner/actions、华为工具和下载/安装/重试命令及其传播，不把数量减少或工程测试全绿当成首版完成。

静态 runner、action 名称及 retry 上下文切片后的验证：lint/typecheck、**191 单测、9 集成测试**、构建、空 store 离线安装/许可证/CLI/WASM 冒烟通过；新增真实执行禁止测试涵盖 retry 主命令、替换命令与 cleanup hook。25 场景矩阵为 5 正例、15 反例、5 受阻例，原先漏更新的反例计数断言已修正。同一混合抽样三次冷 CLI 为 2.486、2.476、2.489 s，每次 220 unit、零诊断、60 个有限 may-write 路径，峰值 RSS 约 271、273、271 MB；仍采用 stub，不算真实调用链验收。

重新构建后用合成 overlays 和**真实** callee（SHA-256 `491a48721f90cf809c3318010f2caee60885f44a98e04c38f8b03fbdfcc093e4`）检查两个平台的 caller 链：19 unit、60 个有限 may-write 路径、`fileEffectsUnknown: true`，缺版本文件为 27 条诊断；临时提供明确标记的合成版本文件为 26 条。静态 runner、真实 EKS 和 rollout 正文不再产生诊断；1Password/AWS/retry action 效果、华为下载/校验/安装/文件操作仍受阻。未知 action 屏障导致固定版本 env 事实无法保留，也未凭秘密输出引用为原生命令注入原始凭据变量。没有下载工具、执行 workflow、查询云端或修改远程资源；这些剩余模型仍是首版开发工作，而不是要求用户补生产资料。

原生 env 与 curl 切片后的验证：lint/typecheck、**199 单测、9 集成测试**、构建与空 store 离线安装/许可证/CLI/WASM 冒烟通过。只读核查固定 runner 源码后修正 step/global 优先级；测试覆盖 direct/callee 的原生 metadata、条件覆盖后旧 YAML 值不复活、显式 step 重建、JSON/raw 错误、BASH_ENV 启动代码隔离，以及 curl 参数、失败上下文、stdout 哨兵、未知辅助文件写入和不执行下载。真实 Huawei 下载正文在独立合成 pins 环境中只剩 `sha256sum` 未建模；只验证下载语句的切片可通过，这不代替完整 callee。

最新混合抽样为 2.517、2.531、2.523 s，220 unit、零诊断、60 个 may-write 路径，峰值 RSS 约 274、278、271 MB，仍使用相同清单和 stub。真实 caller/callee 审计（更新 curl 后 callee SHA-256 `3859747714e0eb758847938bcea9e1e803dac68e11c8d47341af911254b93ae4`）仍为 19 unit，缺 pins/合成 pins 分别 27/26 条诊断；curl 不再是无签名命令，但因真实上下文尚不能提供版本/URL/path 事实而受阻。下一步仍需 checksum、临时文件/安装/重试及 hcloud 的真实限定签名，再完成第三方 action 效果与完整调用链，不把上述工程全绿或独立切片当成首版完成。

Checksum 切片后的验证：lint/typecheck、**203 单测、10 集成测试**、构建与空 store 离线打包/许可证/CLI/WASM 冒烟通过。真实下载正文在合成 pins 下保留完整 curl + checksum 可静态通过，不再删除校验语句当正例；archive 增加保真 guard 防止多行记录注入。反例覆盖坏 digest 格式、CR/LF/NUL、stdin 哨兵、额外选项、吞失败、缺 pipefail、错误 guard 来源/OR、JSON wire 与 string payload 混淆、字符串变换和分支事实撤销。受控 checksum 运行时只校验合成字节；本机 Darwin 1.0 结果不作为 GNU 基准，源码依据见 action audit。

新增 `pnpm audit:case1`：完整使用真实 caller/callee（callee SHA-256 `c2c3333813c4506eae0f72e38aa6175892c5c01d1a70e0246ee04684cb046651`），临时生成合成 overlays，分别缺 pins/提供合成 pins，不替换动作、命令或 workflow；清单 SHA-256 `a6979ba4042684629533a7735d7e1204eb856024ffbc66a672354e2083f84183`。当前两次均检查 19 unit，汇总 60 个有限 may-write 路径和未知写入；诊断为 **26/25 条**，具备合成依赖时仍 `complete: false`，验收入口明确返回 1。剩余模型是第三方 action 与 pins/秘密数据流、临时文件/解压/安装、hcloud 输出及 retry 清理/中断效果；不是用户补生产资料的 blocker。没有下载工具或操作云端。

最新混合 benchmark 三次为 2.555、2.563、2.560 s，220 unit、零诊断、60 个有限 may-write 路径，峰值 RSS 约 271、272、271 MB；仍为采用 stub 的性能样本，不代替上述真实验收入口。

文件系统切片后，本轮修改前重跑真实 `pnpm audit:case1`：19 unit、61 个有限词法 may-write 路径、`fileEffectsUnknown: true`；缺 pins/合成 pins 分别 **19/18 条诊断**。callee SHA-256 `3523e816bdace8f33f8f6539777688280ebad1ee17ac8dce531056aadea85943`，audit 清单 SHA-256 `76d2577fd1f813387803a604849dd105b399d1ca95ef910513e83aa7bdc3ee85`。临时目录、tar、sudo install、mkdir/test/mv 和延期 cleanup 已不是未知命令；完整链仍受阻，不能以文件系统切片代替验收。

华为 CLI 切片后的验证：lint/typecheck、**215 单测、12 集成测试**、构建与空 store 离线安装/许可证/CLI/WASM 冒烟全部通过。只读核查官方 KooCLI 文档和固定 CCE SDK 定义后，新增 configure/version、ListClusters/v3 显式 JSON/hash 投影及 CreateKubernetesClusterCert/v3 的限定参数/效果模型；安全的 Bash `--key="$VAR"` 拼接现证明为单 argv。查询只接受同一正文中已检查的 warning/privacy 配置，环境改变、可能覆写配置的文件操作或条件分支缺失撤销证明；未知 ambient 配置和前序 action 成功不能建立事实。root jq type guard 的细化不借用 OR、常量或其他字段/变量的检查。

真实 retry 已移除 API 命令上不合法的 `--cli-warning`，显式固定 v3/region/project/JSON，查询前通过 configure 设置 warning/privacy；hash 投影保留每个集群，即使缺 UID，也不改变“恰好一个集群”的语义。真实安装与 retry 完整 Bash **正文**可独立静态通过，仍保留未知 cache/config/log/文件效果，不证明工具或 kubeconfig 内容。新增 jmespath（仅开发依赖）+ 本机 jq 的受控测试覆盖缺/null/空/坏 UID，以及两集群中一个缺 UID 的回归；安装、云命令和整个 workflow 未被执行。既有 staging/checksum 测试在执行前精确核对已审阅语句，fixture 改动则失败，不执行未知附加命令。7 个真实 run/retry 正文 `bash -n` 通过，仅为语法检查。

最新真实 caller/callee audit（callee SHA-256 `eb0c023dbd110b2c76a86f3eb1e1705f2a8634568dc3f8e32c737d391f9e7285`，清单 SHA-256 `6837efdd4f545d95933697766daf5ae117e8dd92dc53254dda3566ca109a4c76`）仍为 19 unit、61 个有限 may-write 路径和未知写入。缺 pins/合成 pins 分别 **16/15 条诊断**，`complete: false`，验收入口返回 1。retry 内部 CCE 命令不再产生诊断，但 retry Action 本身仍 `PIPE203`；安装 configure 仍因真实秘密事实未验证而受阻。剩余根因是四个第三方 Action 的效果/输出、条件 pins 与凭据数据流，以及由此传播到 caller 的两处未验证 callee。不是要求用户补生产资料，目标仍未完成。

相同混合 benchmark 清单（仍采用 stub）额外三次命令、每次三份独立冷 CLI 共九份样本为 2.726、2.720、2.675；2.726、2.733、2.758；2.755、2.742、2.727 s。均为 220 unit、零诊断、60 个有限 may-write 路径，峰值 RSS 约 272–279 MB；仍不代替真实 workflow 的完整性能/产品验收。

retry 限定 envelope 切片后，工程验证为 **221 单测、12 集成测试**、lint/typecheck、构建及空 store 离线安装/许可证/CLI/WASM 冒烟通过。maxAttempts/timeout/INPUT 默认与覆盖、同一 action-entry env、alternate 可达性和中断 may-effects 均有正反例，不传播确定 child env/output/仓库/startup 证明。该状态在本轮修改前复核：真实 caller/callee 审计缺 pins/合成 pins 为 **15/14 条诊断**，19 unit、61 个有限 may-write 路径、未知文件效果。callee SHA-256 `9bd62e44d990a8285fa5e8305888d9a9d1d672647dcb1ebd690c4917f4cd9544`，audit 清单 SHA-256 `245f5473330874f4db304e4fe672f46d6beb66e4f516066d962adba7a9d3918e`。前轮仍在运行的 benchmark handle 已轮询到 exit 0：三次为 2.639、2.604、2.648 s（相同 stub 清单），7 个真实 run/retry 正文 bash -n 通过；没有重复启动该 handle。

1Password 与不可变 metadata 切片后的验证：lint/typecheck、**231 单测、12 集成测试**、构建及空 store 离线 tarball 安装/许可证/CLI/WASM 冒烟全部通过。新增独立 Action unit，在 direct 和 reusable caller 路径建模 configure/load 的静态输入 envelope，保留 echo 任意 GENV 注入、继承 env、unset/PATH/安装及未知文件效果。秘密 outputs 仅为开放的 string-or-missing，上游 runner 源码证明直接 env 的缺失变空串、toJSON 的缺失为 null；不证明认证或必定生产，也不能作为必需 job output。真实 fixture 后续 Bash 显式清空 BASH_ENV，避免继承启动代码。AWS 名称上界补上源码实际生产的 authenticated-arn，但不因此放行 AWS Action。

同一个受限 sed-filtered name=value 来源现可写 GOUT；tool_versions 的 metadata 改为不可变 step outputs，在相同稳定 inputs 等值 guard 下显式注入下载/安装 env。保留原有条件、全部校验/命令及未知文件效果，不通过忽略 Action、重建未可信文件快照或硬编码 fixture 值恢复 pins。反例覆盖异/无/OR/status guard、错误 caller wire、输出/环境接口混用、特殊文件路径覆盖、无效记录、前置未知写入及 JavaScript prototype 字段误作生产者。

完整真实 caller/callee 审计（合成 overlays；缺 pins/合成 pins）现为 **10/3 条诊断**，23 unit、61 个有限 may-write 路径、`fileEffectsUnknown: true`；callee SHA-256 `d8683e23d5240548b715398c86d4ef7c66b47a9b79a6d0f01cb24ebe25f237c0`，audit 清单 SHA-256 `f874a48ff1b2ab8e50e8ddba11810960a5fa5d3a0cf928303490c9e68526210f`。缺文件仍准确 PIPE204，不要求生产配置。合成依赖齐备时剩余为 AWS credentials Action 的 PIPE203 与 caller 两处 PIPE202；验收入口仍返回 1、complete:false，目标未完成。AWS 默认 SDK credential chain、ambient 控制选项、空秘密/fallback、提前返回、可选 outputs 和 post cleanup 尚须覆盖/限定，不能直接将两个引用当成非空凭据。

最新相同 stub 清单 benchmark 三次为 **2.621、2.642、2.648 s**，220 unit、零诊断、60 个有限 may-write 路径，峰值 RSS 约 276–280 MB；7 个真实 run/retry 正文 bash -n 通过（仅语法，不执行）。完整真实链和正式性能/支持边界验收仍待 AWS 模型完成后收尾。未下载 op/hcloud、加载远端 dist、执行 action/workflow、读取秘密或操作云端；新增代码尚未发布，也没有重发 npm 0.1.0。

## 5. 首版验收记录

本次工作副本完成首版 CLI + Bash/GitHub Actions 的 P0/P1/P2 本地开发验收；不是生产部署或 npm 更新。以下证据对应原完成标准，缺生产资源、LSP/GitLab 与未来的任意 Bash/jq 支持不属于首版 blocker。

### 工程与完整链

- `pnpm install --frozen-lockfile --offline --ignore-scripts`：锁文件无需更新，本地安装通过，不下载/执行依赖脚本。
- `pnpm lint`、`pnpm typecheck`、`pnpm test`：**259 单测 / 15 文件**全部通过，无 lint 警告。
- `pnpm test:integration`：**14 项**通过；语法 gate 覆盖两个脚本、5 caller body 和 8 callee/retry body，仅 `bash --noprofile --norc -n`。受控执行不运行 Action、SDK、云命令、下载/安装或 git/gh。
- `pnpm test:package`：递归构建成功；七份 tarball 的 SHA-256、空 store 离线安装、无源码回链、CLI/WASM、版本、MIT 许可证及第三方许可证原文验证通过。
- `pnpm pack:offline <临时输出路径>`：正式命令生成七份校验通过的 tarball 与安装指南；再次指定同一目录明确拒绝且不改原文件，无遗留 staging。验证产物已清理，不覆盖已有 release。
- `pnpm audit:case1`：真实 caller/callee + 合成 overlays，缺 pins/合成 pins 分别 **9/0 条诊断、CLI exit 1/0**；均检查 27 unit、61 个有限 may-write 路径、`fileEffectsUnknown: true`。依赖齐备 `complete: true` 且未验证依赖为空；缺 pins 准确 `PIPE204`。源文件未被执行或补入生产数据。
- callee SHA-256：`88b2e9e5b9831d67b0ddca29da9bbbb7c60accc1447e7308f16fd099a9f24dee`；audit manifest SHA-256：`96dc7f79444c9a23361e03e4fd438ebc0174b347717e7f94c8ca91bbd7ac89e4`。入口输出全部五个真实 source hashes。

### 逐项完成证据

| 原要求 | 当前证据与边界 |
| --- | --- |
| P0 解析、UTF-16 原位置、JSON 模板、资源限制 | core span/template/jq-parser 与 hosts parsing-prototype/github tests：真实 fixture、中文/emoji/CRLF、literal/folded/quoted 映射、WASM 哈希、错误/alias/超预算拒绝。非精确映射不冒充可编辑位置；jq-reference 以 jq 1.8.2 验证固定与有界生成 filter |
| P1 独立脚本、stdout/stdin/env 与无返回接口 | core analyze tests：编码/基数/失败路径、共享 stdin 消费、日志污染、无 stdout 消费拒绝、有限循环/函数与命令模型；parse 静态通过，update 在合成 overlays 下通过，原缺文件仍 PIPE204 |
| `.github` 唯一判根、多项目、只读快照、依赖/失效 | workspace discovery/snapshot 与 CLI check tests：最近根、嵌套隔离、无标记失败、symlink/越界/1 MiB/发现预算拒绝、反向闭包/派生视图及多层调用/循环拒绝。CLI 每次新快照，无监听或跨进程缓存 |
| P2 env 优先级、隔离、outputs、跨 step/job、调用点与秘密绑定 | hosts github、CLI check/step-output/onepassword/aws-credentials tests：raw INPUT/ambient/step/global 优先级、BASH_ENV、输出存在性/条件/guard/status、toJSON/fromJSON、必需 secret 名称、错误 caller wire 和原 YAML 位置；完整真实链通过 |
| 25 场景全部验收，不依赖替代 workflow | case1-full 的共同输入模板真实调用图 + 全部 15 反例/5 受阻例（先证明无关依赖齐备再 mutation/remove/snippet）；集成逐一运行 5 正例的真实 parse/update，与独立固定的 target family/platform/image/version/deployments/restart_targets oracle 比较（不只与自身输出保持一致），另验 special-chars caller body。不是重复静态检查五遍或执行部署冒充运行时证明 |
| CLI 闭环、文本/JSON、稳定 code、排序与退出码 | CLI check tests 与 audit/package gate：通过 0、诊断/受阻 1、usage/discovery 2、无目标不能成功、多项目聚合、原位置、不完整不返回通过、打包后版本/入口可用 |
| 安全：不执行用户代码、不访问远程、不泄露敏感数据 | CLI sentinel tests：脚本、retry main/alternate/hook、AWS/startup 与本地写盘不执行；报告/两种 CLI 格式的 malformed YAML/contract/jq 哨兵不泄露。四个运行时包源码无网络或 child_process 执行入口；core WASM 由宿主提供 bytes。Action descriptors 不保存 literal credential bytes，secrets 只保留名称；未读取真实秘密或操作云端 |
| 真实命令/Action 与保守效果，不绕过验收 | 1Password/AWS/retry 限定模型有正反/unsupported cases；真实 AWS guard 对 blank secret fail closed。保留有限路径/外部命令族与未知文件效果；未知写入撤销后续快照/命名 env/output 事实，post cleanup 不制造提前执行保证。complete 不表示效果确定或云端成功 |
| 构建、许可证、离线交付与真实性能 | build/test:package 与下列真实链 bench，非 stub。四个包 MIT/public；本轮改动尚未发布，不可重发 npm 0.1.0。README/矩阵/type-system/action audit 已同步；P3/P4 为后续 |

### 真实链性能

`pnpm bench:case1` 保留 **40 parse + 40 update + 20 真实 caller** 的 100 入口，共享真实 callee/allowlist 与合成 overlays/pins；不缩小样本、不替换步骤。Apple M1 / macOS arm64 / Node **22.23.1**：三次独立冷 CLI 为 **2.861、2.877、2.877 s**，每次 **620 内部 unit、零诊断、complete:true、61 路径、未知文件效果**，峰值 RSS **278,380,544 / 284,868,608 / 279,330,816 bytes**。均满足初始 `< 5 s` 目标。

暖文档使用真实 parse 脚本加注释填充到 **102,400 bytes**，不是换成一个简单 jq；同进程预热 5 次、测量 20 次，每次重新建立只读快照并完整检查，**p95 39.93 ms**，父进程峰值 RSS **273,448,960 bytes**，满足 `< 200 ms`。文档 SHA-256 `ea2c77b9b0ccc5c299936806d841de71221cb90fd95d82d09571fcb037a81a39`；bench manifest SHA-256 `d674ed9bb2a31ce05444858a75c5236a0c7252bc2936e73ad15db6f3bc65f030`。

bench 对不完整报告、缺实际 Action/云命令族、缺 RSS 或超目标返回非零；记录机器、Node、source hashes、计数及每次结果。这证明该受控真实链样本满足初始目标，不外推为所有 100 KiB 文档、所有项目或真实云端执行的保证。

文档定稿后的同清单复测也通过：冷 CLI **2.814、3.121、3.183 s**，620 unit/零诊断/61 路径不变，峰值 RSS **285,114,368 / 292,356,096 / 287,850,496 bytes**；暖 p95 **42.49 ms**，父进程峰值 RSS **273,498,112 bytes**。未同时运行其他开发测试来制造或遮掩性能结果。
