# M38 — 生产验收扫荡 + 文档收尾（收官项）

**结论：代码与制品一致，但线上 SPA 的构建配置不对。** 24 项发布检查里 23 项 PASS，唯一 FAIL 是本报告 §0 的发现：
线上的 `index.html`/bundle/ZIP 确实是 HEAD 的产物，可那个 bundle 是**不带 relay 环境变量**构建的——
首访用户看到的是「本地演示节点 + 127.0.0.1:8787」，而不是生产 relay 和登录门。中继两个实现的 `hb` 与槽位世代语义仍 lockstep；
功能冒烟由既有套件（vitest 305、插件 21 套件、e2e 505 + 26、e2e_cf 10 断言、relay-node smoke）加一次真实生产探活覆盖。
文档漂移（根 README 协议表停在 v8、`docs/` 索引缺 12 篇、`spa/README.md` 停在 M10/M21）已全部修正，并补了三个可重跑的检查脚本；
另记录 5 个非阻塞问题（测试产物卫生、模型选择器 e2e 缺口、`/health` 字段易误读、容器内插件版本不可外部验证、协议未收录 M8 帧）。

扫荡时间：2026-10-30 21:37–22:05 UTC，仓库 HEAD `52011d33c7612891a52226e034e6d11b43ebd5de`（`M37`），分支 `master`。
线上基线：SPA <https://qwenpaw-webchannel-spa.pages.dev>、relay <https://qwenpaw-webchannel-relay.yxliwangsheng.workers.dev>、
plugin-dist <https://qwenpaw-plugin-dist.pages.dev/webchannel.zip>。

---

## 0. 最重要的发现：线上 SPA 没有接上生产 relay（只记录，未修）

**现象**：用一个全新的浏览器 profile 打开 <https://qwenpaw-webchannel-spa.pages.dev>，页面没有登录框，侧栏底部显示
「本地演示节点」，在 6 秒内对 `ws://127.0.0.1:8787/ws/client` 发起 4 次连接，顶栏停在「连接中 / Agent 离线」。
在这台机器上 127.0.0.1:8787 恰好没有服务，所以是 4 次失败；对任何访客都是同样的结果。

**证据**（Chromium 通过本机 CONNECT 桥代理，`ignoreHTTPSErrors`，只读、不发消息）：

| 步骤 | 观察 |
|---|---|
| 首访（空 localStorage） | `loginInput=false`；`.endpoint-switch` =「本地演示节点」；WebSocket 尝试 `ws://127.0.0.1:8787/ws/client` ×4；正文含「连接中」「Agent 离线」 |
| 点侧栏 `.endpoint-switch` | 立刻出现登录表单：「输入 Relay 访问口令以连接你的云端阿里云 Agent 容器」；`webchannel.endpoint="cloud"` |
| 在该表单登录（密码仍只从 `.secrets` 读入内存） | 第 5 次 WebSocket 是 `wss://qwenpaw-webchannel-relay.yxliwangsheng.workers.dev/ws/client?token=…`；会话列表加载出来（「导出全部（74）」），一切正常 |

**根因（可复现的推断）**：这次部署的 bundle 是在**没有 `VITE_RELAY_WS` / `VITE_RELAY_HTTP`** 的情况下构建的。
`src/config.ts` 用 `import.meta.env.VITE_RELAY_HTTP ?? ''`，两个变量都没注入时 `LOGIN_REQUIRED === false`，
SPA 走的是「本地/云端可切换」的演示分支（`App.tsx:2166-2178`），默认 `local`。

判别方法（本次实测，不依赖人眼）：

```sh
cd spa
npx vite build --outDir /tmp/m38-noenv                     # 不带 env → 3×127.0.0.1、1×wss、「本地演示节点」×1
VITE_RELAY_WS=wss://…/ws/client VITE_RELAY_HTTP=https://… \
  npx vite build --outDir /tmp/m38-withenv                 # 带 env   → 2×127.0.0.1、1×wss、切换文案 ×0
```

带 env 时 `LOGIN_REQUIRED` 被常量折叠成 `true`，`LOCAL_WS_URL`/`CLOUD_WS_URL` 与端点切换分支被 DCE 掉，所以只剩 2 个
localhost（`relay.ts` 的 `DEFAULT_URL` + 登录页按钮文案）和 1 个 wss（`RELAY_WS_URL`）。线上 bundle 是 **3 个 localhost + 1 个 wss**，
与“不带 env”的构建逐字节相同（§1.5 的归一化 sha256），因此可以断定部署时没传环境变量。

