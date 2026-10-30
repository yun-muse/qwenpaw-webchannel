# M32 — 长对话性能与渲染打磨

先量后改：本文的每个结论都有同口径的测量数据或代码证据。所有测量都在本地生产构建
（`vite preview` + relay-node + mock agent）上完成，未接触托管环境。

---

## 1. 结论摘要

300 条混合消息、约 4 秒的长回复流式输出（desktop / 390px 手机同口径）：

| 指标 | 改前 | 改后 | 变化 |
| --- | --- | --- | --- |
| 流式帧均间隔（desktop） | 21.1 ms | **17.3 ms** | −18.0% |
| 掉帧数（>20 ms 的帧，desktop） | 36 | **5** | −86% |
| 流式帧数（4 s 内，desktop） | 185.5 | **216.5** | +16.7% |
| 流式帧均间隔（手机 390px） | 21.2 ms | **17.2 ms** | −18.9% |
| 掉帧数（>20 ms，手机） | 36.5 | **4** | −89% |
| 流式帧数（手机） | 182.5 | **215** | +17.8% |
| 打开 300 条会话到可交互 | 704 / 678 ms | 723 / 696 ms | +2.7%，噪声内（§2.4） |
| 滚动到顶部 | 9 / 30 ms | 16 / 20 ms | 均无长任务（单次采样，噪声大） |
| 流式中打字 p95 | 15.1 / 13.6 ms | 15.5 / 13.6 ms | 无退化 |

改前的“卡”集中在**流式期间**：短会话 16.9 ms/帧（满帧），300 条 + Markdown 才会掉帧
（21.1 / 21.2 ms）。根因是**每个 delta 都把整条消息的 Markdown 重新解析、整棵 DOM 重写、
并把已完成代码块重新高亮一遍**，同时 300 条消息的每一行都在每个 delta 里重新渲染。

改动只做两件有数据支撑的事（§5）：流式消息按 block 拆成“冻结前缀 + 活动尾块”，以及
`MessageView` 的 memo 化。无新增依赖；JS +1.20 kB（gzip +0.48 kB）。

回归门槛：**Playwright 356/356 通过，vitest 207/207 通过**（§7）。

---

## 2. 测量方法（可复现）

### 2.1 夹具与运行环境

新增 `tests/perf_m32.mjs`（纯测量，不做断言）。它与 `tests/e2e_m19.mjs` 共用同一套
本地栈与 mock agent：

1. `npm run build`（`tsc --noEmit && vite build`），`vite preview --host 127.0.0.1 --port 4191`；
2. `relay-node` 监听 **8787**（构建里烘死的本地 relay 地址）；
3. 进程内 mock agent 通过 `/ws/agent` 连上 relay，回答 `chats / hist / models / skills /
   usage / stats / effort / msg 流式`。

夹具 `chat-long` 固定 **300 条**消息（偶数 user、奇数 assistant），混合：

- 每 6 条一条 Python 代码块（22 行，含函数、docstring、循环）；
- 每 6 条一条 GFM 表格（4 列 × 5 行）；
- 每 6 条两条代码块（JS + bash）；
- 所有 assistant 消息带长段落与有序列表，以及 `turn` 用量收据；
- 每 37 条 user 消息带一个附件 chip（无 `ref`，不触发 `att_get`）。

夹具 JSON 约 200 KB，仍在 relay-node 的 256 KB 单帧上限内（`relay-node/server.js:9`）。
`chat-100` / `chat-200` 为同构的 100 / 200 条版本，用来测打开耗时随条数的斜率；
600 条会超过单帧上限，因此没有做 600 条点（见 §6.2）。

流式回复 `STREAM_TEXT` 固定 ~1.6 KB：两段代码块 + 一张表格 + 多段说明，按 **10 字符 /
24 ms** 推送，总时长约 3.7–4.1 s。另有一份**等长、无 Markdown 语法**的 `STREAM_PLAIN`
作为对照，用来把“列表重渲染成本”和“Markdown 解析成本”分开。

