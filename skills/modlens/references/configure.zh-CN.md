# 配置 ModLens

[English](configure.md) | 中文

用户询问如何安装、配置或切换 ModLens provider 时读这份文档。优先替用户把命令跑掉，而不是解释给他听。

## 配置放在哪

`~/.modlens/config.json`，由 CLI 管理。优先级：CLI 参数 > 本文件 > 内置默认值。一个 provider 的设置整份来自单一来源：自 3.17.0 起，本文件提到过它就以本文件为准，只字未提才用绑定的环境变量。不设 `provider` 时按失败切换链依次尝试（有 `gemini-api` key 会先于 agent CLI 被试到），机器上什么都没配才会落在 `antigravity-cli`。

```bash
modlens config init                     # 写入一份起步配置（已存在则拒绝，--force 重写）
modlens config show                     # 生效的配置文件，API key 打码显示
modlens config set provider <name>      # 更改默认 provider
modlens config set <provider>.<field> <value>   # 字段：apiKey、baseUrl、model、proxy、extraBody、structuredOutput
modlens config set proxy http://127.0.0.1:7890          # 所有 API provider 的默认代理
modlens config set openai.proxy ""                      # 让一个 provider 强制直连
```

`config set` 写文件时权限为 0600。

## 配置文件的完整形状

所有内容都在七个顶层键之下，全部可选。下面的示例一次性展示了所有支持的键和字段（真实文件只需要写你用到的部分）。文件不存在就全用默认值。provider 的设置放在 `providers.<name>` 下面，不在顶层，手工编辑最常犯的就是这个错。

```json
{
  "provider": "gemini-api",
  "cooldown": "on",
  "proxy": "http://127.0.0.1:7890",
  "reuse": { "claude": true, "codex": true, "opencode": false, "pi": true, "grok": true },
  "saved": {
    "openai": {
      "dashscope": { "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1", "apiKey": "sk-...", "model": "qwen3-vl-plus" }
    }
  },
  "guards": {
    "allowModels": ["deepseek-v4-*", "glm-5.2*", "*/glm-5.2*", "glm-5.3", "*/glm-5.3", "minimax-m2.5*", "qwen3-coder*"],
    "denyModels": ["glm-*v*", "*/glm-*v*", "glm-5.3-flash", "glm-5.3-flash-*", "glm-5.3-flash:*", "*/glm-5.3-flash", "*/glm-5.3-flash-*", "*/glm-5.3-flash:*", "deepseek-vl*"],
    "denyWhenUnknown": false
  },
  "providers": {
    "antigravity-cli": { "model": "gemini-3.6-flash-low" },
    "gemini-api": {
      "apiKey": "AIza...",
      "baseUrl": "https://generativelanguage.googleapis.com",
      "model": "gemini-3.6-flash"
    },
    "openai": {
      "apiKey": "sk-...",
      "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
      "model": "qwen3.6-27b",
      "proxy": "http://127.0.0.1:7890",
      "extraBody": { "thinking": { "type": "disabled" } },
      "structuredOutput": true
    },
    "anthropic": {
      "apiKey": "sk-ant-...",
      "baseUrl": "https://api.anthropic.com",
      "model": "claude-haiku-4-5-20251001"
    },
    "claude-cli": { "model": "haiku" }
  }
}
```

字段含义：