**影响**：
- 首访体验等同“坏了”：没有登录入口、连不上、只显示离线；必须自己发现侧栏那个小切换按钮才能进入登录页。
- 与 README 的部署说明（第 2 步要求用 `VITE_RELAY_WS` / `VITE_RELAY_HTTP` 构建，“非空即开启登录门”）不一致；
  也就是说这次 M37 部署走的不是文档里的命令。
- 安全上没有变松：relay 仍然强制 token（`verifyClientToken`，无 token 401），只是 SPA 的入口被藏起来了。

**为什么没修**：修复 = 带 env 重新构建 + `wrangler pages deploy`，属于部署动作，本次明确禁止。给出两个方向，留给后续决定：
1. 按 README 的部署命令重发（推荐，最小改动，首访直接是登录页）；
2. 如果确实想保留“演示/云端可切换”，就把托管构建的默认端点改成 `cloud`（`location.protocol === 'https:'` 时），
   并将切换按钮放进首屏，而不是侧栏底部。

**复现**：`node tools/live_spa_probe.mjs`（本次新增，只读）——打印首访的登录框/端点切换/WebSocket 列表与 `verdict`，
现在输出 `not-wired` 和 4 条 `ws://127.0.0.1:8787`。加 `--login` 会切到云端并提交 `.secrets` 里的口令（不打印），
复现上表第三行。`tests/mobile_e2e.mjs` 的 `ENDPOINT=cloud` 默认值说明这个切换路径是已知的，但“首访默认本地”这件事此前没有被记录。

---

## 1. 版本一致性 — 9/10 PASS（第 10 项是 §0）

线上部署发生在提交后 66 秒（`version.json.time` 21:37:25Z vs 提交 21:36:19Z），因此 `git` 与 HEAD 相等是可信的，
不依赖“最近没人改过”的运气。

| # | 检查 | 结果 | 证据（本次实际命令/输出） |
|---|---|---|---|
| 1.1 | SPA `version.json.git` == 仓库 HEAD | **PASS** | live `"git":"52011d3"`；`git rev-parse --short HEAD` → `52011d3` |
| 1.2 | `version.json.build` 等于 `<git>-<ts>` | **PASS** | `52011d3-1793396245692` |
| 1.3 | 线上 `sw.js` 的 BUILD 戳与 1.2 一致 | **PASS** | `curl /sw.js` → `const BUILD = '52011d3-1793396245692'`，缓存名 `webchannel-static-${BUILD}` |
| 1.4 | 线上入口 bundle 携带同一 build id | **PASS** | `index.html` 引用 `/assets/index-DwsgIvQU.js`，bundle 内含 `52011d3-1793396245692` |
| 1.5 | 线上 bundle == HEAD 的新构建 | **PASS** | 归一化 build id 与构建时间后 sha256 相同（`a12c5a6e…ad43`，542 327 字符；归一化前的长度也相同） |
| 1.6 | 线上 `index.html` / `sw.js` == HEAD 的新构建 | **PASS** | 归一化后 sha256 相同；10 777 / 5 452 字节 |
| 1.7 | 内容哈希资源逐字节一致 | **PASS** | `index-SSLu49y.css` 62 598 B、`katex-Dzu3cFBE.js` 265 381 B、`katex-yo3P2YYy.css` 26 239 B，MD5 与本地 `spa/dist` 全部相同 |
| 1.8 | plugin-dist ZIP == 仓库 `dist/` 构建产物 | **PASS** | 两者 MD5 `e11d72ec641d8d392f8c30cb06934dae`，86 122 B |
| 1.9 | plugin-dist ZIP == 由**当前 plugin/ 源码**重建的产物 | **PASS** | 在临时目录用 `tools/package_plugin.sh`（`plugin/` 只做符号链接）重建，MD5 仍为 `e11d72ec…4dae` —— 证明线上包就是 HEAD 的 `plugin/`，而不只是“和本地旧产物一样” |
| 1.10 | 构建时注入了 relay 地址与登录门 | **FAIL** | 线上 bundle = 不带 env 的构建（3×`127.0.0.1:8787` + 1×wss；带 env 是 2+1），首访连 127.0.0.1 —— 详见 §0 |

