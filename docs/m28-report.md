# M28 · 用量统计 v3 — 探查报告

> **PART 1 · PROBE（SESSION 1）**
> 第 0–7 节是 2026-10-30 的只读探查结论，写作时没有改任何产品代码。
> 实现与测试结果见 **§8**：第一次实现 session（SESSION 2–4）被中断，代码已落盘且
> 插件单测 / vitest 通过，但 Playwright 套件未跑通；本 session（SESSION 5）接手完成
> e2e 诊断与修复、跑完全部套件并补写 §8。
>
> 探查环境：QwenPaw `2.2.2.post1`（`~/workspace/qwenpaw-ref`）、
> AgentScope `2.0.10`（`~/workspace/qwenpaw-local/venv`）、
> 本机真实数据 `~/workspace/qwenpaw-local/home`。

---

## 0. 结论摘要

1. **缓存数字已经按“轮”落盘，插件不需要解析 provider 原始响应。** 每轮收尾的 assistant
   消息带 `metadata.qwenpaw_turn_usage.usage`，其中已有
   `cache_read_tokens` / `cache_write_tokens` / `cache_eligible_input_tokens` /
   `cache_observed` / `cache_hit_rate`（见 §2.1）。
2. **原始字段逐 provider 不同，但 QwenPaw 已归一到同一形状**：
   DeepSeek 读 `prompt_cache_hit_tokens`；OpenAI 兼容读
   `prompt_tokens_details.cached_tokens`（兼容 `input_tokens_details.cached_tokens`）；
   Anthropic 读 `cache_read_input_tokens` + `cache_creation_input_tokens`。
   **`prompt_cache_miss_tokens` 在整个 QwenPaw / AgentScope / 本仓库里一次都没被读取**
   （grep 仅命中本任务书），未命中只能推导（§2.2、§2.5）。
3. **`cache_observed` 是唯一可靠的“provider 到底报没报缓存”标志。** 报 `0` 是真 0%，
   缺字段是“不报告”，两者不能混（§2.4）。
4. **每轮记录了实际使用的模型**：`usage.provider_id` + `usage.model_name`，取自调用时的
   model 实例。真实反例：`m2main` 这个 chat 的 10 轮里有 6 轮 `kilo-auto/free`、4 轮
   `openrouter/free`，而 chat 级当前模型只有 `openrouter/free`——拿当前模型回填历史会错 6 轮
   （§3.1）。
5. **`session_cache_*` 是会话累计快照，不是每轮增量。** 逐轮求和 `session_cache_read_tokens`
   会重复计数；实测 38 个文件全部满足“最后一轮的 session 值 == 逐轮求和”（§2.5、§5）。
6. **Anthropic 的 `prompt_tokens` 不含缓存 token，OpenAI/DeepSeek 的含。**
   `cache_eligible_input_tokens` 才是真正的输入分母（Anthropic = prompt+read+write，
   其余 = prompt）。这决定了“未命中”只能按 eligible 推导，不能一律用 `input - hit`（§2.2、§5）。
7. **Turso 归档里没有任何 usage**：线上库只有 `chats` / `messages`（messages 仅
   id/chat_id/role/content/created_at），代码 schema 同样如此；`qwenpaw_turn_usage` 是
   **session 文件里的 metadata key，不是 Turso 表**。stats 必须以 session 文件为准（§4）。

---

## 1. 探查环境与数据集

### 1.1 数据

| 项 | 值 |
|---|---|
| session 根 | `~/workspace/qwenpaw-local/home/workspaces/default/sessions/` |
| 原始文件 | 38 个带轮次的 JSON：1 个 `console/` + 37 个 `web/`（另有 1 个 `.synced.json` 清单，不是会话） |
| **插件扫描范围** | **37 个 `web/`**：`SessionUsageStore._paths` 只列 `root/web/` 与 `root/`（`plugin/util.py:1513-1522`），**`console/` 不在内** |
| 轮次 | 原始 96 个 assistant 轮；插件可见 **95 轮**（console 那 1 轮不计），全部带 `qwenpaw_turn_usage.usage` |
| 多轮文件 | 16 / 37 个 web 文件；最多 10 轮（`m2file` / `m2main` 都是 10） |
| provider | 只有 `kilo`：`kilo-auto/free` 44 轮（web 43 + console 1）、`openrouter/free` 52 轮 |
| 汇总 token（原始 38 文件） | input 1,662,549；output 12,335；cache_read 341,653；eligible 1,662,549（20.55%）；cache_write 0 |
| 汇总 token（插件 37 文件） | input 1,648,974；output 12,314；cache_read 341,141；eligible 1,648,974（**20.69%**）；cache_write 0 |
| `cache_observed` | 原始 96/96、插件 95/95 为 `true`；`estimated` 0 轮；`model_name` 缺失 0 轮 |

> 两者差值正好是 console 的 `default_tier2probe` 那一轮（13,575 / 21 / 512）。
> 插件口径与 `protocol/frames.md:714-715` 的示例 totals 完全一致（95 / 1,648,974 / 12,314）。
> 后文引用“96/96”时指原始样本的字段完整性；凡是**聚合数字**，以插件口径（95 轮）为准。

样本文件（下文的“真实样本”均指这里）：

- `~/workspace/qwenpaw-local/home/workspaces/default/sessions/web/web-user_web--web-user--m2main.json`
- `~/workspace/qwenpaw-local/home/workspaces/default/sessions/console/default_tier2probe.json`

### 1.2 现有链路（只读核查）

QwenPaw 每轮结束把用量写到两处：

1. **每轮收据（stats 的来源）**：`TokenRecordingModelWrapper._record_usage` 组装
   `usage_data`（`qwenpaw-ref/src/qwenpaw/token_usage/model_wrapper.py:160-184`），
   `persist_turn_usage` 把它写到“本轮最后一个 assistant”的 metadata
   （`qwenpaw-ref/src/qwenpaw/token_usage/turn_usage.py:248-264, 300-334`；
   调用点 `qwenpaw-ref/src/qwenpaw/app/channels/base.py:1951-1971`）。
2. **全局按天聚合（旁证）**：`_UsageEvent` → `TokenUsageBuffer` →
   `<qwenpaw home>/token_usage.json`（`qwenpaw-ref/src/qwenpaw/token_usage/buffer.py:18-31, 195-236`）。

插件 M24 只读第 1 种：`plugin/util.py:1105`（key）、`plugin/util.py:1639`
（`session_turn_summary`）、`plugin/channel.py:1503-1583`（`get_stats`）。插件当前
**完全没有缓存字段**（`plugin/*.py`、`protocol/frames.md` 里 grep `cache_read|cache_hit` 无命中）。