- `provider`：不传 `-p` 时由哪个 provider 执行。标准名和别名都行（`agy`/`antigravity` 对应 `antigravity-cli`，`gemini` 对应 `gemini-api`，`openai-compat` 对应 `openai`，`claude` 对应 `anthropic`，`kimi`/`kimi-code` 对应 `kimi-cli`，`claude-code` 对应 `claude-cli`）。留空或缺失表示不钉任何一个：由失败切换链决定，已配置的 API provider 先于 agent CLI 被尝试。
- `cooldown`：`'on'`（默认）或 `'off'`。打开时，配额耗尽的密钥会记入 `~/.modlens/state.json`，恢复前放到队尾再试（默认 45 分钟，月度 HTTP 432/433 为 24 小时，引擎回报的 `Resets in` 子句优先）。关闭时不读也不写那个文件。`modlens state clear` 会忘掉全部冷却。
- `proxy`：所有 API provider 的默认代理。它缺失时改由 `HTTPS_PROXY` 或 `HTTP_PROXY` 提供默认值，环境变量路线会遵守 `NO_PROXY`。
- `providers.<name>.proxy`：有三种状态。字段缺失表示继承上述默认值，空字符串表示强制直连，非空 URL 表示只给这个 provider 使用的代理。这样共享代理失效时，内网端点仍然可以直连。要恢复继承，删除配置文件中的这个字段，或在 dsh 设置卡中选择继承。`config show` 会把空值显示成 `direct`，设置卡会提供三种选择，而且不会把已保存的代理地址发送给浏览器。
- `providers.<name>.<field>`：共六个字段，`apiKey`、`baseUrl`、`model`、`proxy`、`extraBody`、`structuredOutput`（仅 openai 路线）。每个 provider 条目都可选，条目里的每个字段也都可选。别名键同样会被读取（存在 `gemini` 下的设置在解析到 `gemini-api` 时也能找到），冲突时标准键胜出。`apiKey` 接受英文逗号分隔的列表。请求按配置顺序使用，只在鉴权、限流或配额失败后轮换。其他失败会跳过剩余密钥，并继续走现有的 provider 故障转移。
- `providers.<name>.extraBody`：一个 JSON 对象，合并进 API provider（`gemini-api`、`openai`、`anthropic`）的请求体，用来传厂商有而 modlens 没有对应参数的开关。最常见的用途是关掉思考，见下文小节。嵌套对象逐键合并，所以加一个开关不会动到该块里的其他内容。承载图片、提示词和各路线自身强制机制的字段会被拒绝，报错会点名该字段。`openai` 路线上的 `response_format` 不在此列：在那里设置它就是有意替换掉 modlens 本来会发的那份 schema。三个 CLI provider 不发请求体，所以在 `antigravity-cli`、`claude-cli` 或 `kimi-cli` 上运行时它会被忽略，并在 `meta.warnings` 里说明。
- `providers.openai.structuredOutput`：设为 `true` 时，让 OpenAI 兼容网关自己强制执行视觉契约，以 `response_format: json_schema` 的严格形式发出。默认关闭，因为不支持结构化输出的网关会对这个字段返回 400。你在 `extraBody` 里设的 `response_format` 优先级更高。
- `saved.openai.<标签>`：openai 槽的命名存档，只有 `modlens config save openai <标签>` 写入、`modlens config use openai <标签>` 整包换入。切换网关不再丢上一个端点的 key：`use` 拒绝覆盖没有任何标签保存过的活跃槽（`--discard` 表示明确放弃）。解析、guard、failover、环境变量规则都不读这个区，活跃槽始终是唯一生效的 openai 路由。
- `guards`：调用 guard，给在同一个客户端里既跑纯文本模型又跑视觉模型的人用。两个列表都放 glob 模式（支持 `*` 和 `?`，不区分大小写，同时匹配模型名和 `provider/model`），用 `modlens config set guards.denyModels '["gemini-3*"]'` 或 `guards.allowModels` 设置（JSON 数组或逗号分隔的列表都行，传空则清除）。两种写法表达同一个意图，选列表更短的那种：
  - 只用 `denyModels`：除了列出的视觉模型，其余全部运行引擎。适合你接入的模型大多是纯文本的情况。
  - `allowModels` 非空（白名单模式）：只有列出的模型运行引擎，其他所有已识别的模型一律拒绝。适合 2026 年的实际格局，纯文本模型才是那份短名单。deny 模式仍然优先于 allow 匹配，所以宽泛的 allow 可以把视觉变体剔出去，正如上面的示例：`glm-5.2*` 和 `*/glm-5.2*` 覆盖裸名和带命名空间的 5.2 系列（`z-ai/glm-5.2:free`），`glm-5.3` 和 `*/glm-5.3` 覆盖 GLM-5.3 本体，`glm-*v*` 和 `*/glm-*v*` 抓住 `glm-5v-turbo`、`z-ai/glm-5.2v` 与 `z-ai/glm-5.2-vision`，带分隔符的 `glm-5.3-flash` / `glm-5.3-flash-*` / `glm-5.3-flash:*`（以及对应的 `*/` 形式）抓住 `glm-5.3-flash`。guard 按存下来的 id 匹配，不会剥掉厂商前缀，所以带命名空间的文本型号需要那条 `*/` 配对，带命名空间的视觉变体也需要对应的 deny 配对。不要写 `glm-5.*` 或 `glm-5.3-flash*`：前者也会匹配 `glm-5.3-flash`，后者也会匹配 `glm-5.3-flashlight` 这种连写。allow 模式要锚定得紧一些（写 `deepseek-v4-*` 而不是 `deepseek*`），这样厂商下一代多模态型号会自动掉出名单，等你检查过再上场。
  - 按真正抵达模型的内容来列名单，而不是按它本来能看到什么：多模态模型如果躲在一个剥离图片的网关后面，照样需要 modlens，而你的会话记录里存的是网关上报的模型名。`modlens doctor` 的 Guard 一节会显示规则和一条实时判定，方便核对结果。
  - `denyWhenUnknown`（默认 `false`）决定在两种模式下，当没有任何信号能识别当前模型时怎么办：`false` 放行，`true` 拒绝。当前模型的检测来源从强到弱依次是：`MODLENS_MODEL` 环境变量（`none` 表示「按未知处理」）、harness 的会话存储、`--model` 自报。