实现方式（新增 `tools/verify_release.py`，24 项检查，只读、不写仓库）：

- build id 与 ISO 时间每次构建都变，直接比字节必然不同；脚本把 `\b[0-9a-f]{7,40}-\d{10,}\b` 与 ISO 时间戳替换成占位符，
  再比 sha256。入口 bundle 的文件名哈希也会随之变化，只在 `index.html` 比较时归一化 `/assets/<name>-<hash>.<ext>`。
- 内容寻址资源（css、懒加载的 KaTeX chunk）名字不含 build id，直接逐字节比。
- ZIP 用**确定性重建**验证：固定时间戳/权限 + 显式文件清单（M21 起的约定），因此“源码相同 ⇒ 字节相同”成立。

`dist/webchannel.zip` 的 mtime（19:44）早于 HEAD 提交（21:36）不是问题：M37 是纯 SPA 改动，插件源码没动，
重建 MD5 相同即是证明。

---

## 2. 中继（relay）— 全部 PASS

| # | 检查 | 结果 | 证据 |
|---|---|---|---|
| 2.1 | 线上 `/health` 在线口径 | **PASS** | `{"ok":true,"agentOnline":true,"clients":0,"agentLastSeen":null}`，字段与 `relay-cf/src/index.ts:266-273` 逐项对应 |
| 2.2 | `/poll` 仍是 501 | **PASS** | HTTP 501，与 `docs/m30-report.md` 的跳过结论一致 |
| 2.3 | `hb` 语义 lockstep | **PASS** | `python3 tools/relay_lockstep.py`：`hb: ack only the slot holder, never forwarded` 两个文件都命中同一段归一化代码 |
| 2.4 | `hb` 不占限流桶、不被转发 | **PASS** | cf：hb 块在 `takeToken()` 之前（偏移 11 969 vs 12 762）；node：无桶，客户端路径 `if (frame.t === 'hb') return;` |
| 2.5 | 槽位世代规则 lockstep | **PASS** | 两边同一谓词 `if (agent && agent !== ws && started < agentMeta.started)`；升级阶段无驱逐；都以 4000 关闭过期 hello |
| 2.6 | 赢槽后的发送顺序 | **PASS** | 两边都是 `peer` → `flushOutbox()` → `ready{agentOnline:true}` |
| 2.7 | 行为级验证（本地 workerd） | **PASS** | `tests/e2e_cf.mjs` 10/10：`LOGIN`、`AUTH-REJECT`、`PAIRING`、`STREAM-ORDER`(20 evt，seq 2–21)、`E_TOOBIG`、`OFFLINE-BUFFER`(3 帧按序)、`RATE-LIMIT`(31/40, E_BUSY≥1)、`POLL-AND-HEALTH`、`AGENT-LAST-SEEN`、`GENERATION`(`staleClose=4000`) |
| 2.8 | relay-node 自身语义 | **PASS** | `cd relay-node && npm test` → `PASS` |

`agentLastSeen: null` 与 `agentOnline: true` 同时出现**是设计内**，不是故障：该字段是 DO 内存态，hibernation 重建后归零，
且按 M7.3 `hb` 故意不盖章（`relay-cf/src/index.ts:202-212`），只有 hello 和业务帧会刷新它。空闲时它长期为 `null`。
relay-node 的 `/health` 没有这个字段（`server.js:161-166`），属于两个实现已知的口径差异，不影响协议。

`relay_lockstep.py` 做的是“把两个不同语言的实现归一化（去 `this.`、`await`、可选链）后逐条规则匹配”，
不是文本 diff——它断言的是规则本身（谁被 ack、谁被丢弃、什么情况关闭 4000、赢槽后的顺序），
所以将来任何一边改坏其中一条都会直接 FAIL。

---

## 3. 功能冒烟 — 除线上 SPA 接线外全部 PASS（线上探活 + 本地套件）

线上只做了**一次真实端到端探活**（`node tools/soak_probe.mjs`，仓库既有工具）：