---

## 2. 探查项 1 — 缓存字段到底叫什么

### 2.1 落盘后的唯一形状（插件真正该读的东西）

真实样本（`web-user_web--web-user--m2main.json` 第 1 轮）实际出现的 key：

```text
message.metadata.qwenpaw_turn_usage.usage = {
  provider_id, model_name,
  prompt_tokens, last_prompt_tokens, completion_tokens, total_tokens,
  cache_read_tokens, cache_write_tokens, cache_eligible_input_tokens,
  cache_observed, cache_hit_rate,
  context_size, compact_threshold,
  session_cache_read_tokens, session_cache_eligible_input_tokens,
  session_cache_observed, session_cache_hit_rate
}
message.metadata.qwenpaw_turn_usage.context_usage = {
  estimated_tokens, max_input_length, context_usage_ratio
}
message.usage = {
  input_tokens, output_tokens, cache_input_tokens, cache_creation_input_tokens
}
```

- 96/96 轮都出现了上述 `usage` 的 17 个 key（统计脚本逐 key 计数；插件可见的 95 轮同样齐全；
  `context_usage` 96/96）。
- `message.usage`（AgentScope `Msg.usage`）与 `metadata...usage` 的
  `input/output/cache` 在 **96/96 轮完全相等**（逐轮比对），但前者没有
  `model_name` / `provider_id` / `cache_observed` / `cache_eligible_input_tokens`，
  **不能用于模型归属，也不能区分“真 0”与“没报”**；stats 应继续只读 metadata。
- 轮收据只挂在 assistant 上（`turn_usage.py:235-245` 找“最后一条 user 之后的 assistant”），
  user/tool 消息没有，所以“1 条收据 = 1 轮”成立。

字段的产生处：

| 字段 | 产生代码 | 语义 |
|---|---|---|
| `cache_read_tokens` | `model_wrapper.py:113-116, 151` | 从缓存读到的输入 token（命中） |
| `cache_write_tokens` | `model_wrapper.py:117-122, 152` | 写入缓存的输入 token（Anthropic 有；本机 Kilo 全 0） |
| `cache_eligible_input_tokens` | `model_wrapper.py:31-59, 153` | 该轮可参与命中率计算的输入分母 |
| `cache_observed` | `model_wrapper.py:125-140, 154` | provider 是否真的报了缓存字段 |
| `cache_hit_rate` | `model_wrapper.py:171-175` | **百分数 0–100**，`read/eligible*100`，分母 0 时 `null` |
| `session_cache_*` | `turn_usage.py:73-126` | 整个会话到本轮为止的累计值（不是本轮增量） |

> `cache_hit_rate` 的单位有真实样本为证：`m2main` 首轮 `3.771639042357274`（512/13575），
> 即百分数而不是 0–1 比例；QwenPaw 自己的测试也断言 80/100 → `80`
> （`qwenpaw-ref/tests/unit/token_usage/test_token_usage.py:1031`）。

### 2.2 原始 provider 字段 → 归一字段（逐 provider）

| provider / 适配器 | 原始响应里读的字段 | 代码证据 | 归一后 | 真实样本 |
|---|---|---|---|---|
| **DeepSeek**（`DeepSeekProvider(OpenAIProvider)`，chat 协议） | `usage.prompt_cache_hit_tokens`；按 DeepSeek 语义 `prompt_tokens = hit + miss`，因此分母直接用 `prompt_tokens`（`model_wrapper.py:57-59` 的非 Anthropic 分支） | AgentScope `_deepseek/_model.py:281-287`；QwenPaw `adapters/usage.py:42` | `cache_read_tokens`；`cache_eligible = prompt_tokens` | 本机无 deepseek 会话 |
| **OpenAI 兼容 chat**（`OpenAIProvider`、`KiloProvider`、`OpenCodeProvider` 的 chat 模型、`OpenRouterProvider`、自建兼容端点如 SenseNova——其协议未在本机确认） | `usage.prompt_tokens_details.cached_tokens`；QwenPaw 兼容层还接受 `input_tokens_details.cached_tokens` | AgentScope `_openai_chat/_model.py:354-365`；QwenPaw `adapters/usage.py:38-44` | 同上 | **Kilo：96 轮**（web 95 + console 1） |
| **OpenAI Responses** | `usage.input_tokens_details.cached_tokens`（也接受 `prompt_tokens_details` 形式） | QwenPaw `adapters/usage.py:38-44`；`wire_protocol.py:266-278` | 同上 | 无 |
| **Anthropic** | `usage.cache_read_input_tokens`、`usage.cache_creation_input_tokens`；**`input_tokens` 不含这两项** | AgentScope `_anthropic/_model.py:383-399`；QwenPaw `wire_protocol.py:263-265`（`prompt += read + write`） | read/write 分别落 `cache_read_tokens` / `cache_write_tokens`；`eligible = prompt+read+write` | 无 |
| **DashScope** | `usage.prompt_tokens_details.cached_tokens` | AgentScope `_dashscope/_model.py:326-329` | 同 OpenAI 兼容 | 无 |
| **Gemini** | `usage.cached_content_token_count` | AgentScope `_gemini/_model.py:528-531` | 同 OpenAI 兼容（eligible=prompt） | 无 |
| **Moonshot** | `usage.prompt_tokens_details.cached_tokens` | AgentScope `_moonshot/_model.py:290, 399` | 同 OpenAI 兼容 | 无 |
| **xAI** | `usage.cached_prompt_text_tokens` | AgentScope `_xai/_model.py:386-389, 438-441` | 同 OpenAI 兼容 | 无 |
| **Volcengine** | `usage.prompt_tokens_details.cached_tokens` | AgentScope `_volcengine/_model.py:287, 394` | 同 OpenAI 兼容 | 无 |
| **适配器不在白名单** | 不读 | `model_wrapper.py:19-49`（MRO 模块前缀白名单） | `cache_observed=false`，read/write 清零（`:138-140`） | — |

补充：

- **`prompt_cache_miss_tokens` 从未被读取。** `grep -rn prompt_cache_miss_tokens` 在
  `qwenpaw-ref`、AgentScope 安装包、本仓库中只命中 `tasks/m28-usage-v3-task.md:14`。
  DeepSeek 的 miss 只能用 `eligible - read` 推导。
- **`cache_write_tokens` 的读取顺序**：先 `details.cache_write_tokens`，再退回
  原始 `usage.cache_write_tokens`（`adapters/usage.py:45-47`）。DeepSeek/OpenAI 一般没有；
  Anthropic 有。
