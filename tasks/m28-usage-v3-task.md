# M28 — 用量统计 v3：缓存 token、命中率、按模型拆分

用户反馈：现在的用量管理「有一个屁用」。用户原话要求：「起码能看到缓存token，输入输出，缓存命中率，具体到模型啊」。

## 现状（M24，先核对）

- 插件 `get_stats`/`stats` 控制帧：totals（仅 input/output）、per-day（容器本地日历日）、top-10 chats、`uncovered_chats` 查不到时省略不报 0；聚合与 per-chat `usage_for` 总数相等已证明。
- SPA 有「用量统计」视图：总卡片 + 纯 CSS 日柱状图 + top chats 列表。
- per-turn usage 来自 workspace session 文件里每轮的 usage 记录（M15 已用它做 per-turn 收据锚定）。

## 探查任务（先查真实数据，字段不许编）

1. **缓存字段到底叫什么**：在真实 session 文件样本（仓库测试 fixtures、本地数据、能找到的真实样本）与 QwenPaw 参考源码（`~/workspace/qwenpaw-ref` 中 executor/usage 落盘代码）里，逐 provider 核对 usage 原始字段：
   - DeepSeek 风格：`prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`？
   - OpenAI 风格：`prompt_tokens_details.cached_tokens`？
   - 其他 provider（SenseNova/OpenCode/Kilo 等本项目在用的）各自的字段？
   每个结论引用实际文件/源码行。找不到缓存字段的 provider 就明确列为「不报告缓存」。
2. **每轮的模型归属**：session 文件/history 元数据里每轮是否记录了实际使用的 model？还是只有 chat 级当前模型？引用证据。若部分轮次无模型记录，归入「未知模型」桶并在报告与 UI 注明口径；严禁用 chat 当前模型静默冒充全部历史轮次的模型而不注明。
3. Turso 归档侧是否也存了 usage（M15 的 `qwenpaw_turn_usage`）？与 session 文件口径是否一致？stats 以哪边为准、为什么，写进报告。

## 插件改动

- 扩展 `stats` 帧（向后兼容加字段）： 
  - 全局：input、output、cache_hit、cache_miss（或 cached/input 推导）、cache_hit_rate——只在分子分母都已知时给，缺失就省略字段，**永不报假 0**；
  - `by_model` 数组：每模型 { model, turns, input, output, cache_hit, cache_miss?, hit_rate? }，按 input 降序；
  - per-day 如成本低可加 cache_hit 列；top chats 保持。
- **一致性证明**：sum(by_model.input) == totals.input、sum(by_model.output) == totals.output，测试里断言；缓存口径在协议文档 `protocol/frames.md` §14 补写清楚（每种字段来源如何换算成 hit/miss）。
- 沿用现有约定：控制帧不占序号、必答、未知省略、session 文件 (mtime,size) 缓存复用。

## SPA 改动

- 「用量统计」视图重做（沿用 M26 的扁平紧凑视觉语言）：
  - 顶部卡片：输入 / 输出 / 缓存命中 / 缓存未命中 / **缓存命中率**（大字百分比 + 小条）；
  - **按模型拆分**：每模型一行/卡：轮次、输入、输出、缓存命中、命中率条；无缓存数据的模型该列显示「—」并有口径注；
  - 日图与 top chats 保留（日图可叠加缓存命中段，能简单做就做，别为它引图表库）。
- 390px 手机宽度 + 深/浅色都要看；数字格式与现有 usage 格式函数一致。

## 测试与交付

- 插件新套件：fixtures 覆盖 DeepSeek 风格、OpenAI 风格、无缓存字段、字段缺失四类轮次；断言聚合相等、命中率计算、缺失省略。
- vitest 覆盖命中率/格式化；Playwright 覆盖统计视图渲染出模型行与命中率。
- 既有套件全绿并报数；构建插件 ZIP 报大小+MD5（托管安装由 Muse 另走浏览器流程，你不要动托管环境）。
- 报告写 `docs/m28-report.md`：字段证据表（provider→字段名→出处）、模型归属口径、换算规则、测试结果。
