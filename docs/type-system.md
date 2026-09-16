# JSON 接口与分析语义

## 1. 结构模板

接口声明仅支持 `stdin: <模板>`、`stdout: <模板>` 和 `env NAME: <模板>`。业务参数通过 stdin JSON 或声明的环境变量传入，不支持位置参数声明。对象使用带双引号的 JSON key；占位符不加引号，字面量使用 JSON 语法。

| 模板 | 接受的 JSON 值 |
| --- | --- |
| `string`、`number`、`boolean`、`null` | 对应 JSON 类型；number 不包括 NaN/Infinity |
| `"ok"`、`0`、`true` | 精确的 JSON 字面量；`"string"` 不是 string 类型占位符 |
| `{"id": number, "name": string}` | 指定结构的对象 |
| `[number]`、`[{"id": number}]` | 零个或多个满足元素模板的值组成的数组，不是固定一项 |
| `[]`、`{}` | 精确的空数组、空对象 |
| `string \| null`、`[(number \| string)]` | 允许列出的 JSON 值形状；没有增加 JSON 以外的运行时类型 |

简化语法（空白可省略）：

```text
template := atom ('|' atom)*
atom := 'string' | 'number' | 'boolean' | 'null'
      | jsonString | jsonNumber | 'true' | 'false'
      | '{' (jsonString ':' template (',' jsonString ':' template)*)? '}'
      | '[' template? ']' | '(' template ')'
```

对象字段全部必需且默认封闭；缺少字段、多余字段都不兼容。nullable 字段必须存在，值可以是 null。首版不支持 optional key、开放对象、命名别名、递归模板或泛型，以免把接口变成另一套复杂语言；异构数组可用明确的元素备选模板表达。重复 key、`unknown`、`any`、`text` 及旧的 `json<T>[1]` 都是非法声明。

JSON 字符串必须编码：传入 `"Alice"` 符合 `string`，裸文本 `Alice` 不符合。数字文本 `42` 对应 JSON number，不会因 Bash 使用字符串存储就成为 JSON string。模板不自动补字段、转型或生成运行时校验代码。

兼容性按 JSON 值集合包含关系检查：字面量可赋给相应基础类型；对象逐字段检查；数组逐元素检查；实际值的所有备选都必须满足目标模板。不能因为某个分支符合就通过。空流不是 null，也不是一种数据类型。

## 2. 数据类型与分析状态分开

检查器在 JSON 类型之外维护以下事实，**这些事实不能写进接口模板**：

- **编码事实**：是否为合法 JSON、精确字节、首尾分隔符。脚本内部可以暂存原始字符，用于日志、控制信息或显式 JSON 编码，但不得直接穿过 JSON 数据接口。
- **数量**：jq 结果流的 `[min,max]`；数组长度与流数量分开。接口值始终要求恰好一项，多结果必须收集为数组。
- **状态**：shell 变量是否设置、stdin 是否耗尽、退出状态、可达路径、作用域与副作用。
- **来源和完整性**：事实来自常量、输入声明、外部命令契约或已分析的转换；无法建立事实时记录原因与受影响范围。

对一次检查的结论为“符合”“不符合”或“检查受阻”，不是给值赋一个 `unknown` 类型。受阻结论不能满足任何接口；仍可保留独立的已确认字段/符号供导航，但不把整段数据视为已通过。

精确常量可静态解码；一般原始字符不能凭形似 `{...}` 就当 JSON。外部入口的完整模板是输入前提，不要求实现自行解析验证；调用点存在可分析的反例时必须诊断。没有签名的命令产生 `PIPE201`，不能反向用下游期望模板证明其输出。

## 3. jq 语义

### 首版子集

支持静态 filter：`.`、`.foo`、`.foo.bar`、`.["foo"]`、`.[0]`、`.[]`；JSON 字面量、数组收集、静态 key 对象构造与 `{key}`；括号、管道、逗号、`//`；`--arg/--argjson` 绑定的变量；`select` 与对字面量的 `==/!=`；数组 `map`；`length/type/has("key")/tostring/tonumber/fromjson/tojson/ascii_upcase`。