桌面视口 1280×900；手机视口 **390×844**（`isMobile: true, hasTouch: true, dpr 2`）。
浏览器为 headless Chromium（Playwright 1.64.1，Node v24.22.1），未做 CPU 节流；绝对毫秒数因机器而异，
**比例与帧分布**才是结论。

### 2.2 四个指标的定义

全部在页面内用 Performance API / rAF 采样（`tests/perf_m32.mjs` 的 `installProbes`）：

1. **打开到可交互（open）**：`addInitScript` 在文档开始处记录 `performance.now()`；
   `goto(domcontentloaded)` 后轮询到 `.messages .row` 达到预期条数，再等两个
   `requestAnimationFrame`（确保已绘制），读差值。包含 bundle 下载/执行、WS 连接、
   `hist`、全部 markdown 解析与首屏布局。默认跑 5 次，取中位数（原始值一并写入 JSON）。
2. **流式长任务与掉帧（stream）**：`PerformanceObserver({type:'longtask'})` 记录
   `count / total duration / max`；同时用 rAF 循环记录帧间隔，统计均值、p50/p90/p95、
   `>20 ms` 与 `>50 ms` 的帧数、按四等分段的均值。每个场景跑 2 次取平均。
3. **流式中打字（typing）**：在流式进行到约 25% 时向输入框输入 20 个 ASCII 字符
   （40 ms 间隔），capture 阶段监听 `keydown`，记录 `event.timeStamp` 到下一帧 rAF 的
   延迟，取 p50/p95/max。
4. **滚动到顶部（scroll-top）**：把 `.messages` 的 `scrollTop` 置 0（临时关闭 smooth），
   测“到两帧后”的耗时、首行是否可见，并继续采样 700 ms 内的长任务（覆盖 `onScroll`
   引起的状态更新与重渲染）。

### 2.3 复测命令

```bash
# 改前 / 改后各跑一次（端口 8787 / 4191 必须先空出来）
M32_LABEL=before node tests/perf_m32.mjs
M32_SKIP_BUILD=1 M32_LABEL=after node tests/perf_m32.mjs
```

结果写入 `tests/perf-m32-<label>.json`，控制台同时打印汇总。可用环境变量：
`M32_RUNS`（打开重复次数，默认 5）、`M32_STREAM_RUNS`（每个流式场景重复次数，默认 2）、
`M32_FAST=1`（跳过扩展打开与手机 pass）、`M32_SKIP_BUILD=1`、`M32_HEADED=1`。
页面出现任何 `pageerror` 时脚本退出码非 0。

### 2.4 噪声说明

- 打开耗时抖动较大（单次 651–1201 ms），因此用 5 次中位数；`chat-100/200` 的点也用于
  判断趋势，单点 ±50 ms 不视为回归。
- 流式指标同样受机器负载影响；同一构建连续两次运行的帧均值可差 ±1 ms。因此所有对照
  都来自**同一台机器、同一天、同一夹具、同一脚本**，并以“改前/改后各一整轮”比较。
- 长任务的 `>50 ms` 计数本身很稀疏（浏览器只在主线程连续占用 ≥50 ms 时上报），
  所以主指标用 rAF 帧间隔分布，长任务作为佐证。
- 滚动到顶部是单次采样（2 帧 + 700 ms 观察窗），实测在 9–30 ms 之间波动且**从无长任务**；
  这个数字只用于确认“回顶不触发重渲染风暴”，不用于比较毫秒差。

---

## 3. 基线数据（改前，HEAD）

### 3.1 打开与滚动

| 场景 | desktop | 手机 390px |
| --- | --- | --- |
| 打开 300 条（中位数，5 次） | **704 ms**（680/684/704/763/1035） | **678 ms**（654/657/678/696/707） |
| DOM 节点数 | 11,596 | 11,600 |
| 打开 100 条（单次） | 520 ms | 477 ms |
| 打开 200 条（单次） | 567 ms | 535 ms |
| 滚动到顶部（含 700 ms 长任务） | 9 ms / 0 长任务 | 30 ms / 0 长任务 |