```json
{"ok":true,"ts":"2026-10-30T21:53:20.018Z","marker":"soakmvvidzte","agentOnline":true,
 "agentLastSeen":null,"agent":"work","activeModel":"sensenova/sensenova-6.8-flash-lite",
 "models":37,"chatMs":5262,"replyHasMarker":true,"totalMs":6746}
```

它走的是和 SPA 相同的**协议**路径（不是同一个前端）：`/health` → `POST /api/login`（密码来自 `.secrets`，不落日志）→
`/ws/client?token=` → `status` / `models` → `msg`（新建一次性 `soak-*` 会话）→ 流式回复含唯一 marker。
即：**登录、在线状态、模型列表、发消息往返在生产 relay 上当场验过**；但“线上 SPA 会走这条路径”这个前提**不成立**，见下表第二行与 §0。
其余功能按下表用本地套件证明（任务允许的口径）。

| 功能 | 结果 | 证据（本次跑出来的断言） |
|---|---|---|
| 登录（30 天 token，relay 侧） | **PASS** | 生产 soak 探活成功登录并握手；`e2e_cf` `LOGIN: bad=401 good=200 expires=1795988861`；`AUTH-REJECT` 两侧 401 |
| 线上 SPA 首访连生产 relay + 登录门 | **FAIL** | 全新 profile：无登录框、侧栏「本地演示节点」、4 次 `ws://127.0.0.1:8787`；点切换后才出现登录框并登录成功（§0）。`verify_release.py` 的 “relay-wired” 检查同样 FAIL |
| 在线状态 | **PASS** | 生产 `/health` `agentOnline:true`；M19 `M37 killing the relay moves the header off 已连接`、`a reconnect while the agent is down reports Agent 离线` |
| 发消息往返 | **PASS** | 生产 `replyHasMarker:true`、`chatMs=5262`；`e2e_cf` `STREAM-ORDER` 20 个 evt 按序（seq 2–21）；M19 在线基线“reaches the agent over the live path” |
| 模型列表与切换 | **PASS（协议/插件层）** | 生产 `models:37`、`activeModel=sensenova/sensenova-6.8-flash-lite`；插件 `test_m7` 覆盖 `model_items`（37 项、唯一 active、不泄漏凭据）与 `model_changed` 形状、`E_MODEL`。**SPA 模型选择器没有 mock 端到端**，见 §6.2 |
| 思考等级（已存在会话改档生效） | **PASS** | M19 `the restored level is applied after the first turn`（`{"chat":"chat-fresh","level":"high","created":true}`）、`the server-confirmed level matches the choice`（`高 / high`）；新会话 404 预置路径 4 条断言；422 仍回滚并提示；插件 `test_m9` 覆盖 budget/effort 换算 |
| 用量统计（含缓存与 by_model） | **PASS** | M19 五张卡 `输入 1.7M · 输出 12.7k · 缓存命中 341.1k · 缓存未命中 1.3M · 命中率 20.7%`、按模型三行（含 `—` 不冒充 0%）、按天缓存条；插件 `test_m28` 的 `by_model` 与 totals 求和相等 |
| 全文搜索 | **PASS** | M19 `archive search returns the seeded message`（命中 + 高亮）、`an archived-only hit is still labelled 仅归档`；插件 `test_m13` / `test_search_edges`（LIKE 转义、snippet 偏移） |
| 单会话导出 | **PASS** | M19 `the single-chat baseline exported both chats`（`Alpha 会话-2026-10-30.md 182`…）；`test_m12` 覆盖文档规则与 10 MB 上限 |
| 批量导出 | **PASS** | M19 `批量导出完成：成功 2 · 失败 0`、按序两个文件、部分失败计数并点名、取消后 `剩余 2 个未导出` |
| 备份打包 | **PASS** | M19 单文件 `webchannel-backup-20261030-2141.zip`、含 `index.md` + `backup.json`、每个 `.md` 与单会话导出逐字节相同、`python zipfile` 可读、失败项写进 index 且 `filename:null` |
| 附件发送与历史回看 | **PASS** | M19 图片暂存→发送→刷新后缩略图 `width 64 height 64`、纯附件轮保留空文本用户行、文件附件下载名保持 `笔记.txt`、10 MB 单文件与 10 个/10 MB 上限；插件 `test_m31` / `test_m35` |
| PWA 版本检查与看门狗 | **PASS** | 线上 `index.html` 含内联 `#boot-watchdog`、`#boot-splash`、`webchannel.selfHealAt`（`verify_release.py` 三项）；`e2e_m29` 26/26（冷启动、版本接管、一次性自愈、卡死卡片） |

