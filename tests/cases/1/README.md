# Case 1：Cloud 镜像更新

这是首版 CLI 分析范围的真实风格 fixture，不是已通过分析器的产品测试。当前仅修改接口与规范；分析器、fixture runner 和 CLI 后续实现，现有 `pnpm test` 不收集此目录。

## 项目与接口

- 项目根为本目录，以 `.github/` 为唯一根标记；不是 pipe-ls 仓库根，也不是 `.github` 自身。不读取项目级分析配置。
- `parse-cloud-images.sh`：stdin 为一个 JSON string，内容仍为逗号分隔的镜像引用；stdout 为解析结果对象。无位置业务参数。
- `update-cloud-images.sh`：stdin 为 `{"environment": string, "parsed_images": <解析结果对象>}`；一次消费 stdin 后分别解析字段。`parsed_images` 是嵌套对象，不是重复编码的 JSON 文本。stdout 为更新结果对象。
- 两个脚本的完整单行模板在 shebang 后。镜像的 tag/digest 用两个完整对象的联合；restart_targets 用 `{}`、aws、huaweicloud、双平台四种完整对象的联合，保留现有返回形状，不引入 optional key 或开放对象。
- CI 平台文本经 `toJSON` 注入声明的 env；setup 通过 here-string 和 JSON 管道调用脚本。`GITHUB_ENV` 中的字符串用 `jq --arg` 编码，后续 step 先解码再传给原生工具。`restart_targets` 已是 JSON 对象，不再编码成字符串；`need_commit` 的 true/false 已是 JSON boolean。
- 所有 run 均无 stdout 业务返回值，因此不声明 stdout，也不为了占位输出 null。setup/commit 仍通过 `GITHUB_OUTPUT` 暴露命名 output，由 job 显式映射；这与 stdout 是两个接口。本 workflow 未声明 `workflow_call` 或 workflow outputs，不能作为可复用 CI 被调用方消费返回值。
- reusable workflow 的 platform/namespace/name 经 JSON 编码传入 `with`；被调方应按此协议解码。`GH_TOKEN_JSON/GH_REPO_JSON` 在 run 内解码成 gh 原生环境变量，不能输出 token 或把真实凭据用于测试。

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

## 首版覆盖目标（待实现）

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
- 当前未收录 `resources/**` overlays 和 `.github/workflows/do-rollout-restart.yaml`。完整工程检查应报告对应的 `PIPE204` 依赖缺口，不能声称完整通过；其他可独立检查的接口仍应检查。
- 被调 workflow 缺失，暂不能验证其输入声明、JSON 解码或返回接口；不要按调用方参数反向伪造其契约。补齐受控依赖后再验收完整链路。
- allowlist 中 OMP 的部分 AWS repository 有重复行，原脚本的 `matches != 1` 会拒绝这些引用。本轮不改变 allowlist 业务数据；这是独立的数据质量问题，不等同于 JSON 接口不匹配。

## 验证边界

`bash -n` 可以检查两个脚本及提取的 run 正文。运行时回归只在临时目录复制本 fixture，使用合成 overlays 和测试输入验证 JSON 传递及本地文件更新；不能直接执行整个 workflow，也不能执行 git/gh/云平台操作。jq 语义基准为 1.7.1，其他安装版本的验证仅算兼容性检查，不代替静态分析器验收。