打开耗时 ≈ **500–600 ms 固定启动成本 + 每条约 0.3–1.0 ms**（100/200/300 三点的斜率在噪声内）。
300 条时渲染部分约 150–250 ms，其余是 bundle、连接与首帧。

### 3.2 流式（同一段 ~1.6 KB 回复）

| 场景 | 帧均值 | >20 ms 帧 | >50 ms 帧 | 帧数 | p95 | 长任务 | 打字 p95 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| desktop · 300 条 · Markdown | **21.1 ms** | **36** | 2 | 185.5 | 41.7 ms | 1 / 88 ms | 15.1 ms |
| desktop · 300 条 · 纯文本对照 | 20.8 ms | 29.5 | 3.5 | 189 | 41.7 ms | 2 / 118.5 ms | 16.1 ms |
| desktop · 2 条 · Markdown | 16.9 ms | 0.5 | 0.5 | 217 | 16.7 ms | 0.5 / 60 ms | 14.6 ms |
| 手机 · 300 条 · Markdown | **21.2 ms** | **36.5** | 3.5 | 182.5 | 41.7 ms | 1 / 94.5 ms | 13.6 ms |
| 手机 · 300 条 · 纯文本对照 | 17.1 ms | 5 | 0 | 215.5 | 16.8 ms | 0 / 0 | 15.5 ms |
| 手机 · 2 条 · Markdown | 16.9 ms | 0.5 | 0.5 | 217.5 | 16.8 ms | 0.5 / 50 ms | 15.6 ms |

读法：4 秒的流式在 60 fps 下应有 ~220 帧；改前只剩 185.5 / 182.5 帧，说明**每 4–5 个
delta 就丢掉约 1 帧**。短会话始终满帧；300 条列表 + 纯文本在 desktop 这一轮也出现了
20.8 ms 的均值（该轮对照本身受噪声影响，手机端同轮为 17.1 ms），但 300 条 + 带语法
Markdown 在两台视口、多轮运行里都稳定掉到 21 ms 以上——**可复现的增量来自 Markdown 重写**，
列表规模放大的是它的后果（§4.3）。

---

## 4. 热点定位（代码证据 + 实测）

### 4.1 每个 delta 重解析整条 Markdown，并整棵重写 DOM

改前 `spa/src/App.tsx`（HEAD）：

- `renderMarkdown()` — `App.tsx:660-663`：`marked.parse(整段文本)` + `DOMPurify.sanitize`；
- `Markdown` 的 `useMemo(..., [text])` — `App.tsx:782`：流式期间 `text` 每帧都变，所以
  **每帧都把从头到尾的整段文本重新 parse 一遍**（O(n²) 增长）；
- `dangerouslySetInnerHTML={{ __html: html }}` — `App.tsx:924`：每帧把 `.md` 的整个
  子树删掉重建，已完成段落的 DOM 节点、滚动位置、选中状态全部作废。

插桩构建（临时在 `renderMarkdown` 与布局 effect 里计时，测完即还原）实测一条 4.1 s 的
流式回复：

| 项 | 次数 | 总耗时 | 单次 |
| --- | --- | --- | --- |
| `marked.parse` | 110 | 40.9 ms | 0.37 ms |
| `DOMPurify.sanitize` | 110 | 61.1 ms | 0.56 ms |
| `hljs` 高亮 | 139 | **161.7 ms** | 1.16 ms |
| 布局 effect（含高亮） | 110 | 171.2 ms | 1.56 ms |

### 4.2 高亮在流式中反复执行

`App.tsx:787-825`（HEAD）在 `useLayoutEffect` 里遍历 `pre`：

```ts
if (!codeEl.dataset.highlighted) { ... hljs.highlight(...) ... }
```

这个 `dataset` 守卫只在**同一个 DOM 节点**内有效；而 4.1 的整树重写每帧都生成新的
`code` 元素，守卫永远不命中 → 已完成的代码块每帧重跑一次 `hljs`。

A/B 实测（同一插桩构建，仅关闭 `hljs`，其余不变；这是一次性实验，**原始 JSON 未保留**，
数值取自运行日志，保留下来的是“关”的版本 `perf-m32-ab-nohl.json`）：