M19 全量：`checks: 505, failed: 0`（desktop 246 + mobile 258 + 1 项 UTF-8 下载名预检），耗时 221.2 s。
M29：`checks 26, failed 0`。

---

## 4. 仓库卫生 — 1 项 FAIL（既有，未修）

| 检查 | 结果 | 证据 |
|---|---|---|
| `git status` 干净 | **FAIL** | 5 张 `tests/m29-shots/*.png` 处于 modified（mtime 21:35:47–21:35:54，**早于** M37 提交，是本任务开工前就有的）；原因见 §6.1 |
| 无被跟踪的二进制制品（M33 口径） | **PASS** | `git ls-files -- '*.zip'` 空；CI `artifacts` job 仍在（`.github/workflows/ci.yml`）；另查 `*.tar/*.gz/*.whl/*.jar/*.exe/*.woff2/*.ttf` 均为空 |
| `.secrets` 未入库 | **PASS** | `.secrets/` 被 `.gitignore:4` 忽略；`git log --all --diff-filter=A -- .secrets` 空；所有 commit 的历史路径里都没有 `.secrets/` 或真实的 `.env`（被跟踪的只有 `spa/.env.example`、`relay-cf/.dev.vars.example` 两个占位模板） |
| `.secrets` 值未进历史（抽查口径） | **PASS** | 对全部 52 个 commit 逐一遍历 `git grep -F`，用 `agent_token.txt` 与 `login_password.txt` 的字面值搜索，0 命中。**口径限制**：只能证明“当前值”没进历史；若历史上提交过已轮换的旧值，此法查不到（路径级扫描也没发现任何 `.secrets` 文件曾被加入） |
| README/docs 索引与现实一致 | **FAIL → 已修** | `docs/README.md` 有 12 个文档未收录（m21-test-notes、m27–m37）；根 README 协议表停在 v8（实际已到 v10）、功能清单标注“以 M15 代码为准”；`spa/README.md` 仍写 M10 的缓存名/更新流程和“SPA 没有单元测试”。修正见 §5 |

---

## 5. 本次修掉的小问题（docs/tools）

1. **根 README**
   - 功能清单从“以 M15 代码为准”更新到 M38：补上会话组织（置顶/标签/筛选/⌘K/搜索跳转）、用量看板（缓存命中率、按模型）、
     导出 v2 + 批量导出 + 单文件备份、附件缩略图与 10 个/10 MB 上限、数学公式、离线 outbox 与草稿、PWA 白屏自愈；
   - 协议表 `v1 + 累加修订到 v8` → **v10**，补 v9（用量看板）与 v10（附件历史与回取）两行；
   - `tools/` 行补上 `verify_release.py`、`relay_lockstep.py`、`live_spa_probe.mjs`；`tests/` 行点明 `e2e_m19` / `e2e_m29` / `mobile_e2e`；
   - “诚实的边界”补一条 outbox 边界（浏览器看不见 agent 中途掉线；未确认条目不自动重发）；
   - “开发与测试”更新为 21 个插件套件 + vitest 305 + 两套 e2e 的实际入口。
2. **`docs/README.md`**：补 M16–M38 的索引（M16–M26 无单独报告，按提交主题一句话；M27–M37 链接报告；
   M30 明确写“探测后跳过”，M38 指向本文件），并把 `m21-test-notes.md` 收进表格。
3. **`spa/README.md`**（五处 M10/M21 时代的事实错误）：
   - Service Worker 缓存名 `webchannel-static-v1` → 构建期注入的 `webchannel-static-<buildId>`；
   - 更新流程改写为 M29 的实际行为：页面只调 `registration.update()` 并等 `controllerchange`（4 s 上限）后 reload，
     **清缓存由 worker 的 `activate` 负责**，页面从不删缓存；防循环标记在 `localStorage`（60 s 冷却 / 同一 build 10 min 重试），
     不是 sessionStorage；补一段内联 splash + 12 s 看门狗；
   - localStorage 键表补齐 `drafts` / `chatTags` / `promptLibrary` / `pinnedChats` / `outbox`；删掉“SPA 自身没有单元测试套件”，
     改成 vitest 19 个文件；源码结构表补 `src/lib/`。