- **两个归一入口**：chat 协议走 `cache_usage()`（`openai_chat_model_compat.py:886-892,
  903-913`）；非 chat 协议先在 `wire_protocol.py:255-280` 把
  anthropic/responses 的用量改写成 `prompt_tokens_details`，语义一致。

### 2.3 本项目在用的 provider：实际结论

**(a) Kilo — 唯一有真实样本的 provider**

- 类型：`KiloProvider(_FreeSuffixProviderMixin, OpenAIProvider)`
  （`qwenpaw-ref/src/qwenpaw/providers/openai_provider.py:1007`；
  catalog `providers/provider_catalog.py:273-278`），走
  `OpenAIProvider.get_chat_model_instance` → `OpenAIChatModelCompat`
  （`openai_provider.py:514-557`）。
- 因此它能上报的缓存字段只可能是 OpenAI 风格的
  `prompt_tokens_details.cached_tokens`；插件可见的 95 个 web 轮全部
  `cache_observed=true`、共 341,141 命中 token（连 console 那 1 轮为 96 轮 / 341,653），
  说明该网关确实返回了这个字段。
- 真实数值（session 文件）：`cache_read_tokens` 每轮 0–40,896 不等；`cache_write_tokens`
  全 0；`cache_eligible_input_tokens == prompt_tokens`（96/96）。

**(b) OpenCode — 同一路径，但可能逐模型路由到 Anthropic**

- 内置 provider（`provider_catalog.py:256-266`），默认 `chat` 协议，字段同 Kilo。
- 但 `OpenCodeProvider.model_protocol()` 会按 catalog 把个别模型路由到 `anthropic`
  （`openai_provider.py:951-985`）；这些模型的原始字段变成
  `cache_read_input_tokens` / `cache_creation_input_tokens`，归一后仍是同一形状。
- **本机没有 OpenCode 会话样本**，无法给出真实数值；字段结论来自代码路径。

**(c) SenseNova — 没有内置定义，也没有本机会话样本**

- `qwenpaw-ref` 的 builtin catalog 里没有 `sensenova`（`grep -rli sensenova src packages
  console deploy` 无命中）；本仓库能看到的只有截图里的 UI 文本
  `tests/mobile-shots/before-diagnostics.json:237`（“sensenova / deepseek-flash”）。
- 按 QwenPaw 的自定义 provider 机制，它可能走 OpenAI 兼容协议（字段
  `prompt_tokens_details.cached_tokens`），也可能走 Anthropic 兼容协议（字段
  `cache_read_input_tokens` / `cache_creation_input_tokens`）；**本机没有它的配置或样本，
  无法确认是哪一种**（其他协议见 §2.2 对应行）。
- 无论哪种路径，归一后都是同一形状；若该端点不返回缓存字段 →
  `cache_observed=false` → **不报告缓存**（不是 0）。
- 这条结论没有真实样本，属于“代码路径 + 证据缺口”，不应在 UI 上替它编造数字。

**(d) 明确列为「不报告缓存」的情况**

1. OpenAI 兼容端点没有返回 `prompt_tokens_details.cached_tokens`。是否上报取决于端点本身
   （Ollama 也走同一条 `OpenAIChatModelCompat` 路径：`ollama_provider.py:84-101`）；
   本机无 Ollama/LM Studio 样本，不臆断它们一定没有，只按 `cache_observed` 说话。
2. 模型类不在 `_CACHE_USAGE_MODEL_MODULES` 白名单里（`model_wrapper.py:19-49`）。
3. provider 报了缓存字段但 `read+write > prompt`（非 Anthropic 的保护，`model_wrapper.py:57-58`）
   → 视为不可信，`cache_observed=false`。

以上都落成 `cache_observed=false` + `cache_read_tokens=0` +
`cache_eligible_input_tokens=0` + `cache_hit_rate=null`，**插件必须整组省略，不能报 0%**。

### 2.4 “报 0”与“没报”的判别（有测试佐证）

- `cache_usage()` 的观测标志：
  `cache_usage_observed = any(type(count) is int and count >= 0 for count in (read, write))`
  （`adapters/usage.py:48-53`）。
- `_record_usage` 再叠加一层：metadata 明确 `cache_usage_observed is False` 时强制
  `cache_observed=false` 并把 read/write 清零（`model_wrapper.py:131-140`）。
- QwenPaw 测试 `test_raw_cache_presence_controls_observation`
  （`qwenpaw-ref/tests/unit/token_usage/test_token_usage.py:1059-1085`）对
  `reported=None/0/80` 断言：`None` → `cache_observed=false, eligible=0`；
  `0` → `cache_observed=true, eligible=100`。**所以 0 是真 0%，缺字段才是“不报告”。**
- 本机真实数据里 `m2main` 首轮就是 `cache_observed=true` + `cache_read_tokens=0`（真 0%），
  不能把它从分母里剔掉。

### 2.5 换算时最容易踩的四个坑

1. **用 `prompt_tokens - cache_read` 当未命中**：OpenAI/DeepSeek 可以，Anthropic 不行——
   它的 `prompt_tokens` 不含 read/write，减出来会偏小甚至为负。统一用
   `cache_eligible_input_tokens - cache_read_tokens`。
2. **把 `session_cache_*` 当每轮值累加**：它是会话累计快照。实测 `m2main` 10 轮逐轮
   `cache_read` 合计 39,024，正好等于最后一轮的 `session_cache_read_tokens=39,024`
   （eligible 同为 157,799）；38/38 个文件都满足这个等式。求和 session 值会平方级放大。
3. **把 `cache_hit_rate` 当 0–1 比例**：它是 0–100 的百分数；而且**不能对逐轮 rate 求平均**，
   必须用 `sum(read)/sum(eligible)` 重算（大轮次应占更大权重）。
4. **把“没报”当 0**：见 §2.4；缺 `cache_observed`（旧记录）也按“没报”处理。

---

## 3. 探查项 2 — 每轮的模型归属

### 3.1 结论：每轮都有实际模型，且会和 chat 当前模型不同

证据链：

1. 记录点：`model_name=self.model`、`provider_id=self._provider_id`
   （`model_wrapper.py:142-156`，写进 `_UsageEvent`；同一值写进 session 收据
   `:160-163`）。`self.model` 来自被包装的具体 model 实例
   （`model_wrapper.py:76-84`），不是 chat 配置的拷贝。
2. 落盘：原始 96/96、插件可见 95/95 轮的 `usage` 都同时带 `provider_id` 和 `model_name`
   （真实样本 key 计数）。