- `GEMINI_API_KEY`、`GEMINI_BASE_URL`、`OPENAI_API_KEY`、`OPENAI_BASE_URL`、`ANTHROPIC_API_KEY`、`ANTHROPIC_BASE_URL` 用来配置本文件只字未提的 provider。本文件提到过的，它们完全不生效。过去它们逐字段覆盖，拼出的组合在哪儿都不存在：地址和密钥本是一副凭据。密钥变量和文件字段一样接受英文逗号分隔的列表。modlens 仍然读取 `MODLENS_HARNESS`（粘贴恢复和 guard 的作用范围）、`MODLENS_MODEL`（guard 覆盖，见 `guards`），以及各 harness 自己注入的指纹，它们把 guard 的存储查询钉在当前 session 上：`CLAUDE_CODE_SESSION_ID`、`CODEX_THREAD_ID`，加上 harness 检测依赖的存在性标记（`CLAUDECODE`、`PI_CODING_AGENT`、`CODEX_SANDBOX`）。
- `reuse.<claude|codex|opencode|pi|grok>`：按 harness 记录的授权，决定能否花费本机其他登录态，由引导对话（`references/onboard.md`）写入。`true` 允许读图时复用该 harness（pi 的凭据加入 inline 区且所有 guard 照常生效，已登录的 Codex、OpenCode 的视觉模型或直接驱动的 pi 加入 agent 区，排在 `claude-cli` 之前），`false` 记下一次拒绝，用户不会被再次询问，缺失表示从未问过，什么都不会运行。`claude` 缺失视为已授权：`claude-cli` 作为内置 provider 早于这套模型存在，`reuse.claude false` 会把它移出链条（`-p claude-cli` 仍可钉死）。复用来的引擎不比用户自己的优先：分区只按速度档次排序。每个复用得来的答案都会在 `meta.warnings` 里加一行，说明花的是谁的额度，`modlens doctor` 的 Reuse 一节会显示每个 harness 的决定和探测发现的结果（探测结果在 `~/.modlens/auto-cache.json` 里缓存 6 小时，doctor 每次都重新探测）。用 `modlens config set reuse.codex true` 设置（传空恢复为从未问过）。
- 未知的顶层键和未知的 provider 名会被忽略而不是报错，所以敲错字会无声失败：手工编辑后跑一下 `modlens doctor`，它会显示哪些文件值和环境变量真正生效。

手工编辑没问题（保持文件是合法 JSON，权限 0600）。`modlens config set` 做的是同一件事，只是多了护栏。

## 各 provider 配置步骤

### antigravity-cli（默认，免费，无需 key）

需要装好 Antigravity CLI 并完成登录：

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash
agy    # 用户需自己在浏览器完成登录，然后退出
```

任何免费 Google 账号都行，不需要 Google AI Pro。登录无法自动化，请让用户自己跑一次 `agy`。

### gemini-api（免费 key，最快的免费通道，5-10 秒）

1. 用户到 https://aistudio.google.com 创建一个 key（约三分钟，无需信用卡，免费额度不过期）。
2. 两种方式任选其一保存：

```bash
modlens config set gemini-api.apiKey <key>
# 省略值：进入隐藏输入，密钥不进 argv、不进 shell 历史，也不进这段对话
modlens config set gemini-api.apiKey
```

用户就在自己终端前时，先给隐藏输入这条。大多数人图方便还是会把 key 直接贴进对话，那也没问题：照收照存。隐藏输入是留给在乎的人的。

默认模型 `gemini-3.6-flash` 在免费档就有视觉能力（约每分钟 10-15 次请求，每天 1500 次）。免费档的数据可能被 Google 用于改进产品，用户要处理敏感图片时请提醒这一点。

### openai（任意 OpenAI 兼容的多模态端点）

需要三个值。以 DashScope 的 qwen 为例：

```bash
modlens config set openai.baseUrl https://dashscope.aliyuncs.com/compatible-mode/v1
modlens config set openai.apiKey <sk-key>
modlens config set openai.model qwen3.6-27b
```

`baseUrl` 必填，用官方 OpenAI 也要写（`https://api.openai.com/v1`）：这条路线服务任意兼容端点，替用户猜一个，就等于把本该发给别家的密钥连同图片一起送到用户从没指定过的地方。模型必须是多模态的，纯文本模型会失败或产生幻觉。

