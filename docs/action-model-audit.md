# GitHub action 模型审计：case 1

本记录用于开发内置静态签名，不是执行 action、访问秘密或部署的验收。CLI 检查时不下载第三方源码。下列公开源码由开发阶段只读核查；`v2/v3/v4` 是可变标签，快照哈希仅记录核查内容，不证明未来的远端代码或打包 `dist` 与源码一致。

## 输出名称与成功状态必须分开

- `1password/load-secrets-action/configure@v2` 没有命名 outputs。其 `configure/entrypoint.sh` 通过普通 `echo` 向 `GITHUB_ENV` 写入 token；没有证明输入不含 CR/LF 时，不能把它概括成仅覆盖三个固定名字的安全 env 写入。当前仍保留未知环境/仓库效果屏障。
- `1password/load-secrets-action@v2` 的 `export-env` 默认 true。`src/utils.ts` 中 true 分支调用 `exportVariable`，false 分支才调用 `setOutput`，因此 true 模式消费秘密 outputs 是确定的接口错误。
- false 模式仍不能凭 step 的 `env` 关闭输出名称集合：`op env ls` 扫描继承环境；空引用或空秘密在 `extractSecret` 中直接返回，不保证每个名字都产生 output。动态选项保持受阻，不从声明推断输出存在、编码或秘密字节。
- 安装路径也不是纯环境动作：`install_cli.sh` 会下载最新 CLI，并可能在当前工作目录写入 `op.zip`、`op.pkg`、`temp-pkg`。不能凭 action 名称恢复原仓库快照证明。
- `aws-actions/configure-aws-credentials@v4` 的 manifest 输出为 `aws-account-id`、`aws-access-key-id`、`aws-secret-access-key`、`aws-session-token`、`aws-expiration`，`helpers.exportAccountId` 还实际调用 `setOutput('authenticated-arn', ...)`。名称检查上界包含这个源码输出，但不保证存在；限定 IAM 模式另按实际源码收窄可缺失的输出集合。`translateEnvVariables` 会从 ambient env 回填部分控制选项，不能只根据 `with` 认定实际行为。

AWS、1Password 和 retry 现有下述限定 envelope；未知输入/认证路径仍 `PIPE203`，env 与仓库效果保持保守。任何名称检查均不会制造确定的秘密输出。

### AWS IAM 凭据 envelope、SDK 与 post cleanup

- 仅接受显式 IAM AK/SK，literal 只记录来源 span 与 trim 后非空布尔值，绝不在 descriptor 保存凭据字节；step output 来源须有不可变的 nonblank 事实。直接 `secrets.NAME`、可缺失 1Password 输出及仅有 string 模板均不能证明非空。session token 的 step 来源另要求已验证生产者。未知字段、动态控制、role/role chaining、use-existing、提前返回、额外执行修饰仍受阻，不伪装成完整 AWS 认证支持。
- 固定 SDK 的 defaultProvider 对 truthy AWS_PROFILE 跳过 env provider。故 profile 必须**实际空字符串**，`' '` 仍受阻；显式非空 AK/SK 和无 profile 时优先走 env provider，不借用 runner 的 profile/process/web-identity/metadata fallback。HTTP_PROXY/HTTPS_PROXY 也需明确为空，模型不支持代理配置。
- runner 先补齐/覆盖 INPUT，再由 action 的 translateEnvVariables 在 raw INPUT 为 falsy 时从 ambient 回填；随后 `getInput` 才 JS trim。`role-to-assume: ' '` 因 raw truthy 阻止回填，再 trim 成空，可固定禁用；`role-to-assume: ''` 仍允许 ROLE_TO_ASSUME 回填，需要证明后者为空。role-chaining/use-existing 的 pinned false 覆盖 ambient；省略时需已验证的禁用事实。输出凭据 activation 同样考虑 ambient OUTPUT_CREDENTIALS，不凭 manifest 默认值忽略回填。
- 当前模式允许默认/规范 `output-env-credentials: true`，不接受不同大小写或关闭环境输出。main 只汇总 `github aws credentials`、`aws sts GetCallerIdentity`，job-end post 只汇总 `github aws credentials cleanup`；cleanup 的源码比较大小写敏感。保留未知 SDK/文件/环境/startup/仓库效果，不证明账户、认证、命名 AWS env 的具体值或提前清除凭据。
- 输出按 IAM 分支限定名称且全部可缺失：account-id/authenticated-arn；output-credentials 可能激活时另有 access-key/secret-key/session-token。此分支不生产 expiration，不允许将仅在名称上界中的字段当作已验证来源。直接 env 渲染为原生 string（缺失为空串），`toJSON` 仍为 `string | null`，不能作为必需 job output。
- 真实 workflow 在相同 AWS guard 下新增 validator：两个 nullable JSON secret 经 checked `jq -er` 检查为 string、含 `[!-~]`、无 CR/LF/NUL，**两者都成功后**才写 GOUT。这是防止 blank secrets 走默认凭据来源的实际修复，不是忽略 Action。模型只支持此 ASCII graphic test，不支持一般 regex；不从 OR、其他变量/字段、变换或单侧分支借用 nonblank 事实。受控测试严格核对已审阅的完整 body，再用合成值运行本地 Bash/jq/printf；不执行 Action/SDK/AWS。