3. 真实反例（`m2main`，10 轮）：

   | 时间 | provider | model | prompt | cache_read |
   |---|---|---|---|---|
   | 2026-10-26 15:51 | kilo | kilo-auto/free | 15,438 | 0 |
   | …（前 6 轮同） | kilo | kilo-auto/free | … | … |
   | 2026-10-27 05:29 | kilo | openrouter/free | 15,013 | 0 |
   | …（后 4 轮同） | kilo | openrouter/free | … | … |

   而 chat 级当前模型只有
   `~/workspace/qwenpaw-local/home/workspaces/default/agent.json:621-624`：
   `active_model = {provider_id:"kilo", model:"openrouter/free"}`。
   **若用 chat 当前模型回填，这个 chat 的前 6 轮会全部错标。**
4. 反过来，同一个 chat 的历史轮次本来就可能跨多个模型；不存在一个 chat 级模型能代表全部历史
   （`m2main` 本身就是证据：6 轮旧模型 + 4 轮当前模型）。

### 3.2 三个归属缺口（必须在统计口径里写明）

1. **一轮多次模型调用（工具循环）**：`_store_usage` 只累加 5 个数字字段
   （`model_wrapper.py:208-217`），`model_name/provider_id` 不参与合并，保留的是
   **最后一次调用**的模型（`:195-231`）。因此：
   - token 是整轮所有调用的总和；
   - 模型标签是最后一次调用的模型；
   - 若一轮内真的换了模型，这轮 token 会全部记到最后一个模型上。
   本机 web 95 轮里有 **18 轮**是多调用轮（`prompt_tokens != last_prompt_tokens`，例如
   `m2file` 的 24,586 vs 12,341），但无法从落盘数据判断这些轮内部是否换过模型。
2. **估算轮**：`_turn_from_stats()` 生成的收据 `provider_id=""`、`model_name=""`、
   `estimated=true`（`turn_usage.py:40-58`）。本机 0 轮，但代码路径存在。
3. **字面 “unknown”**：`ChatModelBase` 构造时缺 `model` 属性会退化成 `"unknown"`
   （`model_wrapper.py:76-83`）。这属于“模型未知”，不是真模型名。
4. **根本没有收据的轮次**：`resolve_turn_usage` 返回 `(None, None)` 时调用方直接返回，
   不写 metadata（`base.py:1951-1961`）；有 `context_usage` 但 `usage: null` 时，
   插件 `message_usage()` 也返回 `None`（`plugin/util.py:1162-1169`）。
   这类轮次**连 turns 都不计**，与“未知模型桶”不是一回事。

另外：旧版本可能只有 `message.usage` 而没有 `qwenpaw_turn_usage`（本机 96/96 两者都有，
无样本）。M24 的现状是**只认 metadata**，因此这类轮次目前不计入；M28 不要顺手加
`message.usage` 兜底，否则会改变 M24 基线（且兜底记录没有 `cache_observed`，缓存仍不可用）。

### 3.3 “未知模型”桶的定义（建议，供实现）

- 分组键：`(provider_id, model_name)`；展示串为 `provider / model`
  （provider 为空时只显示 model）。
- 归入未知桶的条件：`model_name` 缺失 / 空串 / 等于 `"unknown"`。
- 未知桶必须**计入** `totals` 与 `by_model`（否则
  `sum(by_model.input) != totals.input`），展示名 `未知模型`；其缓存字段按
  `cache_observed` 正常处理（估算轮通常没有缓存 → 整组省略）。
- **严禁**用 chat 当前模型、`active_model` 或“最近一次模型”回填未知轮次；
  这会把历史错误伪装成事实。

---

## 4. 探查项 3 — Turso 归档 vs session 文件

### 4.1 Turso 里根本没有 usage

- 插件归档的 schema（`plugin/turso_archive.py:33-40`）只有：

  ```sql
  chats(chat_id TEXT PRIMARY KEY, agent_id TEXT, created_at INTEGER,
        updated_at INTEGER, title TEXT)
  messages(id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL,
           role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL)
  ```

- 写入的也只有这两张表：`user_requests()` / `assistant_requests()`
  （`turso_archive.py:150-169`），内容是纯文本
  （用户文本 + 附件名；助手最终文本）。
- 读取工具同样只查这两张表（`tools/turso_history.py:35-41`）。
- **线上库实测（只读查询，2026-10-30）**：
  `sqlite_master` 只有 `chats`、`messages`、`sqlite_sequence`；
  `messages` 列为 `id, chat_id, role, content, created_at`；共 390 行消息。
  没有 `qwenpaw_turn_usage` 表，也没有任何 provider/model/cache 列。
- 因此任务书里的 “M15 的 `qwenpaw_turn_usage`” 指的是 **session 文件里 message.metadata
  的 key**（`turn_usage.py:14`；插件 `util.py:1105`），**不是 Turso 表**。

### 4.2 归档本身也不适合当统计源

- fire-and-forget + 有界队列：队列满直接丢批（`turso_archive.py:284-292`）；
  失败重试 2 次后丢弃（`:317-332`）。
- 只归档“用户文本 / 助手最终文本”，不归档 turn 收据、tool 过程、模型、token。
- 结论：Turso 归档是**全文检索/历史浏览**的副本（M6/M13 用途），不是账本。

### 4.3 第三个数源：`token_usage.json`（不要混用）

- 位置：`~/workspace/qwenpaw-local/home/token_usage.json`；结构是
  `{日期: {"agent\x1fprovider\x1fmodel": {provider_id, model_name, prompt_tokens,
  completion_tokens, cache_read_tokens, cache_write_tokens,
  cache_eligible_input_tokens, cache_observed_calls, call_count, agent_id}}}`
  （写入逻辑 `buffer.py:195-236`）。
- 实测：128 次调用（`call_count` 合计）、input 1,701,016、output 19,940、
  cache_read 350,085。原始 38 个 session 文件（含 console）是 96 **轮**、
  1,662,549 / 12,335 / 341,653（同轮多调用已合并），两者本来就不是同一粒度；
  即便如此 token 总量仍差 **38,467 input、7,605 output、8,432 命中**，无法一一对上。
- 差异的机制：`_record_usage` 先把事件入队（`model_wrapper.py:157-158`），
  之后 `_store_usage` 才检查 session id（`:195-198`）；没有 session 的调用
  （后台任务/无会话调用）只进 `token_usage.json`，不会出现在任何 chat 的收据里。
  也可能是会话被删/被 compaction 截断——无论哪种，它**无法归属到 chat**。
- 它还是 **call 级**（一次工具循环算多次），而 session 收据是 **turn 级**（同轮调用已合并）；
  没有 per-chat/per-turn 维度，也没有消息时间（只有天）。