这条路线默认在服务端不做任何约束，能力弱一些的模型可能只答出契约的一半，运行就会以明确报错失败。真遇到就让网关自己强制执行：

```bash
modlens config set openai.structuredOutput true
```

契约会以 `response_format: json_schema` 的严格形式发出去，schema 由 modlens 校验用的那份推导而来。默认关闭，因为不支持结构化输出的网关会对这个字段返回 400，端点拒绝就关回去。关掉思考（见下）会让结构错误更容易出现，所以这两项常常一起用。

### anthropic（Claude API key）

```bash
modlens config set anthropic.apiKey <sk-ant-key>
```

默认模型是 Claude Haiku（`claude-haiku-4-5-20251001`）。schema 通过强制工具调用来约束。

**`ANTHROPIC_BASE_URL` 陷阱已经拆掉了。**modlens 过去把这个变量按字段绑到 `anthropic.baseUrl`，于是一个为了把 Claude Code 路由到纯文本网关而设的变量，会让视觉请求也无声地发到那里，哪怕密钥是在配置文件里设的。现在只要文件里出现 `anthropic`，文件就是这条路线的全部来源，那个变量再也够不着它，确实想换端点就设 `anthropic.baseUrl`。而在文件对 `anthropic` 只字未提时，`ANTHROPIC_API_KEY` 和 `ANTHROPIC_BASE_URL` 仍然能独立配好这条路线，两半来自同一处。卡在中间的情况（变量设着、文件里有 `anthropic` 却没有 `baseUrl`）会直接报错，并给出保留原端点的那条命令。

### kimi-cli（复用 Kimi Code 登录，无需密钥）

搭在已有的 `kimi` 登录上，花的是用户的 Kimi Code 订阅而不是密钥。先从 https://moonshotai.github.io/kimi-code/ 安装，跑一次 `kimi` 并 `/login`，然后：

```bash
modlens config set provider kimi-cli
modlens config set kimi-cli.model <alias>   # 可选，不设就用 kimi 自己的默认模型
```

点名它才会启用。和其他 CLI 路线不同，它不会自己加入故障转移链：它花的是订阅，而装了 CLI 不等于同意花它。

模型别名用 kimi 自己的那套，形如 `<provider>/<model>`，`kimi provider list` 能看到，而且必须支持图片输入。这条路线没有服务端 schema 约束（该 CLI 没有 `--json-schema`），契约是以填好的 JSON 模板随提示词发过去的，能力弱的模型可能只答出一半，遇到就用 `-p gemini-api` 兜底。

有一个实现细节，调试时值得知道：modlens 运行 `kimi` 时把 skill 发现指向了一个空目录。否则 kimi 可能在共享的 skill 目录里找到 modlens skill，然后通过调用 modlens 来读图，也就是 modlens 自己调自己。

### claude-cli（Claude Code 登录态，无需 key）

借用已有的 `claude` 登录态，花的是用户的 Claude 订阅额度，不产生单独的 API 账单。需要装好并登录 Claude Code（用 `claude --version` 检查）。运行时只带 `--allowedTools Read`。只支持本地图片文件，远程 URL 请改用 gemini-api。默认模型别名 `haiku`。

```bash
modlens config set provider claude-cli   # 用户愿意的话把它设为默认
```

## 关闭思考

推理模型答题前要先花掉思考预算。从图片里读文字用不上这些，所以在默认思考的模型上，一次识别白白变得又慢又贵。每家厂商给这个开关起的名字都不一样，也没有通用写法，所以 modlens 只负责把你放进 `extraBody` 的内容原样发出去，名字怎么写去查厂商自己的文档。