### 1Password 的限定 envelope 与可缺失输出

- 用独立 Action unit 按 job/step 顺序建模，不生成伪 Bash 正文。configure 只接收三个已核查输入的静态标量或单个 `secrets.NAME` 引用，不保留其 token 值；load 接受静态 `export-env`/`unset-previous`，按 `getBooleanInput` 的 true/false 大小写形式和 manifest 默认值解释。runner 输入覆盖同名 ambient `INPUT_*`，不能从 env 偷改这些选项。未知输入、动态选项、run/uses 混合及 continue-on-error/timeout 等执行修饰仍受阻。
- configure 的 echo 注入、load 的继承 env 扫描/unset、PATH 修改和可能安装文件均保留为未知环境与文件效果。CLI 汇总 `github onepassword configure`/`github onepassword load-secrets`，撤销后续 global env、startup 和仓库证明；不验证认证、安装版本、下载内容或远端秘密。
- configure 使用 Bash，load 可能运行 Bash installer，均检查入口 `BASH_ENV`。后续显式空 step `BASH_ENV` 可重建启动事实，不能以全局默认空值覆盖被撤销的事实。真实 fixture 已显式绑定，不运行任何 startup 文件。
- load 的 false 模式给出**开放且可缺失**的原生输出上界，不凭显式 step env 关闭名称集合。直接 env 渲染时，runner 的缺失/null 值转为空字符串，因此只能证明原生 string wire，不能证明非空、来自某个引用或已 JSON 编码。`toJSON(steps.load.outputs.NAME)` 的类型为 `string | null`；只声明 string 会被拒绝，不能以输出名存在推断秘密必然生产。true 模式仍不允许秘密 outputs 消费。
- 可缺失输出不作为必需 job output 的已验证生产者。direct 和 reusable caller 两条路径使用同一模型；源码位置保留，诊断/效果/报告不含秘密字节。

### 固定 metadata 文件与不可变 step outputs

固定 `sed -E '/^[[:space:]]*(#|$)/d' <本地静态路径> >> "$GITHUB_OUTPUT"` 现与 GENV 共用有界只读来源模型：只接受 name=value 单行记录，拒绝 CR/NUL、heredoc/无效记录、修改 filter、输出文件路径覆盖及前置未知写入。重复名称以最后记录为准；GITHUB_/RUNNER_/NODE_OPTIONS 的禁止规则仅应用于 GENV，不误套到 output 名称。不会执行 sed 或 source 文件。