- 所以：可拿它做总量旁证，**绝不能与 session 文件相加**（会重复计数），
  也不能用它做 `by_model` 的唯一来源（它会包含无 chat 的后台调用，与 `totals` 口径不一致）。
- 旁证：QwenPaw 自己的 `agent_stats` 的缓存口径也是读 session 文件、并且要求
  `cache_observed` 且 `eligible > 0`（`qwenpaw-ref/src/qwenpaw/agent_stats/service.py:135-157,
  238-244`），命中率同样是 `read/eligible*100`（`:498-507`）。

### 4.4 `history.db`（scroll）也不是数源

`scroll` 序列化只保留 tag 与 tool-call extras，**丢弃其余 metadata**
（`qwenpaw-ref/src/qwenpaw/agents/context/scroll/serialize.py:236-251`）；
`conversation_history` 没有 usage 列，它虽有一个 `metadata TEXT` 列
（`scroll/history.py:653-670`），但上面的序列化不会把 `qwenpaw_turn_usage` 放进去。
因此 `qwenpaw_turn_usage` 不会进 history.db，更不会进 Turso。

### 4.5 结论：stats 以 session 文件为准

理由按优先级：

1. **唯一含 per-turn usage + provider/model + cache 语义的持久化记录**（§2.1、§3.1）。
2. **Turso 没有任何 usage 列**（§4.1），物理上不可能作为数源。
3. **归档是 best-effort 且会丢批**，session 文件是 QwenPaw 自己每轮同步写的主存储
   （`base.py:1951-1971`）。
4. 与 M24 现状、QwenPaw 自身 `agent_stats` 口径一致，改动最小。

已知代价（沿用 M24，不新增）：QwenPaw compaction 掉的早期轮次、未落盘的回复、没有
session 文件的 chat 不在数字里——`uncovered_chats` 已在协议 §14.3 说明。M28 不改变这个覆盖口径；
`token_usage.json` 里那些“无 chat 调用”也不应被拉进来假装成某个 chat 的用量。

---

## 5. 对实现的硬约束与建议（SESSION 2 定稿）

### 5.1 逐轮换算规则（建议写进协议 §14）

对每个有 `usage` 的 assistant 轮：

```text
observed  = usage.cache_observed is True
hit       = usage.cache_read_tokens                # int >= 0，仅 observed 时可信
eligible  = usage.cache_eligible_input_tokens      # int > 0 才可用于比率
miss      = eligible - hit                         # 仅 observed 且 eligible > 0
rate      = hit / eligible * 100                   # 百分数，仅 eligible > 0
```

- `observed=false` 或 `eligible<=0`：该轮**不进入任何缓存分子/分母**，也不产生
  `cache_hit/cache_miss/rate`；绝不当 0。
- 聚合永远用整数和再算比率：
  `global_rate = Σhit / Σeligible * 100`，**不要平均逐轮 rate**。
- 本机插件口径验证：`Σhit=341,141`、`Σeligible=1,648,974` → 20.69%（95 轮）；
  逐轮 `cache_hit_rate` 与 `read/eligible*100` 在 96/96 原始轮次上完全一致。

### 5.2 `input` 的口径：保持 M24 的 `prompt_tokens`，另给 `cache_eligible`

- 本机插件口径 95/95 轮（原始 96/96）`eligible == prompt_tokens`（Kilo/OpenAI 语义），
  所以两种口径数字相同。
- 但 Anthropic 的 `prompt_tokens` 不含 read/write（§2.2），此时
  `hit + miss == eligible > input`。为避免“卡片数字加不起来”或偷偷改 M24 基线，建议：
  - `input` 继续 = `Σ prompt_tokens`（与 M11 `usage`、M24 `stats` 完全兼容；
    现有实现见 `plugin/util.py:1250-1312` 的 `session_usage`）；
  - 新增 `cache_hit`、`cache_miss`、`cache_eligible`、`cache_hit_rate`；
  - 协议注明 `cache_hit + cache_miss == cache_eligible`，OpenAI/DeepSeek 下
    `cache_eligible == input`，Anthropic 下可能大于 `input`。
- 若实现时决定把 `input` 改成 cache-aware 总量（eligible），必须同步改
  `usage` 帧与 M24 的一致性断言，属于破坏性语义变更，**不建议在 M28 做**。

### 5.3 `by_model` 口径

- 分组键 `(provider_id, model_name)`；每项
  `{provider?, model, turns, input, output, cache_hit?, cache_miss?, cache_eligible?, cache_hit_rate?}`。
- `model` 为空/`"unknown"` → 未知模型桶（§3.3），仍计入 totals。
- 缓存字段按 §5.1 的 observed 规则整组出现或整组省略。
- 排序按 `input` 降序（任务书要求）；并列时按 `turns` 降序、模型串升序（稳定）。
- 一致性断言：`Σ by_model.input == totals.input`、`Σ by_model.output == totals.output`、
  `Σ by_model.turns == totals.turns`。未知桶是这条断言能成立的前提。

### 5.4 其他沿用项

- `stats` 仍是控制帧：无 `seq`、不重放、必答、最差 `{"t":"stats"}`（协议 §14.4）。
- 复用 `SessionUsageStore` 的 `(mtime_ns, size)` 缓存，不新增全量扫描。
- `session_cache_*` **不参与任何 sum**；`cache_hit_rate` 不从它推导。
- 日桶缓存列可选：数据现成（同一轮摘要），但要注意某天可能只有部分轮次
  observed，日 `cache_eligible` 会小于日 `input`；UI 若叠加缓存段，应按
  `hit/eligible` 画，不要假设 `hit+miss==input`。

### 5.5 建议的帧字段（草案，待 SESSION 2 写进 `protocol/frames.md` §14）

```json
{"t":"stats","id":"…",
 "totals":{"turns":95,"input":1648974,"output":12314,
           "cache_hit":341141,"cache_miss":1307833,"cache_eligible":1648974,
           "cache_hit_rate":20.69},
 "by_model":[
   {"provider":"kilo","model":"openrouter/free","turns":52,"input":892049,
    "output":6330,"cache_hit":26038,"cache_miss":866011,
    "cache_eligible":892049,"cache_hit_rate":2.92},
   {"provider":"kilo","model":"kilo-auto/free","turns":43,"input":756925,
    "output":5984,"cache_hit":315103,"cache_miss":441822,
    "cache_eligible":756925,"cache_hit_rate":41.63}
 ],
 "days":[…],"chats":[…],"covered_chats":37,"day_basis":"container-local"}
```

