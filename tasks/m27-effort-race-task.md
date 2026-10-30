# M27 — 思考等级「未生效 — no QwenPaw chat exists for this session yet」根治

用户反馈：这个报错现在很容易出现，尤其是刚打开网页的时候。用户原话：「现在改的怎么很容易出现 思考等级未生效 — no QwenPaw chat exists for this session yet 呢？尤其是刚打开网页的时候」。

## 已知背景（先核对，不要盲信）

- 思考等级走 QwenPaw 原生 per-session thinking API：GET/PUT `/api/chats/{id}/thinking`（M9 落地）。插件协议 v4：`get_effort` / `set_effort` / `effort` 帧 + `E_EFFORT` 错误，插件侧零状态。
- 已知 API 行为：PUT 对不支持的档位返回 422、对未知 chat 返回 404。
- SPA：分段控件（默认/低/中/高/最大），per-chat localStorage 保存用户选择，服务端确认值优先（server-confirmed wins）。
- 报错英文串 `no QwenPaw chat exists for this session yet` ——先定位它到底出自插件代码还是 QwenPaw 本体（grep 两边源码，`~/workspace/qwenpaw-ref` 有参考源码），引用文件+行号。

## 探查任务（先查后改，结论要有证据）

1. 追 SPA 侧全部触发点：页面打开/恢复 activeChat 时、切换会话时、切换模型时、新建会话时，分别在什么条件下会发 `get_effort` / `set_effort`？把调用路径列清楚（文件+函数）。
2. 追插件侧映射：SPA 的 session/chat id 如何映射到 QwenPaw chat？在哪些**正常**状态下 QwenPaw chat 尚不存在：
   - 新建会话还没发第一条消息；
   - 恢复的是一个从未发过消息的本地会话；
   - 离线/agent 离线时本地先建的会话；
   - 其他你查到的状态。
3. 判断：报错在这些状态下属于「预期状态被当成错误弹出」还是真失败？用户「刚打开网页就出现」最吻合哪条路径？给出复现步骤（测试里能重现的）。

## 修复要求

- **预期状态必须静默**：chat 尚不存在时不弹任何错误 toast；分段控件显示本地保存/默认的选择即可。
- **选择不能丢**：用户在 chat 存在之前选的思考等级，要被记住，并在 chat 真正创建后（如首条消息发出/服务端确认 chat 存在时）自动补发 `set_effort` 生效——补发逻辑要有明确触发点，不许靠定时器乱试。
- **真错误照常报错**：对已存在的 chat，用户主动改档被服务端拒绝（422 不支持该档等）仍要明确提示，与「尚不存在」严格区分。插件侧如需新增错误码（如把 not-created 与真失败分开），按现有协议约定做并更新 `protocol/frames.md`。
- 不许用「全局吞掉所有 E_EFFORT」这种假修复。

## 测试与交付

- 新增/更新测试：vitest 覆盖状态判定与补发逻辑；Playwright 复现「打开页面恢复未发送会话」「新会话先改档再发消息」两条路径——断言零错误弹窗、且首条消息后服务端确认的 effort 等于先选值（用现有 harness 的 mock 方式）。
- 既有全部套件保持全绿（插件 pytest、SPA vitest、Playwright 全量重跑并报数）。
- 报告写 `docs/m27-report.md`：根因（含证据引用）、触发路径表、修复设计、补发触发点、测试结果。