已验证 step outputs 是 runner 收集的不可变事实，不被后续 Action/文件屏障误当成可变全局 env。保留其 wire 类型、有限字节和单行事实；条件 producer 仅在 consumer 使用**完全相同的稳定 inputs 等值 guard**时可用，支持 `inputs.NAME` 或 `fromJSON(inputs.NAME)` 与固定字符串比较。不猜测一般逻辑蕴含，异 guard、无 guard、OR/status 函数均不能恢复存在性；条件输出仍不能直接冒充必需 job output。

真实 tool_versions step 改写 GOUT 并显式绑定到下载/安装 env，保留原有华为条件和所有命令，而非重新 source 可被修改的文件或跨 Action 沿用 GENV。缺文件仍 PIPE204；验证只用明确标记的合成值，不证明真实版本、URL 或 artifact。

## retry 内嵌命令的上下文与执行边界

- `nick-fields/retry@v3` 的 `command` 和 `new_command_on_retry` 经 `spawn(..., {shell: executable})` 执行；只有显式 `with.shell: bash` 才提取为 Bash。子进程继承所在 step 的环境；`defaults.run.shell/working-directory` 不配置这个 Node action。替换命令只可能在后续尝试中运行，不因此声明 action step 本身是条件 step。
- CLI 按 job/step 顺序检查两个正文的 YAML env、`if` 和 reusable workflow 实际输入 wire，并保持 YAML 位置映射。只有 opaque 正文的被调 workflow 也会进入检查；不能因没有普通 `run` 就跳过调用点的编码错误。
- `on_retry_command` 使用 `execSync` 的 OS 默认 shell，而不是 `with.shell`；非空 hook 明确报告未知 shell，不假装以 Bash 完整检查。动态 shell/正文表达式仍受阻。
- 正文中的已建模命令只提供 may-run/文件可能写入摘要。现有静态 bounded envelope 要求明确 Bash、非空静态 command、正整数 max_attempts（缺省 3），且只提供一个正整数 timeout_minutes/timeout_seconds；可接受已核实的等待、polling、retry_on、exit-code 和布尔控制参数。所有数值须为可安全表示的规范十进制；不把 parseInt 的宽松前缀解析当成支持范围。未知字段、动态输入、额外 shell 选项、非空 hook、top-level continue-on-error/timeout 等仍 `PIPE203`。
- main/alternate 正文都必须在真实入口 env/caller wire 下通过检查。main 至少可能运行一次；max_attempts 为 1 时 alternate 不可达，不假装会调用它。模型以两个正文的 may-effects 并集摘要重复/失败/中断，不证明尝试数、顺序、清理完成、文件内容或云端操作成功。不传播正文的 `GITHUB_ENV/GITHUB_OUTPUT` 确定写入或仓库证明，不用 action success 修复 partial write。
- Node action 各次 spawn 继承同一个 action-entry process.env，子进程写 GITHUB_ENV 不会更新父进程继承环境。因此 main/alternate 使用同一入口事实快照，而不是错误地用前一尝试可能写入的值。仓库内容仍不作为每次尝试的稳定快照，retry 中的本地文件/脚本依赖保持受阻；后续 run 的环境、Bash startup 和文件事实撤销，显式空 step BASH_ENV 可以重新建立启动上下文。
- runner 为 action manifest 的每个 input 补齐默认值或空值，并在 step env 之后注入 `INPUT_*`；这些值会覆盖同名 YAML/global env。模型保留输入的实际环境字节，只有 option 读取按 getInput 规则 trim。缺省的 max_attempts、等待/polling、boolean 和可选空 inputs 都进入事实，不让继承 INPUT_* 改变 action 控制流。spawn 不注入业务 stdin，因此正文声明 stdin 时报告 `PIPE104`。
- 父进程将子进程 stdout **和 stderr** 都写入自己的 stdout。它的 exit 回调只在 `code > 0` 时记失败，某些 signal 退出的 `code === null` 不证明正文执行完毕；因此不能从 action 的成功状态证明正文命名输出存在，也不能把 action 日志当业务 JSON 返回。
- 公开输出名称上界是 `total_attempts`、`exit_code`、`exit_error`，没有 `stdout`；名称检查不证明值、存在性、编码或成功。