> 上面 `by_model` 的数值是用本机真实数据按 §5.1 公式算出的**口径示例**（插件口径：
> 37 个 web 文件 / 95 轮 / 37 个 chat；kilo 两个模型），不是最终帧
> （最终字段名/是否带 `cache_eligible` 由 SESSION 2 定）。
> `cache_miss` 为 `eligible-hit`，因此 `hit+miss == eligible`。

---

## 6. 附录：证据与复现

### 6.1 关键代码位置索引

> 下表 `qwenpaw-ref/…` = `~/workspace/qwenpaw-ref/…`；
> `…/site-packages` = `~/workspace/qwenpaw-local/venv/lib/python3.12/site-packages`。

| 主题 | 位置 |
|---|---|
| 原始字段 → 归一 | `qwenpaw-ref/src/qwenpaw/providers/adapters/usage.py:34-59`（42/44/45/47/50-52） |
| 非 chat 协议改写 | `qwenpaw-ref/src/qwenpaw/providers/adapters/wire_protocol.py:255-280` |
| 缓存可用性/分母 | `qwenpaw-ref/src/qwenpaw/token_usage/model_wrapper.py:19-59` |
| 每轮收据组装 | `qwenpaw-ref/src/qwenpaw/token_usage/model_wrapper.py:107-184` |
| 多调用合并（last model wins） | `qwenpaw-ref/src/qwenpaw/token_usage/model_wrapper.py:195-231` |
| 收据 key / 未知模型 / 会话累计 | `qwenpaw-ref/src/qwenpaw/token_usage/turn_usage.py:14, 40-58, 73-126, 248-264, 300-334` |
| 按天聚合 | `qwenpaw-ref/src/qwenpaw/token_usage/buffer.py:18-31, 195-236` |
| DeepSeek 原始字段 | `…/site-packages/agentscope/model/_deepseek/_model.py:281-287` |
| OpenAI chat 原始字段 | `…/site-packages/agentscope/model/_openai_chat/_model.py:354-365` |
| Anthropic 原始字段 | `…/site-packages/agentscope/model/_anthropic/_model.py:383-399` |
| Kilo/OpenCode 定义 | `qwenpaw-ref/src/qwenpaw/providers/provider_catalog.py:256-278`；`openai_provider.py:930, 951-985, 1007` |
| 宿主自身缓存口径 | `qwenpaw-ref/src/qwenpaw/agent_stats/service.py:135-157, 238-244, 498-507` |
| 插件读收据 | `plugin/util.py:1105, 1151-1164, 1639`；`plugin/channel.py:1503-1583` |
| Turso schema/写入 | `plugin/turso_archive.py:33-40, 120-169, 284-292, 317-332`；`tools/turso_history.py:35-41` |
| history.db 丢弃 metadata | `qwenpaw-ref/src/qwenpaw/agents/context/scroll/serialize.py:236-251` |
| 插件 stats 契约现状 | `protocol/frames.md:697-765` |

### 6.2 复现命令（只读）

```sh
# 1) 汇总本机所有 session 的收据字段 / 缓存 / 模型
cd ~/workspace/qwenpaw-local/home/workspaces
~/workspace/qwenpaw-local/venv/bin/python - <<'PY'
import json, glob
from collections import Counter
uk=Counter(); prov=Counter(); model=Counter(); obs=Counter()
tot=Counter()
for f in sorted(glob.glob('*/sessions/*/*.json')):
    for m in json.load(open(f)).get('agent',{}).get('state',{}).get('context',[]):
        u=((m.get('metadata') or {}).get('qwenpaw_turn_usage') or {}).get('usage')
        if not u: continue
        for k in u: uk[k]+=1
        prov[u['provider_id']]+=1; model[u['model_name']]+=1
        obs[u['cache_observed']]+=1
        tot['turns']+=1; tot['in']+=u['prompt_tokens']; tot['out']+=u['completion_tokens']
        tot['hit']+=u['cache_read_tokens']; tot['el']+=u['cache_eligible_input_tokens']
print(dict(uk)); print(prov); print(model); print(obs); print(dict(tot))
PY

# 2) 证明 session_cache_* 是累计值
#    对每个文件比较 last(session_cache_read_tokens) 与 sum(cache_read_tokens)
#    （本机 38/38 相等；m2main: 39024 == 39024）

# 3) Turso 线上 schema（只读；凭据只从 .secrets/turso.env 读，不打印）
~/workspace/qwenpaw-local/venv/bin/python - <<'PY'
import sys; sys.path.insert(0,'tools')
import turso_history as t
env=t.load_env('.secrets/turso.env')
print(t.run_query(env,"SELECT name,type FROM sqlite_master WHERE type IN ('table','view') ORDER BY name"))
print(t.run_query(env,"SELECT name FROM pragma_table_info('messages')"))
PY

# 4) 确认 miss 字段从未被读
grep -rn prompt_cache_miss_tokens ~/workspace/qwenpaw-ref \
  ~/workspace/qwenpaw-local/venv/lib/python3.12/site-packages/agentscope \
  ~/workspace/qwenpaw-webchannel
```

### 6.3 本机样本的完整 key 清单（真实出现）

原始 38 个 session 文件、96 轮**全部**出现下列 key（插件可见的 95 轮同样齐全）：

`provider_id, model_name, prompt_tokens, last_prompt_tokens, completion_tokens,
total_tokens, cache_read_tokens, cache_write_tokens, cache_eligible_input_tokens,
cache_observed, cache_hit_rate, context_size, compact_threshold,
session_cache_read_tokens, session_cache_eligible_input_tokens,
session_cache_observed, session_cache_hit_rate`（17 个）；
`context_usage` 下 `estimated_tokens, max_input_length, context_usage_ratio`（3 个）。

---

## 7. 后续 session 待办（已在 §8 完成）

- SESSION 2：插件实现（`by_model`、缓存聚合、未知桶、一致性测试）+ 协议 §14 增补。
- SESSION 3：SPA 统计视图重做（命中率大字卡、模型行、390px/深浅色）。
- SESSION 4：e2e/vitest/Playwright、ZIP 体积与 MD5、最终交付报告。

（以上已在 §8 完成；ZIP 构建按本次指令未执行。本节保留当时的计划原样。）

---

## 8. 实现（SESSION 2–4 + SESSION 5 收尾）

> **交接说明**：第一次实现 session 在跑完整 Playwright 套件之前被中断。磁盘上的交接状态是
> `plugin/tests/test_m28.py` ALL PASS、vitest 161/161，但 `tests/e2e_m19.mjs` 在手机 pass
> 的 M28 主题证据块稳定超时（`waitForSelector('.md pre .pre-copy')`）。本 session 复现并
> 定位该失败（§8.6），确认是**测试编排**问题而不是产品缺陷；修好证据块后跑通全部套件
> （§8.5）并补写本节。**没有提交，也没有构建插件 ZIP**（按本次指令）。

