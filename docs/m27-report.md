# M27 report — 思考等级「未生效 — no QwenPaw chat exists for this session yet」根治

结论：这是**预期状态被当成错误弹出**，叠加**插件把所有“查不到 chat”都标成 404**，再由
**1.2 秒定时器补发**放大成“刚打开网页就出现”。三段链路各修一处：插件区分“确实还没有
ChatSpec”和“chat 列表读取失败”；SPA 对 404 静默并保留本地选择；补发改成“本轮对话完成”
这一确定事件，不再猜时间。

## 1. 根因（含证据）

### 1.1 报错串不是 QwenPaw 的

`grep -rn "no QwenPaw chat exists\|exists for this session" ~/workspace/qwenpaw-ref --include=*.py`
没有任何命中；字符串只在本仓库 `plugin/channel.py` 出现（修复前 1235 / 1293 / 1596 行）。
其中 1596 行属于 `E_EXPORT`，与思考等级无关；用户看到的「思考等级未生效 — …」只会来自插件
`E_EFFORT` 的 `detail`。

### 1.2 SPA 对 404 仍然弹 toast（违反 M9）

修复前 `spa/src/App.tsx`（HEAD `086695d`）：

- 3086–3104 行处理 `E_EFFORT`；3094 行 `if (status !== 404)` 只跳过了**回滚**，
  3101 行的 `showToastBriefly(...)` 在 `if` **外面**，所以 404 也照样弹
  「思考等级未生效 — no QwenPaw chat exists for this session yet」。
- 注释本身写着 “404 means the chat has no server record yet … Keep the local choice”，
  但实现与注释相反。
- `protocol/frames.md` §6 / §10.2 明确规定：404 是“尚无 ChatSpec”，客户端应保留本地选择、
  首条消息后重试；M9 的设计就是 404 静默。

这是用户看到的那句话的**直接来源**：一次 `set_effort` 收到 404，就会原样拼进 toast。

### 1.3 插件把“列表读取失败”也算成 404（导致“已存在的 chat”也报这句话）

修复前 `plugin/channel.py:400-442` 的 `_resolve_chat_id()` 有三种失败都返回 `None`：

| 情况 | 返回值 |
|---|---|
| `GET /api/chats` 返回非 2xx | `None`（日志 “GET /api/chats failed”） |
| 请求超时 / app 未就绪（`_api_json` 返回 status 0） | `None` |
| 列表读取成功、但没有这个 chat 的 ChatSpec | `None` |

而 `_handle_get_effort`（1231–1238）与 `_handle_set_effort`（1289–1296）把 `None`
**一律**翻译成 `status: 404` + “no QwenPaw chat exists for this session yet”。
于是：容器刚启动 / SPA 刚打开、`GET /api/chats` 还没就绪时，一个**早就存在**的 chat
也会被报成“还没有 chat”。这与用户“尤其是刚打开网页的时候”高度吻合。

QwenPaw 侧的事实（`~/workspace/qwenpaw-ref`）：

- `ChatSpec` 由第一条消息的 `POST /api/console/chat` 调用
  `get_or_create_chat` 创建：`src/qwenpaw/app/routers/console.py:455`、
  `src/qwenpaw/app/chats/manager.py:144-205`。所以“未发过消息 = 没有 ChatSpec”是真实状态。
- thinking 接口在 chat 不存在时确实 404：`src/qwenpaw/app/chats/api.py:732-745`；
  PUT 对不支持的档位 422：`src/qwenpaw/app/chats/api.py:749-780`。

### 1.4 补发逻辑靠 1.2 秒定时器猜

修复前 `spa/src/App.tsx`：

- `156` 行 `const EFFORT_REAPPLY_MS = 1200;`
- `3443-3462` `scheduleEffortReapply()`：在**每次发送消息**后起一个 1200 ms 定时器，
  到点若本地档位仍未确认就发一次 `set_effort`，只试一次。
- 调用点：`3901`（`sendTextDirect`）、`3951`（`send`）。

问题：