限定 envelope 本身没有泛化 `uses` 障碍，但 child 的 `executionUnverified` 标记保留，表示不能从父成功推出完整执行/确定效果；同样不产生这些 action outputs 的已验证生产者。CLI 汇总 `github retry bash` 和未知文件写入（wrapper 的 runner output 文件与中断后未解析效果），正文不完整仍报告错误/受阻。真实 CCE retry 和其后 rollout 已显式绑定 `BASH_ENV: ''`；没有实际执行 action 或其正文。

## runner 与 Bash 上下文

静态 `runs-on` 字符串/标签数组用于选择 runner，不是 OS、工具版本、凭据或远端可用性的证明。显式 step/job/workflow `shell: bash` 可以建立 Bash 解析上下文；没有明确 shell 时仍受阻。动态、空、复杂及超预算的 selector 仍受阻；不根据 `aliyun-ack` 等标签猜测 Linux 或集群配置。

### 原生环境事实与 step 优先级

`actions/runner@v2.327.1` 的 `FileCommandManager.cs` 将 `GITHUB_ENV` 写入全局环境；`StepsRunner.cs` 每个 step 先合并全局环境，再覆盖显式 step env。因此现在保留 step env 名称来源：它可覆盖前序全局事实；前序已验证写入可覆盖 workflow/job 的旧默认值。条件写入或未知效果之后，不把继承的 YAML 默认值重新当成确定值；显式 step 重新绑定仍可建立独立事实。

CLI 只把已验证 YAML 字节、caller wire 或 `GITHUB_ENV` 事实交给纯内存 Bash 分析，不读取代理的 `process.env` 或真实秘密。原生 metadata 可作为原始字符串传给工具或显式编码，不自动变成业务 JSON；显式 JSON env 契约仍单独验证。额外的已知事实若与声明相矛盾，core 报错，不用声明覆盖反例。

`BASH_ENV` 是 Bash 启动代码入口而非普通数据：非空/未知绑定或条件写入导致启动上下文受阻；不会读取或执行这个文件。已证明的显式空 step 绑定可解除这一已知启动风险。未知 action 整体仍受阻，不据此证明任意 ambient 启动行为。

## 公开核查来源与 SHA-256

前缀分别为：

- `https://raw.githubusercontent.com/1Password/load-secrets-action/v2/`
- `https://raw.githubusercontent.com/aws-actions/configure-aws-credentials/v4/`
- `https://raw.githubusercontent.com/nick-fields/retry/v3/`
- `https://raw.githubusercontent.com/actions/runner/v2.327.1/src/Runner.Worker/`