| | 帧数 | 帧均值 | >20 ms | 长任务 |
| --- | --- | --- | --- | --- |
| 高亮开 | 163 | 24.8 ms | 55 | 5 / 412 ms |
| 高亮关 | 183 | 21.8 ms | 39 | 2 / 128 ms |

高亮约占总卡顿的 40%，但关掉后仍达不到 17 ms —— 说明**整树重写 + 布局**是另一半。

### 4.3 每帧重渲染全部 300 条消息行

- 列表：`App.tsx:5234-5245`（HEAD）`messages.map(...)`，`MessageView`（`App.tsx:1115`）
  **没有 `memo`**；
- delta 合并：`App.tsx:2878-2930`（HEAD）已经用 `requestAnimationFrame` 合并同一帧内的
  多个 delta（这部分本来就是对的，不需要改）；
- 但每次合并后的 `setMessagesByChat` 仍会让整个 `App` 重渲染，300 个 `MessageView`
  全部重新执行。

插桩计数：一条流式回复期间 `MessageView` **执行了 41,066 次**（约 137 帧 × 300 行）。
单次很便宜，但它是“去掉 Markdown 重写之后”最大的剩余成本（§5.3 的 ablation 证明）。

### 4.4 布局抖动来源

`App.tsx:3597`（HEAD）：`el.scrollTop = el.scrollHeight;` 在每次 `messages` 变化后读取
`scrollHeight`。它发生在 4.1/4.2 的 DOM 写入之后，强制同步布局；本身是“自动跟随底部”
必需的行为，但和整树重写叠加时，每帧要做两次布局（重写后一次、读 `scrollHeight` 一次）。
本轮没有单独改它：拆分后帧预算已回到 16.7 ms（§5），没有证据表明它仍是瓶颈。

---

## 5. 改动与逐项收益

### 5.1 流式消息按 block 拆分：冻结前缀 + 活动尾块

`spa/src/App.tsx:691` `splitMarkdown()`、`:859` `decorateMarkdown()`、`:943` `Markdown`。

- 用 `marked.lexer()` 把文本切成 block token；**除最后一个非空 block 外**都是终态；
- 前缀 HTML 按 token 缓存（`{ raws, html }`），每帧只 parser + sanitize **最后一个 block**；
- 前缀 token 未变时，`head` 字符串不变 → React 不重写 `.md-head` 的 DOM；
  只有 `.md-tail` 每帧更新；
- 代码高亮/表格工具条（`decorateMarkdown`）分别作用于 head / tail：**已完成的代码块
  只高亮一次**；
- 非流式消息仍走单次 `renderMarkdown()` —— 打开历史、切换会话的开销与改前一致（§5.3 噪声内）；
- 结构用 `.md-head / .md-tail { display: contents }`（`App.css:1565`），块级排版仍是
  `.md` 的直接子元素；首/尾 margin 规则改为 `.md-head > :first-child`、
  `.md-tail.md-first > :first-child`、`.md-tail > :last-child`。

已知取舍：每完成一个 block，冻结前缀的 `innerHTML` 会整体重写一次（**每 block 一次**，
不是每 delta 一次），因此该消息内已完成的代码块会被重新高亮 O(blocks) 次；实测仍在帧预算内。
流式期间若消息含跨 block 的原始 HTML，或引用式链接定义，分块渲染的中间态可能与整段渲染
略有差异；流结束后走单次整段渲染回到确定结果，所有 HTML 始终经过 DOMPurify。

实测（`perf-m32-split-only.json`，memo 未开）：

| | 帧均值 | >20 ms | 帧数 |
| --- | --- | --- | --- |
| desktop 改前 | 21.1 | 36 | 185.5 |
| desktop 仅拆分 | 19.9 | 24.5 | 192 |
| 手机 改前 | 21.2 | 36.5 | 182.5 |
| 手机 仅拆分 | 19.2 | 18 | 196.5 |

### 5.2 `MessageView` memo 化 + 稳定回调

`App.tsx:1223`（`memo`）、`App.tsx:4519-4541`（`rowActionsRef` + 三个 `useCallback` 包装）。