先解析 Bash argv，再解析 jq options/filter。支持 `-n/-c/-r/-s`、对应长选项、短选项组合、`--arg/--argjson` 和 `--`。`-n -s`、文件参数、`-f/-R/-j/-e/--stream` 等首版未建模的组合/选项明确报告受阻；不忽略选项或 filter 后缀。

有效 jq 超出子集（如 def、reduce、动态 key、字符串插值、算术、模块）不冒充语法错误。动态 filter 不能按固定前缀推导。恢复树可用于编辑功能，损坏/不支持的节点不能参与通过证明。

### 必须保持的规则

| 操作 | 规则 |
| --- | --- |
| 默认 / `-c` | 对每个 stdin JSON 值运行 filter，编码为 JSON 序列；`-c` 只改变排版 |
| `-n` / `-s` | `-n` 不读 stdin，单次以 null 运行；`-s` 读完输入并收集为一个数组，再运行一次 |
| `--arg` / `--argjson` | 前者将原始字符编码成 jq string；后者要求参数恰好包含一个 JSON 值 |
| `-r` | string 项输出未加 JSON 引号的内容；其他 JSON 值仍编码。原始内容只有另行证明符合 JSON 才能再作 JSON 输入/输出 |
| 字段访问 | jq 对缺 key 或 null 取字段得到 null；number/string/boolean 上取对象字段报错。按本项目接口策略，直接访问封闭对象未声明的 key 给 `PIPE102`，不声称 jq 本身拒绝该访问；`has("key")` 则检查存在性 |
| 索引/迭代 | 数组越界得 null，长度不能确定时保留 null 可能；`.[]` 对数组/对象发射元素，非容器报错 |
| `f,g` / `f \| g` | 前者发射数量相加；后者对每个 f 结果运行 g，按类型与数量组合，不假定一对一 |
| `[f]` / `map(f)` | 每次输入收集为一个数组；`map(f)` 按数组上的 `[.[] \| f]` 建模，允许元素数增减 |
| `{key: f, ...}` | 多值字段按笛卡尔积构造对象；字段 filter 为空可能不生成对象 |
| `f // g` | 仅当 f 没有任何非 null/false 的结果时执行 g，不是逐项替换；0 和空字符串不是 false |
| `select` | 数量下界通常降为 0；受支持的 `select(.name != null)` 可细化后续字段，复杂关系不猜测 |
| `length/type` | length 接受 string/array/object，null 得 0，number 得绝对值，boolean 报错；type 返回 JSON 类型名字符串 |
| 转换 | ascii_upcase 要求 string；tonumber/fromjson 需能证明内容可转换，否则检查受阻；tojson 保留 JSON 编码来源，tostring 对 string 原样返回 |

数量用区间保守包围，分支取包络而非相加；接口要求 `[1,1]`。`empty` 为零项，`[empty]` 为一项空数组；不能用调用方期望数量收窄实际结果。类型/分支组合超预算时报告受阻，不退化成兜底类型。

## 4. Bash 数据流

### 保真传输与作用域

- 支持常量/带引号变量赋值、命令替换、管道、here-string，以及固定单参数 `printf '%s'` / `printf '%s\n'`。未加引号展开可能分词/glob，不能默认保留数据。
- `x=$(cmd)` 捕获 stdout 并删除所有尾部 LF；通常不改变合法 JSON 值，但会改变原始字符串。NUL 无法保留时诊断。`"$x"` 是一个 argv，不把多项 JSON 自动变成数组。
- 带前后缀的拼接必须重新检查编码/分隔。`printf '%s' '1'; printf '%s' '2'` 输出 JSON number 12，不是两项；分别追加 LF 才是两项，此时不符合单值接口。
- 子 shell/命令替换/管道隔离 shell 变量写入；`export` 决定子进程环境；命令前赋值不泄漏。函数遮蔽先于外部签名解析。支持静态 cwd 和简单 stdout/stderr 重定向，按顺序处理 `2>&1`。
- 支持有限 `if`、静态 `exit`、`set -e/-u/-o pipefail` 上下文；分支合并变量、输入消费与输出事实。不从任意 test 推导 JSON 类型保护。
- echo、复杂 printf、循环、`&&/||`、source/eval、复杂展开/重定向等首版给受影响范围的缺口；后续按真实脚本频率补齐。可能修改变量、命令解析或 cwd 的语句使相关事实失效，不能跳过后继续证明整个脚本。