| 仓库 | 文件 | SHA-256 |
| --- | --- | --- |
| 1Password | `action.yml` | `be718835c38216a3be41772d3c5c8c190712b279684789d727a3518b0301895f` |
| 1Password | `configure/action.yml` | `c6234901dd2d7aec74f665e1d2425b3a11f48bc7dcae1888fd9404b8ea7ea906` |
| 1Password | `configure/entrypoint.sh` | `08379785cd5690b1a47320416b36000ae826abfe3300845bbb0e9d93f07b395a` |
| 1Password | `src/index.ts` | `dac684233d17a57f47fb57bbff38b402b39edd60eb5c43352b8ebdf66ab257bd` |
| 1Password | `src/utils.ts` | `b859bd6d2c2492fc197e3ebceb3044f0010ed65dc9fb96ae436c98198ff5f786` |
| 1Password | `install_cli.sh` | `d33f47baeb40be367511e5904ce77a85d2d2f9440e48bc6b82f3679cf6407744` |
| AWS | `action.yml` | `677df096ab426d9d63eb16c8237c076838cfb97c8b1fed315b439061ed3bc209` |
| AWS | `src/index.ts` | `427f9abb5ebec4d940aaec74bfd496e47af7b2df8604231ff8015e0a567f7081` |
| AWS | `src/helpers.ts` | `b62d9f9b4f4a33b0207b55db894ba97a48b0e44f86da4984930d3fe69ee7df72` |
| retry | `action.yml` | `a997c22d096daf3bfcb14f903376e7b11299f50827591b3a49731fc88044b17e` |
| retry | `src/index.ts` | `b332b56dafac66247cdee040d13f7f7e057b7850bdda2fa1210393bc65b3912f` |
| retry | `src/inputs.ts` | `5c854561a71551a6d2e192c4d7330359d784a4271eac1577338aa5050a85bf46` |
| retry | `src/util.ts` | `86fbfaa79b77e565c8a4fed22c03aa22c3faa73dcc9dbb83a6df9ce6c12c1bce` |
| runner | `StepsRunner.cs` | `755fdecdb22242d3e8026aff844d993c56cb9b18eeb2cae0b16a142a88e2fb2a` |
| runner | `FileCommandManager.cs` | `1491619f5acc3e9007e3acf48600e8ff2e38a9b453553cac27c1238eab7f979a` |

本轮重新核查 retry 的固定 commit `ce71cc2ab81d554ebbe88c79ab5975992d79ba08`，上述四个 action/source 哈希未变；`package-lock.json` SHA-256 为 `d0d3e402a1bea8bb2910d2cd78727154479b820bad4fe26a015d5f312d85430b`，锁定 `@actions/core@1.10.1`。runner input 补齐/覆盖另核查 `actions/runner@v2.327.1`：`ActionRunner.cs` SHA-256 `d19a739d1d5acdecb05c177e4a65ca989c976e0c553341d8ade770ea67869b38`，`Handlers/Handler.cs` SHA-256 `0a24ecc684bc2d3bc418b4c997c1e31bf7b96da97b6f66dc70fd16ea1e9232c7`，`ActionManifestManager.cs` SHA-256 `1c4ed5386e44bf3df02490adc4287e7fa29efff5b03f41dc95d3aac15455fa9c`。只读公开源码，不加载 dist，不执行代码，也不声称可变 v3 标签将永远等于该快照。

本轮又核查 1Password 固定 commit `581a835fb51b8e7ec56b71cf2ffddd7e68bb25e0`，上述 action/configure/index/utils/installer 哈希未变；`src/constants.ts` 为 `b20f2eda4c9b6a448c65c57245191bcb85751f71ee5bf8ea62337cad9f564927`。runner `v2.327.1` 的 `StepsContext.cs`（`4dd21fff6036f74c1555d727c63042af16ebc5beda75b8bc15b9fb661d0e1ae2`）把输出存为 StringContextData；`Index.cs`（`e92c0cfe4e68c8b1dd1bc581fac2c741abf0fc16309467cc10ea5ffc3cdcb6f1`）缺 key 返回 null；`ToJson.cs`（`f39ed6d413b6dc1c763cc44d5464dc9cbf48457626bd8aceb0eabc070d66b8aa`）保留 null，而 `EvaluationResult.cs`（`841d542dbdb3b5cebfebbf85679db0add37ba8d2c613629a8b66649daa8d3d6c`）及 `TemplateToken.cs`（`51ce17da69005b2d05a25ba025b204deae48c9e79677ee03d7155c6cb9b2c544`）在 string/env 渲染时将 null 转为空串。上述路径位于 runner `src/Sdk/DTExpressions2/Expressions2/`（Index/ToJson 在 `Sdk/Operators`/`Sdk/Functions`）和 `src/Sdk/DTObjectTemplating/ObjectTemplating/Tokens/`，没有执行 runner。