- 只有 `message` 对象变化的行才重渲染；
- 三个回调（approval / regenerate / edit-resend）用“最新引用”模式保持同一身份，
  被跳过的行仍会调用本次渲染的闭包，不会拿到旧状态。

收益（在 5.1 之上，对比 `split-only` → `after`）：

| | 帧均值 | >20 ms | 帧数 |
| --- | --- | --- | --- |
| desktop 拆分 + memo | **17.3**（−13.1%） | **5**（−79.6%） | 216.5 |
| 手机 拆分 + memo | **17.2**（−10.4%） | **4**（−77.8%） | 215 |

解释：整树重写消失后，300 行的 reconciliation 成了每帧最大的一块；memo 把它降到 1 行。
两条改动缺一不可（仅拆分 19.9 ms；仅 memo 没有单独测——不拆分时 Markdown 整树重写
仍占主导，memo 只能省掉列表那部分）。

### 5.3 改后总表（同口径）

| 指标 | desktop 改前 | desktop 改后 | 手机 改前 | 手机 改后 |
| --- | --- | --- | --- | --- |
| 流式帧均值 | 21.1 ms | **17.3 ms** | 21.2 ms | **17.2 ms** |
| >20 ms 帧 | 36 | **5** | 36.5 | **4** |
| >50 ms 帧 | 2 | 0.5 | 3.5 | 0.5 |
| 4 s 内帧数 | 185.5 | **216.5** | 182.5 | **215** |
| 帧间隔 p95 | 41.7 ms | **16.8 ms** | 41.7 ms | **16.8 ms** |
| 长任务 | 1 / 88 ms | 0.5 / 54 ms | 1 / 94.5 ms | 0.5 / 49 ms |
| 打字 p95 | 15.1 ms | 15.5 ms | 13.6 ms | 13.6 ms |
| 打开 300 条（中位数） | 704 ms | 723 ms | 678 ms | 696 ms |
| 打开 100 / 200 条（单次） | 520 / 567 ms | 490 / 607 ms | 477 / 535 ms | 434 / 539 ms |
| 滚动到顶部（单次） | 9 ms | 16 ms | 30 ms | 20 ms |
| DOM 节点 | 11,596 | 11,746 | 11,600 | 11,750 |

`+150` 节点 = 150 条 assistant 消息各多一个 `display: contents` 的 `.md-head` 包装层
（`.md-tail` 只在流式消息上存在）。改前/改后的“已结算消息”排版一致：最后一块的
`margin-bottom` 均为 0（见 `tests/perf-m32-after.json` 的 `open[].settled`）。

### 5.4 构建体积

无新增依赖。同一台机器、同一 Node 版本：

| 产物 | 改前 | 改后 | 增量 |
| --- | --- | --- | --- |
| JS | 516.23 kB / gzip 172.82 kB | 517.43 kB / gzip 173.30 kB | +1.20 kB / +0.48 kB |
| CSS | 58.88 kB / gzip 11.39 kB | 59.02 kB / gzip 11.42 kB | +0.14 kB / +0.03 kB |

---

## 6. 未做项与理由

### 6.1 “高亮延迟到流结束” —— 与既有验收冲突，改用结构方案

`tests/e2e_m19.mjs:3165-3169` 明确断言 **streamed code is highlighted while it arrives**
（每个采样点 `highlighted === withContent`）。把高亮整体推迟到 `end` 会让这条用例失败；
按任务约定“功能回归 = 撤掉改动，而不是改测试”，这条路不走。

替代方案（已落地，5.1）：**高亮不再随 delta 重复**——完成的代码块进入冻结前缀后只高亮
一次；仍在增长的尾块保留“边到边高亮”，既满足用例，也拿到了同样的收益。

### 6.2 长列表窗口化 / “最近 N 条 + 向上展开” —— 收益不足以抵消风险

打开耗时的实测斜率（§3.1）：500–600 ms 固定成本 + 每条约 0.3–1.0 ms。300 条时渲染部分
约 150–250 ms；即使窗口化到最近 100 条，最多省 ~150–200 ms（704 → ~520–560 ms），而：

