# M39 — Agent 在线状态广播（presence），补上 M37 的已知边界

## 问题（M37 报告 §7 记录在案）

agent 在浏览器连接中途死掉（插件重启、容器重启、网络闪断导致插件掉线）时，浏览器无从得知：中继不广播 agent 的上线/下线，SPA 页眉继续显示「Agent 在线」，用户此时发消息只能靠 M37 outbox 的事后对账兜底（消息先写上 socket、恢复后 hist 对账确认，未确认的标红待手动处理）。中继其实全程知道 agent 槽位的状态变化，缺的只是把这个事实告诉客户端。

## 探查任务（先查清现状再设计）

1. relay-cf（Durable Object）：agent 槽位的生命周期事件点在哪——hello 赢得槽位、WS close、hb 连续丢失触发的重连/驱逐、世代更替（M7.1）；客户端连接建立时现在能拿到什么状态（status 帧的内容与时机）；`/health` 的 agentOnline 口径与槽位状态的关系。逐项引用文件+行号。
2. relay-node 同等问题（两边必须 lockstep，仓库既有规矩）。
3. SPA 现状：在线状态的判定来源（连接状态？status 帧？ready 帧的 agentOnline？）、M37 outbox 的入队/冲刷触发条件具体读的是哪个状态；未知 `t` 类型的帧 SPA 是否安全忽略（决定部署顺序是否安全）。
4. 插件侧：是否需要插件做任何事？（预期：不需要——agent 的上下线就是它与中继之间 WS 的连/断。核实这个预期，特别是「插件进程活着但 RelayClient 在重连间隙」时中继视角的状态。）

## 设计与实现要求

- 中继在**槽位持有者**状态转换时向所有已鉴权客户端广播 presence 帧（帧名与结构按现有协议约定，如 `{t:"status", agentOnline: bool}` 复用现有 status 语义优先——能复用就不新造）：上线（槽位被赢得且 hello 完成）→ online；下线（持有者 WS 关闭或被判死）→ offline。**停放的世代（parked generations）的任何事件不许触发广播**（M7.1 不变量）。
- 防抖：插件快速重连（重启窗口内 off→on 间隔很短）时，广播口径要明确——允许如实快速翻转，还是加一个小的下线宽限（如数秒内重连成功则不广播 offline）？在报告里给出选择与理由（注意 hb 已有 2 次丢失才判死的既有口径，下线判定应以中继既有判死点为准，不许新造一套更敏感的判定造成闪烁）。
- SPA 接入：presence 变化即时更新页眉在线状态；**outbox 联动**：收到 offline → 此后新发送直接入队（不再先写 socket 制造未确认项）；收到 online → 触发既有冲刷流程。既有对账逻辑不许削弱（presence 是提前量，不是替代品：仍可能有帧已写出后 agent 才死的竞态，对账继续兜底）。
- 部署兼容：新帧对旧 SPA 必须无害（探查第 3 条的结论为准）；relay-cf 与 relay-node 同步实现，`tools/relay_lockstep.py` 增加 presence 规则断言。
- 协议文档 `protocol/frames.md` 补记该帧的语义与触发点。

## 部署

- relay-cf 需真实部署（wrangler，沿用 Cloudflare 连接器的 surrogate token 方式）；部署后验证：/health 正常、线上 SPA 新鲜 profile 探活（tools/live_spa_probe.mjs）通过、M38 的 tools/verify_release.py 全过。
- SPA 构建**必须**带 VITE_RELAY_WS / VITE_RELAY_HTTP 环境变量（M38 §0 教训，verify_release 会查）。

## 测试

- relay-node smoke + tests/e2e_cf 增加 presence 场景：agent 上线广播、agent 掉线广播、停放世代事件不广播。
- Playwright（mock agent）：会话中途杀掉 mock agent → 页眉在限定时间内翻为离线 → 此时发送的消息直接进 outbox 待发送（不是未确认） → agent 恢复 → 页眉在线 + 队列自动冲刷送达且不重复。
- 既有套件全绿并报数（插件无关时说明插件未动）。报告 `docs/m39-report.md`：生命周期事件点清单、广播口径与防抖选择、对账保留的竞态说明、部署与验证记录。