AWS 固定 commit `7474bc4690e29a8392af63c5b98e7449536d5c3a` 的 action/index/helpers 哈希与既有记录一致；`src/CredentialsClient.ts` 为 `d20129d3f6a19187a9fd6c6efb2dcaad9c9635f08a81ae30c8ff6505b2273907`，`src/assumeRole.ts` 为 `2d3a525deff7283a9ff17cb5cff8f001782ffea923df48a09d8fe0a3375c44db`。新增只读核查 `src/cleanup/index.ts` 为 `709f010dc50f28f88cb7e49d65d41ea5f2eed7c8e254149bb6ff243388f7f94e`，`package-lock.json` 为 `709b6127c5738fd9f4c72bb412a63693ae53061574c371e1f71da2ab30ef2c2a`，锁定 `@actions/core@1.11.1`、STS/node provider `3.859.0`、env provider `3.858.0`。上面的 IAM 模型已限定空秘密/default chain 与 ambient 控制，不凭两个引用认定认证成功。

只读固定包版本 JS（未加载或执行）：`https://unpkg.com/@aws-sdk/credential-provider-node@3.859.0/dist-es/defaultProvider.js` SHA-256 `87edf6938016aaa81dcb6b61b0e4afdb90a0e72f896eb9aa678074a86af5fe8c`；`https://unpkg.com/@aws-sdk/credential-provider-env@3.858.0/dist-es/fromEnv.js` SHA-256 `6d11414b469a5fa751fa647945a46af72caa464087390c532d5d46219a273c2e`。真实 caller/callee 在合成 overlays/pins 下已静态通过，但输出不证明实际账户、工具版本/内容或云端效果。

## Checksum 记录与 jq string payload

只读核查 `coreutils/coreutils@v9.8/src/digest.c`（SHA-256 `a3b9bf65ade97a8b2eb0e1d0d072c3fd23de337d565a10c50dd1d0b0cbbeb382`）：`split_3` 只有在记录的 digest 前出现反斜杠时才解释文件名转义；普通记录的文件名字节（包括首尾空格、字面反斜杠）保留。`digest_file` 把恰好 `-` 当 stdin。默认 checker 不保证畸形行导致整体失败，故不能放行未知或可注入多行的记录。参考源码：`https://raw.githubusercontent.com/coreutils/coreutils/v9.8/src/digest.c`。没有下载/安装或执行 GNU 工具。

内置签名只支持普通 `printf '%s  %s\n' | sha256sum --check -` 成功路径（或同形态的有限字节），digest 必须是 64 位 hex，文件名非空、非 `-`、无 CR/LF/NUL。`errexit/pipefail` 必须证明；不消费工具日志、不支持忽略错误/缺文件选项，也不读取待校验文件或声称它与 digest 匹配。

真实 archive 使用 jq 的直接 `index` 排除 guard 保留 Unicode、空格、反斜杠。分析区分 JSON wire `singleLine` 与解码后的 string payload；`--arg` 传入原生字节，identity/select 管道保留 payload 事实，字符串变换/未受保护分支不继承。不从对其他变量、子字段、常量或带 OR 的 predicate 中伪造当前输入保证，缺少 `-e` 或失败被 `export` 掩盖时仍受阻。

受控集成测试只执行真实 archive guard 和 checksum 片段，待校验字节与 digest 均在临时目录合成。当前本机为 `/sbin/sha256sum (Darwin) 1.0`，匹配/不匹配和特殊路径结果只作为兼容性证据，不冒充 GNU 差分基准。curl/安装/hcloud/workflow 从未被执行。

## 有限文件系统签名与延期 cleanup