4. **新增 `tools/verify_release.py`**：一条命令重跑 §1 的全部检查（含确定性重建 ZIP、归一化字节比对、`/health`、`/poll`、
   看门狗标记，以及 §0 的“是否带 relay env 构建”判别）。只读，ZIP 重建写在临时目录。
5. **新增 `tools/relay_lockstep.py`**：把 §2.3–2.6 的规则变成可重跑的 8 条断言，防止以后只改一边。
6. **新增 `tools/live_spa_probe.mjs`**：用真实 Chromium 打开线上 SPA，打印首访的登录框/端点切换/WebSocket 列表；
   `--login` 才会切到云端并提交 `.secrets` 的口令（不打印），用于复现 §0。只读（不发消息）。
7. **`AGENTS.md`** 补第 6 批约定（M37 outbox 边界 + M38 验收方法，含“只比字节不够，必须确认 build 带了 relay env”），见文末条目。

---

## 6. 只记录、不动手的问题

§0 是本次唯一的大发现（部署配置），本节是其余五个非阻塞问题。

### 6.1 测试套件会重写被跟踪的产物（卫生，需要策略决定）

- 现象：`tests/e2e_m29.mjs` 默认 `OUT_DIR=./m29-shots`，每次运行都重写 5 张被跟踪的 PNG；`tests/e2e_cf.mjs` 每次运行都会
  清空并重写被跟踪的 `tests/e2e_cf.frames.log`。M37 提交里就留下了这 5 张 PNG 的未提交改动（本次扫荡开始时它们已经是 modified）。
- 影响：任何一次跑测试都会让工作区变脏，`git status 干净` 这条卫生要求永远无法通过；且截图内容依赖渲染，diff 无意义。
- 怀疑方向：要么把 `*-shots/` 和 `frames.log` 移出跟踪（改为 CI artifact），要么让两个脚本默认写到 `.gitignore` 的目录，
  只在显式 `OUT_DIR` 时才写仓库内。前者改仓库策略、后者改测试默认行为，都超出“文档收尾”，留给后续决定。
- 本次处理：显式 `OUT_DIR=/tmp/m38-shots/...` 跑两套 e2e；`e2e_cf` 重写的 `frames.log` 已 `git checkout --` 还原。
  开工前的 5 张 PNG 原样保留，未还原、未提交。

### 6.2 SPA 模型选择器没有 mock 端到端覆盖（测试缺口，不是 bug）

- 现象：`tests/e2e_m19.mjs` 的 mock 会回答 `models` 帧，但整份 505 条断言里没有一条打开 `.model-picker` 或发送 `set_model`；
  唯一驱动选择器的是 `tests/mobile_e2e.mjs`，它打生产、要登录、只做布局测量，不点选模型。
- 影响：M7 的“切换模型”链路目前只有插件单测（`test_m7`：帧形状、`E_MODEL`、凭据不外泄）+ 真实 QwenPaw 的 `e2e_m7.mjs`
  （需要本地 `:8088`，本次环境没有运行中的 QwenPaw）在兜底；SPA 侧点击 → `set_model` → `model_changed` → header 更新
  这条 UI 路径没有回归保护。
- 怀疑方向：在 e2e_m19 的 mock 里加一小段（mock 已支持 `models`，只需补 `set_model`→`model_changed`），成本不高，
  但要扩 5000 行的套件，属于独立任务。

### 6.3 `/health` 的 `agentLastSeen` 容易被误读（可观测性，设计如此）

- 现象：线上 `agentOnline:true` 而 `agentLastSeen:null`。
- 原因：它是 DO 内存字段，hibernation 重建后归零；`hb` 按设计不盖章（M7.3），所以空闲时一直是 `null`，直到下一次 hello/业务帧。
- 影响：看板/人工排查可能误判为“刚重连过”或“字段坏了”。`relay-cf/README.md:30-34` 已写明，但根 README 的健康检查一行没提。
- 建议：要么在 `/health` 里区分 `null`（未知）与 `0`，要么在 README 的部署小节加一句解释；本次只记录。