### 8.1 插件改动

| 文件 | 改动 |
|---|---|
| `plugin/util.py` | 逐轮缓存/模型提取，per-file 汇总新增 `models`、缓存三元组；跨文件聚合新增 `by_model` 与一致性排序 |
| `plugin/frames.py` | `stats_frame(..., by_model=)`；totals / days / by_model 的缓存组统一校验并重算命中率 |
| `plugin/channel.py` | `_handle_get_stats` 行为不变，仅更新 docstring（控制帧语义、缓存口径） |
| `protocol/frames.md` | §14.1 帧示例与字段表扩展；新增 §14.5 缓存口径、§14.6 按模型拆分 |
| relay | **无改动**（`stats` 仍由 relay 原样转发） |

`plugin/util.py` 的落点（行号为本次实现后）：

- `STATS_UNKNOWN_MODEL = "未知模型"`（`:1121`）——未知模型桶的唯一展示名。
- `_turn_cache(usage)`（`:1184`）——把一轮换算成 `(hit, miss, eligible)` 或 `None`：
  只有 `cache_observed is True`、`eligible > 0`、`hit <= eligible` 才可用；
  `miss = eligible - hit`，**从不**用 `prompt_tokens - hit`。
- `_turn_model(usage)`（`:1207`）——取该轮自己的 `provider_id` / `model_name`；
  空串、缺失或字面 `"unknown"` 归一成未知桶 `("", "")`。
- `session_turn_summary(messages)`（`:1747`）——除 totals/days 外，每个模型桶累加
  `turns / input / output / cache_*`；`session_cache_*` 完全不读、不求和。
- `aggregate_usage_stats(...)`（`:1929`）——折叠 per-file summary：
  `_add_cache_fields` 只在三元组完整时整组累加；`_set_cache_rate` 用整数和
  `Σhit / Σeligible * 100`（保留 2 位）重算；`by_model` 按
  `input desc → turns desc → model → provider` 排序、不设上限；
  `_summary_models` 会再次规整手写 summary 里的空/`unknown` 模型，保证未知桶存在。
- 一致性由构造保证：每一轮恰好进入一个 `(provider, model)` 桶，因此
  `Σ by_model.turns/input/output/cache_* == totals.*`。

`plugin/frames.py`：

- `_stats_cache(raw)`（`:432`）——三键齐全、`eligible > 0` 且
  `hit + miss == eligible` 才输出；`cache_hit_rate` **重新计算**，帧里带来的 rate 只作参考。
  不完整/自相矛盾的组整组丢弃（“没上报”保持缺省，绝不写成 0）。
- `_stats_models(raw)`（`:477`）——丢弃无 `model` 或无 `turns` 的行；provider 为空则省略；
  按 `_stats_model_rank`（`:512`）重排，未知桶按普通行保留。
- `stats_frame(..., by_model=None)`（`:522`）——`by_model` 仅在可清洗时出现；
  `totals` 与每个 `days[]` 复用同一套缓存校验；`{"t":"stats"}` 最差回复保持兼容。

`plugin/channel.py` 的 `_handle_get_stats`（`:1503`）仍复用
`SessionUsageStore.stats_entries` 的 `(mtime_ns, size)` 缓存，控制帧不占 `seq`、不进 ring
buffer、不在 `resume` 重放；没有新增扫描路径。

### 8.2 字段换算规则（实现口径）

对每轮 `message.metadata.qwenpaw_turn_usage.usage`：

```text
observed = usage.cache_observed is True          # 严格 True；缺失/false 一律“没上报”
hit      = usage.cache_read_tokens               # int >= 0
eligible = usage.cache_eligible_input_tokens     # 必须 > 0
miss     = eligible - hit                        # 仅此一种推导
rate     = hit / eligible * 100                  # 百分数 0–100，保留 2 位
```

- 该轮进入缓存分子/分母的**唯一**条件是 `observed && eligible > 0 && hit <= eligible`；
  否则整轮不贡献缓存字段，但仍计入 `turns / input / output`。
- `0` 是真值：`cache_observed=true, cache_read_tokens=0` 是 0% 命中，留在分母里。
- 三元组 all-or-nothing：`cache_hit`、`cache_miss`、`cache_eligible`、`cache_hit_rate`
  同时出现或同时缺席，且 `cache_hit + cache_miss == cache_eligible`。
- 全局/按天/按模型的命中率都用整数和重算，**不对逐轮 rate 求平均**；
  三个边界（`util` 聚合、`frames` 出帧、SPA 投影）都会各自再算一次。
- `input` 保持 M24 语义 `Σ prompt_tokens`，与 M11 `usage` / M24 `stats` 兼容；
  `cache_eligible` 是独立分母。OpenAI/DeepSeek 下两者相等，Anthropic 下
  `prompt_tokens` 不含 read/write，可能 `cache_eligible > input`；
  客户端不得假设 `hit + miss == input`。
- 模型归属取每轮记录的 `provider_id` / `model_name`（调用时的模型实例），
  **不用 chat 当前模型回填**；一轮多次模型调用时 token 是整轮总和、模型标签是最后一次调用
  （QwenPaw 的合并方式），这是已知口径并在协议 §14.6 写明。
- 未知桶 `未知模型` 计入 totals 与 `by_model`，因此一致性等式始终成立；
  `provider` 为空时该字段省略，而不是发空串。
- 旧记录若只有 `message.usage` 而没有 `qwenpaw_turn_usage`，仍按 M24 口径**不计入**
  （不加兜底，避免改变基线；这类记录也没有 `cache_observed`，缓存不可用）。

### 8.3 协议文档

`protocol/frames.md` §14 现在是：

- §14.1：`stats` 示例带 `totals.cache_*`、`by_model[]`、`days[].cache_*`，字段表说明
  “缓存四键成组出现、缺省即没上报”；
- §14.5：逐 provider 的原始字段 → 归一字段表（DeepSeek `prompt_cache_hit_tokens`、
  OpenAI 兼容 `prompt_tokens_details.cached_tokens`、Anthropic
  `cache_read_input_tokens` / `cache_creation_input_tokens` 等），以及 §8.2 的全部规则；
- §14.6：`by_model` 的分组键、未知桶、排序、`Σ by_model == totals` 的一致性保证、
  多调用轮次与缓存缺省的含义。

### 8.4 SPA 改动