采用标准工具的有限参数契约，不从 runner 标签推断 OS/工具可用性：mktemp 的显式六 X 模板和成功路径、mkdir `-p`、install 固定 mode、mv/rm 的非交互形态、test `-s`。所有路径参数显式用 `--`；tar 的 `--file` 非 `-`，目录来自已检查 mktemp，并显式导出空 `TAR_OPTIONS`，防止环境中的额外参数/程序执行选项改变命令。固定 sudo 形态为 `sudo -n -- install`，没有交互提示或任意 privileged command 签名。参考规范：[coreutils](https://www.gnu.org/software/coreutils/manual/html_node/)、[TAR_OPTIONS](https://www.gnu.org/software/tar/manual/html_node/TAR_005fOPTIONS.html)、[sudo](https://www.sudo.ws/docs/man/sudo.man/)、[Bash trap](https://www.gnu.org/software/bash/manual/html_node/Bourne-Shell-Builtins.html)。CLI 检查时不访问这些网址。

mktemp 标记只记录受检查的路径来源，不是当前 inode/内容证明；纯字节变换不能伪造此标记。固定 EXIT trap 的路径不允许后续赋值/read/for 替换，rm 遮蔽受阻；注册时只累计可能清理，不推导必定执行或无残留。原生路径的 symlink/目录目标、归档成员、sudo 日志/PAM 等辅助写入未解析，故始终保留 `filesMayWriteUnknown`。普通 stdout 文件重定向在执行命令前可能已创建/截断文件，即使正文未知或失败也汇总这一效果；不会为该文件制造数据类型或内容证明。写入可影响未消费的入口文件，已捕获 JSON 值则仍是独立内存事实。

运行时只提取 retry 的本地 staging/cleanup 片段并写入合成字节。当前 macOS 工具结果仅算兼容性检查；tar/install/sudo/hcloud 和整份 workflow 未执行。独立安装及完整真实调用链在合成 metadata 下可静态通过；这不验证安装内容、真实凭据/pins 或云端效果。

## 华为 KooCLI 与 CCE 的限定模型

仅只读核查官方文档和公开 SDK；未获取 CLI 二进制、运行 hcloud、读本地认证配置或访问云端。命令名的内置签名是工具契约前提，不是 runner 上实际安装版本、身份/权限、集群内容或云操作成功的证明。

- `configure set` 仅接受固定的 `--key=value` 参数族，要求显式 `--cli-warning=false --cli-agree-privacy-statement=true`，AK/SK 同时存在或同时省略。`--key="$VAR"` 通过 Bash AST 证明是一个 argv；不接受未引用展开、glob、未知变量或嵌套执行。敏感值不进入诊断/效果摘要。该命令及 `version` 的日志不是 JSON 返回；捕获/管道消费仍受阻。
- 官方系统参数表明确 `cli-warning` 和 `cli-agree-privacy-statement` **只能配置后使用**，不能直接传给 API。真实 retry 已移除证书调用上的 `--cli-warning`，改在查询前单独设置全局 warning/privacy。查询 JSON 证明只来自同一正文中受检查成功的 configure，绑定当前 exported 环境；分支缺失、环境改变或其他可能覆盖配置的文件写入撤销证明。未知 ambient 文件、前一步安装或 action 成功不会建立这个证明。
- CCE 操作固定 `/v3`、显式 region、`project_id` 和 JSON 输出。`ListClusters` 的完整响应有额外字段，`items`、metadata 和 UID 可缺失/null，不能以 consumer 模板反推完整 API 是封闭对象。限定 JMESPath 为 `{items: items[*].{uid: metadata.uid}}`，仅这个显式投影的类型为 `{"items": [{"uid": string | null}] | null}`。
- KooCLI 对失败/空的部分查询会回退原 JSON；因此不能随意声称未知 query 返回封闭结构。采用非 null 的顶层多选 hash，按已核实对象响应执行固定投影。每个集群保留一个 hash，缺 UID 是 null 而不是被投影省略；再用 jq 检查恰好一个 item 和非空 string UID。不使用可能把两个集群变成一个 UID 的 `items[*].metadata.uid`。
- `CreateKubernetesClusterCert` 仅摘要可能调用和文件效果，证书 stdout 仍为不透明字节，不能消费为已建模 JSON 接口；不证明 kubeconfig 有效。duration 支持文档范围 `1..1827` 或 `-1`；实际五年上限取决于闰年，未推断运行日期或云端接受性。
- 配置、metadata/cache、日志可能写盘，所有 hcloud 家族保留未知文件效果；查询/证书/版本操作本身不修改已建立的 warning/privacy 设置，但后续仓库、命名 env/output 和未捕获 stdin 不能凭未知写入保持原证明。失败检查和管道 `pipefail` 与 AWS 切片采用相同边界。

受控运行时仅使用开发依赖 `jmespath@0.16.0` 和本机 jq，验证真实 projection/filter 对合成响应的行为；包含零/单/多集群、缺 metadata、null/空/错误类型 UID，以及两集群中一个缺 UID 的反例。执行前核对已审阅形态；不执行任何 hcloud 语句。独立完整安装和 retry **正文**静态通过不等于真实 Actions/caller 链通过。

### 核查内容的 SHA-256

官方文档链接可变，以下只记录实际核查字节，不声称验证了 CLI 实现或所有版本。SDK 固定 commit 为 `43f215aad01feb8c06e9eb2920c2b24e0727fdb5`，文件前缀为 `https://github.com/huaweicloud/huaweicloud-sdk-go-v3/blob/43f215aad01feb8c06e9eb2920c2b24e0727fdb5/services/cce/v3/model/`。

| 来源 | SHA-256 |
| --- | --- |
| [configure set](https://support.huaweicloud.com/usermanual-hcli/hcli_03_003_01.md) | `7541a84a79a53df08fe710734105639792813749029f188dbf1de85a32b6021a` |
| [系统参数使用方式](https://support.huaweicloud.com/hcli_faq/hcli_19_001.md) | `59f50513dde2496a979cb10c3fd92f3284ffa148d3174552fa985bb087120063` |
| [查询当前版本](https://support.huaweicloud.com/usermanual-hcli/hcli_04_004.md) | `c720d42e874535c19afc1b2a2ff640204e48336990304a183bab6abc77a7ac92` |
| [指定 API 版本](https://support.huaweicloud.com/hcli_faq/hcli_17_002.md) | `43ae6f10005f1470f0ed87af8d64e47c13f2a70952e08be78e6190325e448ec6` |
| [JSON 输出与 query](https://support.huaweicloud.com/usermanual-hcli/hcli_05_11.md) | `6fba29a4bbaf939512134d9ff454128e6619d93ef5463d97c682bcfcf6e4ef90` |
| [JMESPath、null 省略及回退](https://support.huaweicloud.com/hcli_faq/hcli_23_002_01.md) | `5a5f3ebc705f82e0ab57d0f030242c5a2c33558b35217f62bb786c04783a61e0` |
| SDK `model_list_clusters_response.go` | `93e6db1e2e2c403ca74d6d9f848f7c6e7d37865200239db309eafc2d76f949c7` |
| SDK `model_cluster.go` | `84dc8b15aef6e082dcc272412b9ad1ff0a70d0afd1715f4f9cc8ffa5f2113d4f` |
| SDK `model_cluster_metadata.go` | `8ae33a94d464c554b5d35dd66ee222e38112d4df5403780081c859d3db18d7af` |
| SDK `model_create_kubernetes_cluster_cert_response.go` | `adbcf41b1af2e25fe935ee02012b9ba990158cea9783b9fbf60f065387d136f9` |
| SDK `model_create_kubernetes_cluster_cert_request.go` | `34bec507f6a508f2fa612f48f64e366571cb8753dc3cd0885af8c703c2542afd` |
| SDK `model_cluster_cert_duration.go` | `3ea579125cb2b565d7efbced41d9b78468f89577d2a3bd526007912a91dd221d` |