```bash
modlens config set openai.extraBody '{"thinking":{"type":"disabled"}}'   # 持久保存
modlens -i shot.png --extra-body '{"thinking":{"type":"disabled"}}'      # 仅本次运行
modlens config set openai.extraBody ''                                   # 清除
```

`--extra-body` 在该次运行中整体替换已存储的对象，而不是合并进去。

已知写法，截至 2026 年 8 月：

| 端点 | 要发送的字段 |
| :-- | :-- |
| MiMo 官方 API（`api.xiaomimimo.com/v1`） | `{"thinking":{"type":"disabled"}}` |
| MiMo Responses 格式路由 | `{"reasoning":{"effort":"none"}}` |
| Qwen、GLM、MiMo 等自建在 vLLM 或 SGLang 上（GLM-5.3 与 GLM-5.3-Flash 不支持关闭思考） | `{"chat_template_kwargs":{"enable_thinking":false}}` |
| 接受 effort 档位的 OpenAI 风格网关 | `{"reasoning_effort":"low"}` |
| `gemini-api`，Gemini 3 系列 | `{"generationConfig":{"thinkingConfig":{"thinkingLevel":"LOW"}}}` |
| `gemini-api`，Gemini 2.5 Flash 与 Flash Lite | `{"generationConfig":{"thinkingConfig":{"thinkingBudget":0}}}` |
| `anthropic` | 什么都不用做，不主动要求就不思考 |

三个会咬人的地方：

- 不是每个模型都能关。Gemini 3 Pro 和 Gemini 2.5 Pro 没有关闭开关，只能调低档位。有些模型完全无视 effort 字段，照样思考。
- 严格的云（Groq 和 Cerebras 都在内）遇到不认识的字段会直接返回 400。以前能跑的请求现在报 400 并点名你的字段，说明那个网关要的是另一种写法，不是这一种。
- 另一些则会接受未知字段然后悄悄忽略，所以要验证它是否生效，别想当然。把 `meta.durationSeconds` 和 `meta.usage` 里的 token 数与不带 `extraBody` 的一次运行对比，两者都没变，就是字段没起作用。
- 较弱的模型可能得靠思考才能填满 schema。在同一张流程图上实测：`gemini-3.6-flash` 在 `thinkingLevel: LOW` 下从 12 秒缩到 5.7 秒，区块和转录内容不变，但 DashScope 上的 `qwen3.6-27b` 设了 `enable_thinking: false` 后开始漏掉版面区块必填的 `type`，modlens 会拒绝这种结果而不是当作证据放行。刚关掉思考就出现结构错误，说明这就是代价，给那个模型把思考打开，或换到有服务端 schema 约束的路线。

## 替用户选 provider

- 想零配置且免费：`antigravity-cli`（需要 agy 登录，每张图 15-40 秒，密集或困难的图可试 `-m gemini-3.1-pro-high`）。
- 想又快又免费：`gemini-api`（三分钟领 key，5-10 秒）。
- 已经在给 Claude 付费：`claude-cli`（无需额外 key，agent 循环 20-45 秒）或 `anthropic`（API 计费）。
- 有偏好的多模态端点（qwen、GLM 等）：`openai`。

每个配好的 provider 也互为后备：一次运行按固定顺序尝试它们（5-10 秒的 inline API provider 先上，然后是 agent 类，对远程 URL 来说这个顺序同时也是一道安全边界），遇到报错、超时或违反 schema 的结果就故障转移。`config set provider <name>` 把某个 provider 提到它所在允许分区的最前面，`-p <name>` 钉死唯一一个，不做回退。`doctor` 会打印这些故障转移链，结果里的 `meta.attempts` 显示一次运行实际试了什么。

## 故障排查

- 报错点名了缺失的环境变量或某条 `config set` 命令：照着运行即可。
- `Provider CLI not found: agy`：安装 Antigravity CLI 或换 provider。
- `Claude CLI reported ...` 或结果为空：检查 `claude` 的登录状态。
- openai 路线报 `does not match the vision schema`：重试一次，仍不行就换 gemini-api 或 anthropic。
- `extraBody cannot override "<field>"`：该字段承载图片、提示词或 schema。把它从对象里去掉，留下厂商开关即可。
- 400 报错点名了你在 `extraBody` 里设的字段：那个网关不认识它。其他写法见上文关闭思考一节。
- `config init` 拒绝执行：文件已存在。先用 `modlens config show` 查看，只有用户同意覆盖时才加 `--force`。