- 搜索跳转（M23）按文本在**已加载的完整列表**里定位，然后 `querySelector([data-mid])`
  滚动到 DOM 行（`App.tsx:3736`）。窗口化后目标行不在 DOM 里，跳转会静默失败，
  必须新增“按 anchor 扩窗”的路径；
- 滚动恢复/回到底部依赖 `nearBottom` 与完整列表高度（`App.tsx:3698-3707`、`3759-3784`），
  展开时的高度变化会把用户正在看的位置顶走；
- 现有 356 条 E2E 里没有覆盖“窗口外跳转”的用例，新增窗口化需要新写一套跳转/恢复用例，
  而收益只有 0.2 s 左右。

结论：**不做窗口化**，也不做“最近 N 条”。打开耗时的大头是固定启动成本，不是消息条数；
流式卡顿已由 5.1/5.2 解决。若将来会话普遍超过 1000 条，再用本节的斜率数据重新评估。

### 6.3 Markdown 解析结果跨消息缓存

收益只出现在“切回已看过的会话”（300 条历史每次切换都要重解析）。本轮没有测会话切换，
没有证据表明它是用户感知瓶颈；且缓存 HTML 字符串会带来内存增长与失效管理。**不做**，
留待有切换耗时数据时再评估。

### 6.4 图片/附件懒加载

M31 的 `AttachmentThumb` 是**挂载时**通过 `att_get` 拉字节再生成 blob URL
（`App.tsx:1135-1182`），`<img loading="lazy">` 不会阻止这次请求，因此不是一行属性就能
解决的问题；本轮夹具也没有图片，无法给出收益数字。**不做**。

### 6.5 delta 合并节流

现有实现已经用 rAF 合并同一帧的 delta（`App.tsx:2981-3033`），且 `seq/resume` 语义不受
影响。没有证据表明需要再降到 20 fps，降低刷新率反而会破坏打字机观感。**不改**。

---

## 7. 回归验证（硬门槛）

| 套件 | 命令 | 结果 |
| --- | --- | --- |
| Playwright 全量 | `M19_SKIP_BUILD=1 node tests/e2e_m19.mjs` | **356 / 356 通过**（desktop + 390px 手机） |
| vitest | `cd spa && npx vitest run` | **207 / 207 通过**（15 个文件） |
| 类型/构建 | `cd spa && npm run build` | `tsc --noEmit` + vite build 通过 |

关键回归点逐条确认：

- 流式代码“边到边高亮”（`e2e_m19.mjs:3165`）——通过；冻结前缀的代码块保持高亮；
- 每个 `pre` 始终带且只带一个 `.pre-copy` / `.pre-lang`，流式重绘不重复（`e2e_m19.mjs:3164`）；
- 复制代码 / 复制表格 / 表格工具栏（`.table-box`）——通过；
- 搜索跳转与闪烁、置顶、标签、草稿、用量收据、M31 附件、M22 深色主题——全部通过；
- 手机 44 px tap target 与 M26 抽屉密度——通过。

测量脚本本身不进入 E2E/CI（它是 `tests/perf_m32.mjs`，手动运行）；主表的三组证据 JSON
保留在 `tests/perf-m32-{before,after,split-only}.json`，§4.2 的高亮 A/B 另有一份
`tests/perf-m32-ab-nohl.json`（“开”的那次是插桩实验，未保留原始文件）。

---

## 8. 变更清单

| 文件 | 变更 |
| --- | --- |
| `spa/src/App.tsx` | `splitMarkdown()`；`decorateMarkdown()`；`Markdown` 的 head/tail 双容器；`MessageView` memo + 稳定回调 |
| `spa/src/App.css` | `.md-head / .md-tail { display: contents }` 与首/尾 margin 规则 |
| `tests/perf_m32.mjs` | 新增测量脚本（300 条夹具、四种指标、desktop/390px、JSON 输出） |
| `tests/perf-m32-*.json` | 改前 / 仅拆分 / 改后 / 高亮 A/B 的原始数据 |

未提交（`git status` 保留改动）。未触碰托管环境。