`spa/src/lib/stats.ts`（纯投影，仍不依赖 React）：

- 新类型 `StatsCache`（`hit/miss/eligible/rate`）与 `StatsModel`；
  `UsageStats.byModel`、`StatsDay.cache`、`StatsBar.hitRate`。
- `cacheOf()`（`:118`）——与插件同一套校验；不完整/矛盾的组返回 `undefined`，
  送达的 `cache_hit_rate` 忽略，rate 用整数和重算。
- `modelsOf()`（`:229`）——丢弃无模型名/无轮次的行，保留 `未知模型`，按
  `input desc → turns desc → model → provider` 重排。
- `formatRate()`（`:281`）——一位小数 + `%`；未知显示 `—`（不是 `0%`）。
- `statsBars()`（`:292`）——日柱额外带 `hitRate`；重复日期合并时用 `addCache` 相加再重算。

`spa/src/App.tsx`：

- `RateBar`（`:1195`）与 `StatsModelRow`（`:1205`）：5 张卡（输入 / 输出 / 缓存命中 /
  缓存未命中 / 缓存命中率），命中率卡是大字 + 细条；模型行显示
  provider / model、轮次、入/出、命中与命中率条，无缓存数据显示 `—`。
- `StatsChart`（`:1241`）：每天柱下加一条按 `cache_eligible` 画的缓存细条，
  图例写明 “n/N 天有上报”；没有引入图表库。
- `StatsView`（`:1304`）：顶部一行 `轮次 / 会话 / 未覆盖` 摘要；按模型区带口径注；
  basis 增补缓存与模型归属两段说明。

`spa/src/App.css`：卡片网格从 4 列改为 5 列；≤720 px 时回到 2 列且命中率卡独占整行；
模型行桌面为 `名称 | 数字 | 率条` 三列，手机为名称+率条一行、四个数字换行；
缓存细条、图例、口径注均为新增样式。没有新增运行时依赖。

390 px 深/浅色证据截图（`tests/m19-shots/`）：
`m28-stats-mobile-dark.png`、`m28-stats-mobile-light.png`（无横向溢出，命中率卡 366×105）。

### 8.5 测试结果

| 套件 | 命令 | 结果 |
|---|---|---|
| 插件全量 | `~/workspace/qwenpaw-local/venv/bin/python plugin/tests/test_*.py`（逐个） | **19/19 套件 ALL PASS** |
| 插件 M28 | `plugin/tests/test_m28.py` | **19 个测试全过** |
| vitest | `cd spa && npx vitest run` | **11 个文件 / 161 个测试全过**（M28 新增 7 个） |
| Playwright | `node tests/e2e_m19.mjs` | **338 项检查 / 0 失败**，150.9 s |

Playwright 的 338 项 = desktop 163 + mobile 174 + 1 项浏览器 UTF-8 下载名探针。
M28 覆盖：5 张卡与缓存数字、命中率条（20.69%）、3 行模型（含 `未知模型` 的 `—`）、
按 `cache_eligible` 画的日缓存条与图例、以及手机深浅色两张证据图的
“5 卡 / 3 模型 / 无横向溢出”断言。本次收尾只改了证据块的导航，没有改写任何断言；
338 相对 M27 的 318 来自第一次实现 session 的 M28 断言改写（如 4 卡 → 5 卡）与新增项，
本 session 没有放宽或删除任何既有断言。

插件 M28 的 19 个测试覆盖：DeepSeek / OpenAI / Anthropic 三种 provider 形状、
无缓存字段与 `cache_observed=false` 的省略、真 0 与没上报的区分、
`session_cache_*` 不参与求和、整数和重算命中率、`by_model` 与 totals 的
turns/input/output/cache 全等、未知桶、排序、帧清洗与向后兼容。

### 8.6 本次修复：Playwright 为什么在 reload 后找不到 `.pre-copy`

**现象**：手机 pass 在 M24 统计检查之后，`runM24Checks` 的 M28 主题证据块
`page.reload()` 后调用 `waitForHistory()`，`page.waitForSelector('.md pre .pre-copy')`
20 s 超时（`tests/e2e_m19.mjs:618`）。

**根因（测试编排，不是产品缺陷）**：

1. 证据块之前最后一步是 `clicking a ranked chat opens it`：点击排行第一的
   `Beta 会话`，断言 `activeChat === "chat-beta"`。这是有效断言，必须保留。
2. 随后 `page.reload()` 按设计恢复 `chat-beta`。
3. mock 的 `state.history["chat-beta"]` 是 `BETA_HISTORY`：24 条纯文本消息，
   **没有围栏代码块**；只有 `chat-alpha` 的 `HISTORY` 含 ` ```python `，才会渲染
   `.md pre .pre-copy`（复制按钮）。
4. `waitForHistory()` 用 `.pre-copy` 作为“历史已渲染”的就绪信号，所以恢复
   `chat-beta` 的页面永远等不到它——稳定失败，且只在手机 pass（该证据块 `if (mobile)`）。

**修复**：在进入主题循环前，把 `webchannel.activeChat` 设为 `chat-alpha`
（`tests/e2e_m19.mjs:1867`），让每次 reload 恢复一个历史已知含代码块的会话；
`waitForHistory()` 的严格断言原样保留。第一次尝试用 `openChat()` 点侧栏行时还发现：
M23.5 的归档搜索框仍保留 `归档专属`，侧栏被过滤成 0 行，点不到任何会话；因此改用
M26 证据块同样的 localStorage 恢复路径，避免依赖当时的内存筛选状态。

**证据**：修复前完整跑 = 281 PASS / 0 FAIL 后在该行 fatal（desktop 全绿）；
修复后 = 338 PASS / 0 FAIL。该修复没有增删任何 `check()`，只改导航方式。

### 8.7 边界与未做

- 未提交、未构建 ZIP、未触碰托管环境（按本次指令）。
- 继承 M24 的覆盖口径：被 compaction 截断的早期轮次、未落盘的回复、
  没有 session 文件的 chat 不在数字里；`uncovered_chats` 只在会话列表可读时出现。
- 多调用轮的模型标签是最后一次调用；估算轮（`estimated=true`）归入未知模型桶；
  无 `qwenpaw_turn_usage` 的旧记录不计入（不加 `message.usage` 兜底）。
- `token_usage.json`（call 级、含无 chat 的后台调用）与 Turso 归档均不作为 stats 数源，
  理由见 §4；二者都不与 session 文件相加。
- 缓存为“按轮已上报”口径：没有上报的轮次不进分子分母，因此
  `totals.cache_eligible` 可能小于 `totals.input`（后者含未上报轮次）。