### stdin 是会被消费的通道

输入模板描述进入脚本的一个 JSON 值，不是给每个命令复制一份输入。抽象状态记录各输入通道的剩余数据、读取行为和 EOF：

- 默认 jq/jq -s 正常读完所接通道；jq -n、固定 printf 不读取。不能确定读取行为时，后续使用同一通道的检查受阻。
- here-string/管道/显式重定向建立或连接通道。继承 stdin 的命令及命令替换共享其消费效果；shell 变量隔离不意味着输入偏移也隔离。子进程可消费父进程之后会用到的输入。
- `jq '.'; jq '.'` 中第二个 jq 看到 EOF，不能再次使用入口模板。分支 join 保留“可能耗尽”，共享读取顺序无法证明的管道报告受阻。
- 本地脚本摘要和外部命令摘要必须包含正常/失败路径的输入消费事实，无法确定时阻断后续相关检查。省略 stdin 声明表示不读取继承通道，但允许命令使用内部管道/here-string 新建的输入；显式声明了 stdin 却未使用时，调用方仍需满足声明。

### stdout 与失败路径

检查所有成功退出路径上未重定向的 stdout **整体**是否恰好为一个匹配模板的 JSON 值，不只检查最后一条命令。空输出、多个值、日志污染或未完成分析的输出都不能通过。没有业务返回值也要输出 `null`。

保留命令正常完成与失败时的部分输出/输入消费摘要。最终 exit 0 不能证明之前所有命令成功；管道默认只取末条退出状态，pipefail 不回滚已输出内容。已发现的 jq 类型错误、显式失败或失败后继续不能被抹去；相关恢复路径未建模时报告受阻。非零退出不要求成功返回模板，日志应走 stderr。

声明只保证约定输入下的结构，不保证外部命令的网络/权限等操作性成功；该假设随报告列出，不替代显式失败路径分析。

## 5. 验收示例

以下均为独立脚本正文（可以添加 Bash shebang），每个都有完整接口；分析器应按表中预期给出结果。

### 正例：数据始终是 JSON

```bash
# @pipe stdin: {"id": number}
# @pipe stdout: {"id": number}
result=$(jq -c '{id: .id}')
printf '%s\n' "$result"
```

入口前提保证对象；jq 消费 stdin 并输出一个对象；命令替换和 printf 保持 JSON 编码，输出符合声明。

### 反例：裸字符串不是 JSON string

```bash
# @pipe stdin: {"name": string}
# @pipe stdout: string
jq -r '.name'
```

声明允许任意 name，不能保证去掉引号后仍是 JSON string；报告 `PIPE101` 的潜在编码错误。移除 `-r` 后可满足接口，不要求脚本增加运行时校验。

| 场景（均假设有完整头部） | 预期 |
| --- | --- |
| stdin `{"name": string \| null}`，stdout string，执行 `jq '.name \| ascii_upcase'` | `PIPE102`；先用 `// "anonymous"` 处理 null 后符合 |
| stdin null，stdout `[number]`，执行 `jq -n '1, 2'` | `PIPE103`；改为 `jq -n '[1, 2]'` |
| stdin number，stdout number，执行 `jq '.'; jq '.'` | 只输出入口的一项，第二次读到 EOF；不重复推导输入 |
| stdin null，stdout number，执行无签名 `business-command` | `PIPE201`，检查受阻；不赋予兜底类型，不按 stdout 声明补推断 |
| stdin null，stdout null，仅执行 `printf '%s\n' 'log' >&2` | `PIPE103`，没有返回 JSON null |