1. 1200 ms 是猜测。QwenPaw 创建 ChatSpec 的时间取决于冷启动 / 模型排队，常常 > 1.2 s，
   于是定时器必然撞上 404；
2. 撞上 404 后没有第二次机会，选择可能永远不生效；
3. 叠加 §1.2，404 还会弹 toast；
4. 叠加 §1.3，冷启动时连“chat 已存在”都可能被误判成 404。

### 1.5 “刚打开网页”最吻合的路径

1. 打开页面 → 恢复 activeChat → 只发 `get_effort`（2364 行 effect 与
   3187–3192 行 `onState=live`），**get 失败本来就是静默的**（实测修复前
   “恢复未发送会话不弹错”这条 e2e 也是 PASS）。
2. 用户在恢复的会话里直接发第一条消息（或刚新建会话就发）→ 1.2 s 定时器发 `set_effort`
   → 此时 ChatSpec 可能还没建好，或 `GET /api/chats` 在冷启动时读取失败
   → 插件回 404 + 那句话 → SPA 弹 toast。
3. 另一个等价入口：新建会话后**先点档位再发消息**，`chooseEffort` 立即发 `set_effort`，
   必然 404 → 立即弹 toast。

两条都是“预期状态被当成错误”，不是真正的失败。

## 2. 触发路径表

| 场景 | 发出的帧 | 触发条件（修复后） | 修复前表现 | 修复后表现 |
|---|---|---|---|---|
| 打开页面 / 恢复 activeChat | `get_effort` | `activeChat` effect；`onState=live` 各一次 | 404 已静默 | 静默；`pending` 按本地档位武装 |
| 切换会话 | `get_effort` | 同上（去掉 `pending` 短路，始终对齐服务端） | 若 pending 则跳过对齐 | 总是请求；`effort` 帧不覆盖待补发选择 |
| 切换模型 | `get_effort` | `model_changed` 后（2869 行附近） | 同上 | 同上，`supported` 同步刷新 |
| 新建会话 | `get_effort` | 新 chat 进入 effect | 静默 | 静默 |
| 新建/未发送会话里点档位 | `set_effort` | 用户点击 `chooseEffort` | 404 → **弹错** | 静默；保留选择；`pending=true` |
| 发送消息 | 无（M27 起） | — | 1.2 s 后 `set_effort` | **不发**；等本轮完成 |
| 本轮回复结束 | `set_effort` | `end` / 收尾 `msg` / 非流式 `msg` | 无（定时器已用掉） | 补发一次；成功即确认 |
| 已存在 chat 被服务端拒绝 | `set_effort` | 422 / 其它非 404 | 回滚 + 弹错 | 不变（回滚 + 弹错） |
| 插件读不到 chat 列表 | `set_effort` | `status` = 0/HTTP，非 404 | 误报 404 并弹“no chat” | 弹“chat list unavailable …”（真错误，可见） |

## 3. 修复设计

### 3.1 插件：让 404 只表示“确实还没有 ChatSpec”

`plugin/channel.py`：

- 新增 `_resolve_chat_id_state(chat) -> (id, status, readable)`（400–467 行）：
  - `(id, 200, True)`：找到；
  - `(None, 404, True)`：列表读成功、但没有该 chat 的 spec；
  - `(None, 0/HTTP, False)`：列表本身读失败（含列表接口返回 404 的极端情况）。
- 新增 `_effort_chat_id(chat, req_id)`（1241–1269 行）：只有 `readable and 404` 才回
  `E_EFFORT status:404` + “no QwenPaw chat exists for this session yet”；读取失败回
  `chat list unavailable: app unreachable` / `chat list unavailable (HTTP N)`，
  **绝不带 404**（0/404 不写 `status` 字段，HTTP 5xx 原样带）。
- `_resolve_chat_id()` 保留旧的 id-or-None 语义（历史/停止/导出等只关心存在性）；
  effort 两个 handler 改用新助手（1295 / 1347 行）。
- `protocol/frames.md` §6、§10.2 更新：404 的语义收紧，读取失败不算 404；
  客户端对 404 静默保留并在“首轮完成后”补发，其它 `set_effort` 错误必须可见。

