# Case 1：Cloud 镜像更新

这是首版 CLI 分析范围的真实风格 fixture。[25 个场景矩阵](matrix.json)已有完整静态与受控运行时验收：5 正例的 parse/update 输入在临时副本运行；15 反例、5 受阻例在无关依赖齐备的真实 caller/callee 下断言诊断。真实 `cloud.yaml` → `do-rollout-restart.yaml` 在合成 overlays/pins 下零诊断、`complete: true`，检查 27 unit，汇总 61 个有限 may-write 路径及未知文件效果，没有 workflow/Action stub。原 fixture 缺生产依赖仍受阻，静态通过不证明认证、实际工具/归档内容或部署成功。正式回归和性能记录见[实施计划](../../../docs/implementation-plan.md#5-首版验收记录)。

## 项目与接口

- 项目根为本目录，以 `.github/` 为唯一根标记；不是 pipe-ls 仓库根，也不是 `.github` 自身。不读取项目级分析配置。
- `parse-cloud-images.sh`：stdin 为一个 JSON string，内容仍为逗号分隔的镜像引用；stdout 为解析结果对象。无位置业务参数。
- `update-cloud-images.sh`：stdin 为 `{"environment": string, "parsed_images": <解析结果对象>}`；一次消费 stdin 后分别解析字段。`parsed_images` 是嵌套对象，不是重复编码的 JSON 文本。stdout 为更新结果对象。
- 两个脚本的完整单行模板在 shebang 后。镜像的 tag/digest 用两个完整对象的联合；restart_targets 用 `{}`、aws、huaweicloud、双平台四种完整对象的联合，保留现有返回形状，不引入 optional key 或开放对象。
- CI 平台文本经 `toJSON` 注入声明的 env；setup 通过 here-string 和 JSON 管道调用脚本。`GITHUB_ENV` 中的字符串用 `jq --arg` 编码，后续 step 先解码再传给原生工具。`restart_targets` 已是 JSON 对象，不再编码成字符串；`need_commit` 的 true/false 已是 JSON boolean。
- 所有 run 均无 stdout 业务返回值，因此不声明 stdout，也不为了占位输出 null。setup/commit 仍通过 `GITHUB_OUTPUT` 暴露命名 output，由 job 显式映射；这与 stdout 是两个接口。本 workflow 未声明 `workflow_call` 或 workflow outputs，不能作为可复用 CI 被调用方消费返回值。
- reusable workflow 的 platform/namespace/name 经 JSON 编码传入 `with`；被调方应按此协议解码。`GH_TOKEN_JSON/GH_REPO_JSON` 在 run 内解码成 gh 原生环境变量，不能输出 token 或把真实凭据用于测试。
- 被调 workflow 声明的必需 secret 必须由调用 job 的 `secrets: inherit` 或同名显式绑定提供；静态报告只保留 secret 名称，不保存绑定值，也不验证远端凭据是否实际存在。

parse 输入示例（一份 JSON 文档）：

```json
"xxxxxxxxxxxx.dkr.ecr.us-west-2.amazonaws.com/cloud-admin-frontend:dev"
```

update 输入示例：

```json
{
  "environment": "staging",
  "parsed_images": {
    "target_family": "cloud",
    "platforms": ["aws"],
    "images": [{
      "platform": "aws",
      "registry": "xxxxxxxxxxxx.dkr.ecr.us-west-2.amazonaws.com",
      "repository": "xxxxxxxxxxxx.dkr.ecr.us-west-2.amazonaws.com/cloud-admin-frontend",
      "image_name": "cloud-admin-frontend",
      "deployment_names": ["cloud-admin", "cloud"],
      "tag": "dev"
    }]
  }
}
```

## 首版覆盖目标与当前边界

| 层 | 必须覆盖 |
| --- | --- |
| 接口 | 可省略 stdout；禁止消费不存在的返回接口；stdin 一次读取、多字段提取；对象联合、封闭字段、JSON 编解码与数量 |
| Bash | if/elif/case、for/while/read/IFS、数组、正则/glob、参数前后缀删除、算术、函数、&&/\|\|、退出状态、命令组、进程替换、重定向与多参数 printf |
| jq | -e/-r/-c/-n 组合、as、if、比较/逻辑运算、split/index/all/unique/error、reduce、对象/数组合并、动态索引和更新 |
| 文件/工具 | TSV allowlist 来源、有限路径/cwd、yq eval/eval-all/strenv/更新/del、dirname/pwd/date、git/gh 命令的输入输出与副作用摘要 |
| GitHub | defaults、env、toJSON/fromJSON/join、GITHUB_ENV/OUTPUT、跨 step/job、if/needs/result/skipped/cancelled、显式 outputs 与本地 uses 依赖 |

循环、动态 key 和副作用须有真实的保守分析，不能跳过正文或仅凭头部宣称通过。工具只读项目内快照，绝不执行此 workflow 的版本控制、PR 或部署操作。

## 预期与依赖缺口

- 新的 stdin/env 调用链应满足 JSON 接口约定；测试应覆盖 tag、digest、单/双平台、update-only 的空 restart_targets，及特殊字符经过 env 编解码的保真传输。
- 反例包括：旧位置参数调用、裸文本 stdin/env、将 parsed_images 重复编码成 string、缺字段、消费无 stdout 脚本或没有显式 output 的 CI、条件跳过导致 output 缺失。
- 当前未收录 `resources/**` overlays；CLI 对有限目标族/环境展开后的缺失目录报告 `PIPE204`。华为路径依赖的 `.github/tool-versions.env` 也尚缺失，均属于原 fixture 的预期受阻情形，不要求补齐真实生产值。合成依赖下真实被调 workflow 已通过静态验收，不能因此声称原 fixture 或真实部署通过。
- 对未建模的命令，CLI 仍独立诊断其参数中可直接识别的缺失 `$VAR`/`${VAR}`；不据此信任命令执行、输出或副作用，也不把带默认值的复杂参数展开误报为缺失变量。curl/hcloud 的已支持命令族按各自限定模型检查参数，不为未知调用提供兜底契约。
- 真实 rollout run 正文的 `kubectl rollout restart/status` 现有有限命令族模型：验证单个 argv 资源/namespace 及固定 timeout 的参数形态，要求已证实的 `set -e` 成功路径，并禁止把工具日志消费为 JSON 返回。仅报告可能运行的命令族，不证明动态资源名、集群上下文、部署成功或真实远端效果。
- 真实 AWS EKS run 正文已有有限静态模型。查询显式固定 AWS CLI v2 的 `--output json --query clusters --no-cli-pager --no-cli-auto-prompt`，不依赖账号的默认输出配置；投影结果为字符串数组或 null，不臆造集群名或唯一性。`jq` 的空数组/唯一目标检查仅保留成功路径，受检查的赋值和 `pipefail` 防止吞掉查询失败。`update-kubeconfig` 的未知写入目标通过 `fileEffectsUnknown` 汇总，后续本地快照读取受阻；模型不查询 AWS，也不写真实 kubeconfig。
- 真实被调 workflow 已声明输入并解码 JSON，但独立检查不能从调用方反推其 wire 一定已编码；调用点验证实际传入值。正式完整矩阵、audit 和 benchmark 均使用真实 workflow，旧的隔离切片不代替完整链验收。
- `aliyun-ack` 等静态 runner 标签不再单独阻断显式 Bash 的解析上下文，但不推断 OS/工具/凭据。25 场景中的 `secret-action-env-only-output-consumer` 验证把 1Password 切成 `export-env: true` 后，AWS validator 与华为 env 对秘密 outputs 的消费报 `PIPE104`；限定 Action 模型不信任真实认证、秘密值或文件内容。
- 显式 Bash 的 retry 主命令和 `new_command_on_retry` 按真实 step 的 env/if 与 caller 输入 wire 检查，并映射回 YAML；不会因为普通 `run` 为空就跳过正文。现有限定 envelope 检查静态 timeout/attempts 及控制参数，以 may-effects 并集包含重复、失败和中断；不会假设一定完成或清理。runner 注入的 `INPUT_*` 覆盖 env/defaults，两正文使用同一个 action-entry env；max_attempts 为 1 时替换正文不可达。`on_retry_command` 使用 OS 默认 shell，不由 `with.shell` 决定，非空 hook 仍受阻。三个公开 outputs 仍仅名称检查，不能消费日志或凭 signal/null 成功状态建立命名 env/output、stdin、仓库或 startup 证明。
- 华为下载正文的 curl 已固定配置/URL glob/HTTPS 协议和显式 URL/文件输出，避免依赖 `.curlrc` 或把 URL 当选项。archive 经保真的 jq guard 排除 CR/LF/NUL，再用固定格式向 `sha256sum --check -` 提供单条记录；受检查的管道失败不可被吞掉。tool_versions 现把受检 name=value 文件写入 GOUT，再通过显式 step env 绑定到同一华为 guard 的下载/安装步骤，避免跨 Action 依赖可变 GENV。已收集的 outputs 保留 wire 字节，但不会重新信任 Action 后的文件快照；缺 pins 仍 PIPE204。不证明 artifact 内容或实际下载成功，也不提供或下载真实华为版本。
- allowlist 中 OMP 的部分 AWS repository 有重复行，原脚本的 `matches != 1` 会拒绝这些引用。本轮不改变 allowlist 业务数据；这是独立的数据质量问题，不等同于 JSON 接口不匹配。

## 验证边界

`bash -n` 可以检查两个脚本及提取的 run 正文。`pnpm test:integration` 只在临时目录复制本 fixture，使用合成 overlays 和五个矩阵输入验证 JSON 传递及本地文件更新，另测 support-portal 更新/不变，以及 `cloud.yaml` 中不含远程命令的 distinct-ID/setup run 正文及其 JSON env、`GITHUB_OUTPUT/GITHUB_ENV` 单行写入；不能直接执行整个 workflow，也不能执行 git/gh/云平台操作。jq 语义基准为本机 1.8.2，其他安装版本的验证仅算兼容性检查，不代替静态分析器验收。

EKS 的运行时补充验证只提取真实 run 中的静态 jq filter，用受控字符串数组/null 检查唯一目标、零目标、多目标和错误元素；AWS run 本身仅做静态分析及 `bash -n`，绝不运行 AWS 命令。

Checksum 的运行时补充验证只提取真实 archive 赋值/guard 和校验语句，对临时合成字节使用 Node 计算 SHA-256；匹配/错误 digest、Unicode/空格/反斜杠路径与 CR/LF/NUL 拒绝都有断言。没有提取 curl、安装或 hcloud，macOS 本机 Darwin sha256sum 的运行结果只作为兼容性证据，不冒充 GNU 运行基准。`pnpm audit:case1` 保留真实 caller/callee，合成 overlays/pins 不替代动作或命令；完整链未验证时该入口返回非零。

临时文件/安装/清理已有有限静态模型：模板和路径参数使用 `--`，tar 关闭 `TAR_OPTIONS` 并固定解压选项，sudo/mv 不依赖交互，临时目录有 EXIT cleanup。模型不证明安全归档、安装内容或必定清理；未知文件效果仍撤销本次 run 的命名 env/output 证明和后续仓库证明，但不撤销 runner 已收集的前序不可变 step outputs。真实安装已可在完整链的合成依赖下静态检查。运行时仅提取 retry 中精确匹配已审阅形态的 mkdir/mktemp/trap/test/mv，使用临时合成字节验证特殊路径、成功替换及空文件失败时保留旧文件并清理临时文件；未执行 tar/install/sudo/hcloud，不能把该切片当成完整 action 运行验收。

华为 CLI 已有 configure/version、`ListClusters/v3` 和 `CreateKubernetesClusterCert/v3` 的限定静态模型。KooCLI 的 `cli-warning` 只能通过 configure 设置，真实 retry 查询前显式设置 warning/privacy，不依赖前一步的配置证明。查询固定 JSON 和保留每个 item 的 JMESPath hash，jq 保持“恰好一个集群且 UID 为非空 string”的原语义，避免缺 UID 在投影时被省略。原 API 不被反推成封闭对象，证书内容仍为不透明字节；所有 hcloud 命令保留未知文件效果。完整 retry 正文和限定 Action envelope 可静态检查，不保证 kubeconfig 有效；后续 rollout 显式清空 step BASH_ENV。

新增运行时补充验证只把真实 query/filter 交给纯本地 `jmespath@0.16.0` 和 jq，对合成响应测试缺/null/空/坏 UID、零/单/多集群及两个集群中一个缺 UID 的反例。测试先核对已审阅投影/过滤形态，源码变化则失败而不是执行未知命令；没有运行 hcloud/configure/云端查询。

1Password configure/load 已按限定 envelope 静态检查，但保留任意 GENV 注入、继承 env、unset/安装/PATH 和未知文件效果。output-only 秘密输出只证明原生 string-or-missing；env 渲染的缺失变为空串，toJSON 的缺失仍为 null，不证明凭据存在或认证成功。后续 Bash 显式清空 BASH_ENV。

AWS Action 仅支持显式 IAM 路径。真实 `aws_credentials` validator 在 AWS guard 下对两份 nullable JSON secret 排除 blank 和 CR/LF/NUL，只有两者都通过才写 GOUT；Action 消费 validated outputs，并固定 role/existing 控制与空 profile/proxy，避免空秘密走 runner fallback。限定模型保留 SDK/文件/环境未知效果，不证明实际认证；post cleanup 只作为 job-end may-effect，不提前清除 env。集成测试严格匹配已审阅 guard 后只运行本地 Bash/jq/printf，覆盖合法值、null、空白、CR/LF/NUL 和非 string，失败时 GOUT 为空且从不输出秘密到 stdout。

最新完整 audit：缺 pins/合成 pins 分别 9/0 条诊断、CLI exit 1/0；依赖齐备时 `complete: true`、27 unit、61 有限路径和 `fileEffectsUnknown: true`。这既证明完整静态调用链，又保留原 fixture 的缺依赖拒绝路径。完整单测 259、集成测试 14（含两个脚本、5 caller + 8 callee/retry body 的 `bash -n`）、构建及空 store 离线打包安装通过。