### 6.4 托管容器里实际安装的插件版本无法从外部验证

- 现象：plugin-dist 上的 ZIP 是 HEAD 的 `plugin/`（§1.9 已证），但容器里装的是不是这个包，外部只能间接判断
  （插件在跑、status/models/msg 正常）。
- 影响：本次 HEAD 没有动插件，所以这不影响本篇的一致性结论；但它意味着“容器里跑的就是 plugin-dist 那个包”
  仍然只是推断。将来有插件改动时，部署后必须进控制台看 `GET /api/plugins` 的版本，或让探活带一个版本字段。
- 本次未做：没有进容器，也没有改插件。

### 6.5 协议文档仍未收录 M8 的附加帧（既有文档缺口，文档自己已标注）

- 现象：`protocol/frames.md` §2.4/§2.5 没有 `chats`、`del_chat`、`rename_chat`、`get_prompts`、`set_prompt`、`skills` 这几组帧；
  `docs/README.md` 的 M8 行一直写着“协议文档尚未收录这批附加帧”。
- 影响：实现和 SPA 都在用这些帧（M8 起），但新读者只能从 `plugin/frames.py` 反推字段；不算行为不一致，属于规范欠账。
- 本次未做：补协议章节需要逐个核对字段/错误码，属于独立任务，且不在“小修”范围。

---

## 7. 套件结果（本次全部重跑）

| 套件 | 结果 |
|---|---|
| `spa && npm test`（vitest） | **305 / 305**（19 个文件） |
| `plugin/tests/test_*.py` | **21 / 21** 套件 `ALL PASS`（`~/workspace/qwenpaw-local/venv/bin/python`） |
| `relay-node && npm test` | **PASS** |
| `relay-cf && npx tsc --noEmit` | **OK** |
| `node tests/e2e_m19.mjs` | **505 / 505**（221.2 s） |
| `node tests/e2e_m29.mjs` | **26 / 26** |
| `node tests/e2e_cf.mjs`（wrangler 4.153.0 `--local`，干净 DO state） | **10 / 10 断言** |
| `python3 tools/verify_release.py` | **23 PASS / 1 FAIL**（FAIL = §0 的部署缺陷，退出码 1） |
| `python3 tools/relay_lockstep.py` | **8 / 8 PASS** |
| `node tools/soak_probe.mjs`（生产） | **ok:true**，端到端 6 746 ms |

CI 门控说明：本次改动只有 `docs/`、根 `README.md`、`AGENTS.md`、`spa/README.md` 与 `tools/` 下 3 个新脚本（2 个 `.py` + 1 个 `.mjs`）。按 `.github/workflows/ci.yml`
的 `paths`，纯 docs 提交不触发任何 job；`tools/**` 会触发 `plugin` job（`plugin/tests/test_*.py` 全量），本轮已本地跑过并全绿。
没有提交、没有推送，所以 CI 未实际运行。

---

## 8. 复现

```sh
# 发布一致性（只读；ZIP 重建在临时目录）
# 目前会以退出码 1 结束：24 项里 23 PASS，唯一 FAIL 是 §0 的部署缺陷
python3 tools/verify_release.py

# 两个 relay 的规则 lockstep
python3 tools/relay_lockstep.py

# 生产探活（会新建一个 soak-* 会话并消耗一次模型调用）
node tools/soak_probe.mjs

# 线上 SPA 首访行为（只读；--login 才会用 .secrets 的口令，不发消息）
node tools/live_spa_probe.mjs

# 功能冒烟（本地 mock，不碰生产）
OUT_DIR=/tmp/m38-shots/m19 node tests/e2e_m19.mjs
OUT_DIR=/tmp/m38-shots/m29 node tests/e2e_m29.mjs

# relay-cf 行为（需要 wrangler + relay-cf/.dev.vars）
rm -rf relay-cf/.wrangler/state
(cd relay-cf && ./node_modules/.bin/wrangler dev --local --port 8788)
node tests/e2e_cf.mjs
```

`verify_release.py` 可用 `M38_SPA_BASE` / `M38_RELAY_BASE` / `M38_PLUGIN_ZIP` 指向别的部署做同一套检查；
没有 `spa/dist` 时，逐字节比对那几项会打印 SKIP（其余检查照常）。