### 3.2 SPA：静默 + 保留 + 不覆盖

新增 `spa/src/lib/effort.ts`（纯函数，vitest 覆盖）：

| 函数 | 作用 |
|---|---|
| `effortErrorAction(id, status)` | 404 → `not-created`；`effort-get` 的其它失败 → `get-unavailable`（静默）；其余 → `rejected` |
| `effortNeedsApply(level, confirmed)` | 本地非 `default` 且服务端未确认 → 还需补发 |
| `pendingEffortLevel(level, meta)` | 补发触发点该发的档位（`pending` 且未确认） |
| `shouldAdoptEffortLevel(local, meta, frameLevel)` | `pending` 时忽略“不一样的 `get_effort` 回包”，避免服务端默认值覆盖用户刚选的档位 |

`spa/src/App.tsx`：

- `E_EFFORT`（3128–3158 行）：
  - `not-created`：**不弹任何提示**，保留本地值，按 `effortNeedsApply` 设 `pending`；
  - `get-unavailable`：静默（M9 既有约定：读失败时本地值就是最好的展示）；
  - `rejected`：回滚到 `confirmed`/`rollback`，`pending=false`，弹
    「思考等级未生效 — <detail>」（422、5xx、列表读取失败等真错误全部保留）。
- `case 'effort'`（2943–2965 行）：`supported/kind/model_key` 总是更新；档位在
  `pending` 且与服务端值不同时**不采纳**（服务端值仍记入 `confirmed`，作为回滚目标）；
  采纳时清除 `pending`。
- `chooseEffort`（3467 行起）：记录 `effortSentRef`，发不出去才回滚。

### 3.3 补发触发点（无定时器）

`applyPendingEffort(chat)`（1801–1816 行）只在**本轮对话结束**时调用：

1. `case 'end'`（2627 行）——流式回复结束；
2. `case 'msg'` 且 `rt.endedId != null`（2660 行）——收尾消息；
3. `case 'msg'` 非流式直接收尾（2709 行）。

这是 QwenPaw 已经持久化 ChatSpec 的确定时刻（`get_or_create_chat` 在首条消息处理中执行）。
`effortSentRef` 去重，避免 `end` 与紧随其后的 `msg` 发两次；连接断开
（`connecting/resuming`，3206 行）清空，保证旧 socket 上丢掉的请求还能在下轮补发。
发送消息本身（`send` / `sendTextDirect`）**不再**触发任何 effort 请求。

### 3.4 为什么不是“全局吞掉 E_EFFORT”

静默条件只有 `status === 404`（且插件已保证读取失败不会伪装成 404）。`422`、`5xx`、
列表不可读、未知档位仍然走 `rejected`：回滚 + toast。e2e M27.3 用 mock 的 422 明确验证了
这条路径仍然可见。

## 4. 测试与结果

### 4.1 新增/更新

- `spa/tests/effort.test.ts`（14 个）：错误分类矩阵、`effortNeedsApply`、
  `pendingEffortLevel`、`shouldAdoptEffortLevel`，以及“404 保留 → get 不覆盖 →
  轮次结束补发 → set 回包确认”的完整状态序列。
- `plugin/tests/test_m9.py`（新增 4 个）：列表 500 不是 404、列表接口自身 404 也不是
  404、传输失败不带 `status`、set/get 两条路径一致。
- `tests/e2e_m19.mjs` 新增 M27 包（每个 pass 10 条，桌面 + 手机各一遍）：
  1. 打开页面恢复“未发送会话”：无错误弹窗、档位仍显示“高”、首轮结束后自动补发成功；
  2. 新会话先改档再发消息：改档 404 静默、mock 记录到“先 404 后成功”两次、服务端最终值 = 高；
  3. 已存在会话被 422 拒绝：toast 仍出现且回滚到已确认档位。
  - mock 新增 `notCreated` / `efforts` / `effortLog` / `effortReject`；
    首个 `msg` 后 2.5 s 才“创建” ChatSpec（故意慢于旧的 1.2 s 定时器）。
  - 新增 `M27_ONLY=1` 快速回路（`M27_ONLY=1 M19_SKIP_BUILD=1 node tests/e2e_m19.mjs`）。

### 4.2 修复前复现（同一套 e2e，回退 `App.tsx` 到 HEAD 后重跑）

```
M27_ONLY=1 … : checks: 23, failed: 10
FAILED desktop: picking a level before the chat exists is silent and kept —
  toast: 思考等级未生效 — no QwenPaw chat exists for this session yet
FAILED desktop: the restored level is applied after the first turn —
  [{"chat":"chat-fresh","level":"high","created":false}]
FAILED desktop: the pre-creation choice is applied after the first message —
  attempts 全是 created:false
...（手机 pass 同样 5 条）
```

用户原话中的字符串在 e2e 里被原样捕获，确认根因链条复现成立。

### 4.3 修复后全量

| 套件 | 结果 |
|---|---|
| 插件 18 个 suite（`for s in tests/test_*.py; do python $s; done`） | **18/18 ALL PASS，338 条 `ok`**（`test_m9.py` 27 条） |
| SPA build（`tsc --noEmit && vite build`） | 通过 |
| SPA vitest | **154/154，11 个文件**（M27 新增 14） |
| Playwright `tests/e2e_m19.mjs` 全量（桌面 1280×900 + iPhone 13） | **318/318，0 failed**（M27 每个 pass 10 条） |
| `M27_ONLY=1` 修复后 | 23/23，0 failed（22.6 s） |
| relay-node `npm test` | PASS（exit 0） |
| relay-cf `npx tsc --noEmit` | exit 0 |

复现/验证命令：

```sh
cd spa && npm run build
cd .. && node tests/e2e_m19.mjs                    # 全量
M27_ONLY=1 M19_SKIP_BUILD=1 node tests/e2e_m19.mjs # 只跑 M27
```

## 5. 改动文件

| 文件 | 改动 |
|---|---|
| `plugin/channel.py` | `_resolve_chat_id_state`、`_effort_chat_id`、`_chat_lookup_detail`；effort 两个 handler 改为区分 404/读取失败 |
| `plugin/tests/test_m9.py` | 4 个 M27 用例 |
| `protocol/frames.md` | §6 / §10.2：404 语义与客户端处理（静默保留 + 首轮后补发） |
| `spa/src/lib/effort.ts` | 新增纯状态机 |
| `spa/src/App.tsx` | 404 分支静默、补发触发点、采纳保护、去掉 1.2 s 定时器 |
| `spa/tests/effort.test.ts` | 新增 14 个单测 |
| `tests/e2e_m19.mjs` | M27 mock + 检查 + `M27_ONLY` |

未提交（按任务要求）。

## 6. 已知边界

- **第一轮仍然用默认档**：ChatSpec 尚不存在，per-session 偏好无处可存；首轮结束后的补发
  对后续轮次生效。这是 QwenPaw 的模型（会话记录由首条消息创建），不是 SPA 能绕过的。
- **M19 会替换“服务端列表里没有的恢复会话”**：所以真正的“从未创建过”的恢复会话在刷新后
  会被切到最近的会话。e2e 的恢复场景把该 chat 放进 mock 的 `chats` 列表（只为让 M19 保留
  它），同时让 thinking 仍返回 404；生产上对应“ChatSpec 在、thinking 记录缺失/变动”的
  状态。这一点在报告里明说，避免测试给人“未创建会话能稳定恢复”的错觉。
- **插件 chat-id 缓存**：若 ChatSpec 在别处被删除，缓存里的 id 会让 `/thinking` 返回 404；
  SPA 会当作“尚无记录”静默保留，下一条消息重建 chat 后由轮次结束补发。属于可接受行为。
- **读取失败仍然会弹错**（`chat list unavailable …`）：这是真错误，符合“真错误照常报错”；
  但它不再伪装成“no QwenPaw chat exists”，也不会在正常冷启动的 1.2 s 时机被触发。
