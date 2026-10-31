# M40 — 收尾包：测试制品政策、模型选择器 e2e、协议文档补全

**结论：** 三件尾巴一次清掉。测试套件默认输出全部改到 gitignored 的 `tests/out/`，被跟踪的
`tests/*-shots/` 与 `tests/e2e_*.frames.log` 冻结为精选证据（只有 `EVIDENCE=1` / 显式
`OUT_DIR` 才写回）；M29 的 5 张纯重跑 PNG 已恢复到 HEAD。SPA 的模型选择器补上 28 条 mock e2e
（每 pass 14 条），覆盖打开/列表/当前标记/切换/vision 提示/切换后消息的 mock 侧模型上下文。
`protocol/frames.md` 从两侧代码重新对账：55 个唯一帧类型中补录 10 个 M8 帧、修正 9 处过时描述。
全套件跑完（e2e_m19 537/537、e2e_m29 26/26、e2e_cf 16/16、vitest 305/305、插件 21/21）后
`git status --porcelain` 除本任务自身改动外为空；`tools/verify_release.py` 24/24 PASS（HEAD
仍为 `7e7986d`）。未 commit、未部署，CI 规则与托管 QwenPaw 均未触碰。

> 行号指出的是本次探查时的位置；`protocol/frames.md` 的章节号是改后的。

---

## 0. 验收摘要

| 项 | 结果 | 证据 |
|---|---|---|
| HEAD | `7e7986d`（未动） | `git log -1 --format=%h` |
| e2e_m19（完整，含 build） | **537 / 537 PASS** | `/tmp/m40-e2e-m19.log`；`checks: 537, failed: 0, 229.2s` |
| e2e_m29 | **26 / 26 PASS** | `/tmp/m40-e2e-m29.log`；`checks 26, failed 0` |
| e2e_cf（wrangler dev :8788） | **16 / 16 PASS** | `/tmp/m40-e2e-cf.log`；`E2E_CF PASS` |
| vitest | **305 / 305 PASS（19 files）** | `/tmp/m40-vitest.log` |
| 插件套件（21 个 `test_*.py`） | **21 / 21 ALL PASS** | 逐个以 `~/workspace/qwenpaw-local/venv/bin/python` 运行 |
| relay lockstep | **14 / 14 PASS** | `python3 tools/relay_lockstep.py` |
| verify_release | **24 / 24 PASS** | `head: 7e7986d`；见 §4（任务单写的 25 与工具实际项数不符） |
| 全套件后 `git status` | 只有本任务改动 | 见 §1.3 原文 |

M40 新增的 e2e 断言：**28 条**（2 个 pass × 14），所以 e2e_m19 从 M39 的 509 涨到 537。

---

## 1. 第一件：测试制品不再弄脏工作区

### 1.1 普查：每个套件的写出路径

| 套件 | 改前默认 | 改后默认 | 显式证据模式 | 备注 |
|---|---|---|---|---|
| `tests/e2e_m19.mjs` | `tests/m19-shots/` | `tests/out/m19-shots/` | `EVIDENCE=1` → `tests/m19-shots/` | `OUT_DIR` 仍可显式覆盖；M26 before/after 命令不变 |
| `tests/e2e_m29.mjs` | `tests/m29-shots/` | `tests/out/m29-shots/` | `EVIDENCE=1` → `tests/m29-shots/` | `OUT_DIR` 覆盖 |
| `tests/e2e_cf.mjs` | `tests/e2e_cf.frames.log` | `tests/out/e2e_cf.frames.log` | `EVIDENCE=1` / `LOG_FILE` | — |
| `tests/e2e_m1.mjs` | `tests/e2e_m1.frames.log` | `tests/out/e2e_m1.frames.log` | `EVIDENCE=1` / `LOG_FILE` | — |
| `tests/e2e_m2.mjs` | `tests/e2e_m2.frames.log` | `tests/out/e2e_m2.frames.log` | 同上 | — |
| `tests/e2e_m5.mjs` | `tests/e2e_m5.frames.log` | `tests/out/e2e_m5.frames.log` | 同上 | — |
| `tests/e2e_turso.mjs` | `tests/e2e_turso.frames.log` | `tests/out/e2e_turso.frames.log` | 同上 | — |
| `tests/mobile_e2e.mjs` | `tests/mobile-shots/` | `tests/out/mobile-shots/` | `EVIDENCE=1` → `tests/mobile-shots/` | 含 `<LABEL>-diagnostics.json` |
| `tests/perf_m32.mjs` | `tests/perf-m32-<label>.json`、`tests/m32-stream.png` | `tests/out/…` | `EVIDENCE=1` / `M32_OUT` | 截图仍只在 `M32_SHOT=1` 时写 |
| `tests/probe_m37.mjs` | `tests/m37-probe.json`、`m37-probe-final.png` | `tests/out/…` | `EVIDENCE=1` / `M37_OUT`、`M37_OUT_PNG` | — |
| `tests/e2e.mjs`、`e2e_m7/m71/m72`、`repro_m7*.py` | 无文件输出（stdout） | 无变化 | — | 无需改 |
| `tools/*.py`、`tools/live_spa_probe.mjs` | 只读 | 无变化 | — | `tools/soak.log` 早已在 `.gitignore` |

统一入口是新文件 `tests/artifacts.mjs`：`artifactDir(rel, explicit)` / `artifactFile(rel, explicit)`，
默认 `tests/out/<rel>`，`EVIDENCE=1` 时 `tests/<rel>`，显式路径永远优先。各脚本不再自己拼路径。

### 1.2 改动清单

- `.gitignore`：新增 `tests/out/`（带注释说明冻结证据规则）。
- `tests/artifacts.mjs`（新）：唯一的路径决策点。
- 11 个脚本接入：`e2e_m19`、`e2e_m29`、`e2e_cf`、`e2e_m1`、`e2e_m2`、`e2e_m5`、`e2e_turso`、
  `mobile_e2e`、`perf_m32`、`probe_m37`（`e2e.mjs`/`e2e_m7`/`e2e_m71`/`e2e_m72` 无输出，不动）。
- `tests/m29-shots/*.png`：按协调者结论（纯测试重跑重写、尺寸与 HEAD 一致），
  `git checkout -- tests/m29-shots` 恢复 5 张 modified 文件。
- `AGENTS.md`：补 M40 政策一行；并把 M38 条目里“e2e_m29/e2e_cf 会重写被跟踪文件”标注为已被本政策取代。

### 1.3 硬验收：全套件后的实测 `git status`

在 e2e_m19 → e2e_m29 → e2e_cf → vitest → 21 个插件套件全部跑完后**立刻**执行
`git status --porcelain`，原样输出（16 行）：

```text
 M .gitignore
 M AGENTS.md
 M docs/README.md
 M protocol/frames.md
 M tests/e2e_cf.mjs
 M tests/e2e_m1.mjs
 M tests/e2e_m19.mjs
 M tests/e2e_m2.mjs
 M tests/e2e_m29.mjs
 M tests/e2e_m5.mjs
 M tests/e2e_turso.mjs
 M tests/mobile_e2e.mjs
 M tests/perf_m32.mjs
 M tests/probe_m37.mjs
?? tasks/m40-wrapup-task.md
?? tests/artifacts.mjs
```

除本任务自身改动（外加协调者下发的任务单）之外为空：没有任何 `*-shots/*.png`、
`*.frames.log`、`perf-m32-*.json`、`m37-probe*` 被重写。该快照早于本报告的写入；之后唯一的
新增是 `docs/m40-report.md`（以及 `docs/README.md` 的 M40 索引行），仍属本任务自身改动。补充证据：

```text
$ git diff --stat -- tests/m19-shots tests/m29-shots tests/m26-shots tests/mobile-shots \
    tests/e2e_cf.frames.log tests/e2e_m1.frames.log tests/e2e_m2.frames.log \
    tests/e2e_m5.frames.log tests/e2e_turso.frames.log tests/perf-m32-*.json tests/m37-probe.json
(空)

$ du -sh tests/out
14M     tests/out
$ find tests/out -maxdepth 2 -type d
tests/out
tests/out/m19-shots
tests/out/m29-shots
$ git check-ignore -v tests/out
.gitignore:11:tests/out/    tests/out
```

`tests/out/` 里是这次跑出来的 13 MB m19 截图与 7 张 m29 截图，全部被忽略。

> 说明：`spa/dist` 是 gitignored 的构建产物。全套件验收时 e2e_m19 会以“本地演示”配置重建它；
> §4 的 release 校验前又按生产 env 重建了一次（未部署）。两次都不影响 `git status`。

---

## 2. 第二件：模型选择器 mock e2e

### 2.1 mock 侧扩展（`tests/e2e_m19.mjs`）

- `MOCK_MODELS`：4 个模型、2 个厂商，按厂商连续排列 —
  `mock/mock-1`（active, vision:true）、`mock/mock-2`（vision:true）、
  `acme/acme-pro`（vision:false）、`acme/acme-vision`（vision:true）。
- `case 'models'` 回 `state.models`，所以 `active` 会跟随切换，等价于插件在 PUT 之后重新投影
  `ProviderInfo`。
- 新增 `case 'set_model'`：记录每一次请求（`state.modelLog`），不存在的 pair 回
  `error{code:"E_MODEL"}`（与 `channel.py::_handle_set_model` 的校验失败形状一致）；成功则更新
  `state.activeModel`、回 `model_changed`，再补一条插件身份 `status`（真实插件在
  `channel.py:1361` 也这么做）。
- `case 'msg'` 的 `state.received` 记录增加 `model: state.activeModel` —— **mock 可观测的模型上下文**。

### 2.2 断言（每 pass 14 条，共 28 条）

1. 打开选择器，行数 == 服务端列表数；
2. 每行都有厂商 chip，且行的顺序保持服务端的厂商连续顺序；
3. 恰好一行 current：`aria-selected="true"` + `.model-row-check`，其余 `aria-selected="false"`；
4. 表头计数 `切换对话模型 (4)`；
5. `.model-label` 显示当前 `mock / mock-1`；
6. `vision:true` 的模型不出现图片提示；
7. 切到 `acme/acme-pro`：`model_changed` 后 label 更新、busy 清空、**选择器按设计关闭**
   （`App.tsx` 的 `model_changed` 分支 `setPickerOpen(false)`）；
8. mock 正好收到一次 `set_model{acme, acme-pro}`；
9. `vision:false` 使 `.vision-hint` 显示“图片可能不可见”；
10. 重新打开：唯一 current 行是 `acme-pro`，带 ● 和 `aria-selected`；
11. 切换后发一条消息，mock 恰好收到一次；
12. 该消息到达时 mock 的 `activeModel` 是 `acme/acme-pro`；
13. 消息之前没有更晚的 `set_model` 抢跑；
14. 切回 `mock-1`：label 复原、提示消失、重新打开后 current 正确。

### 2.3 诚实边界（没有假断言）

- 选择器是**平铺列表 + 每行厂商 chip**，没有 group header，因此“厂商分组”断言的是
  “每行有厂商 + 服务端厂商连续顺序被保留”，没有声称存在分组标题。
- 线上 `msg` 帧**不携带 model 字段**（模型是 agent 级状态），所以不能用它做“消息里的模型”断言。
  可观测的是：mock 收到的 `set_model` pair、以及它按该 pair 维护的 `activeModel` 在 `msg` 到达时的值。
  这两者都真实来自 wire，不需要改产品代码。
- 开发过程中确认了一个既有行为：`model_changed` 会关闭选择器（`spa/src/App.tsx:4026`）。最初两条断言
  按“选择器保持打开”写，实测失败后改为“关闭是设计行为 + 重新打开验证 active”，未动产品代码。

**产品代码改动：无。**

---

## 3. 第三件：`protocol/frames.md` 补全

### 3.1 枚举方法

从四个来源取 `t` 字面量并取并集：

- `plugin/frames.py` 的全部 `{"t": ...}` 构造函数；
- `plugin/channel.py` 的入站分派（`_on_relay_frame`）；
- `relay-node/server.js` 与 `relay-cf/src/index.ts` 的本地处理/转发分支（`hello`/`hb`/`ping`/`ready`/`peer`/`status`/`error`/`pong`/`hb_ack`）；
- SPA 的发送点（`App.tsx`、`relay.ts`、`lib/attachments.ts`）与入站 `switch (frame.t)`。

### 3.2 帧清单对账表

| 项 | 数量 | 代表帧名 |
|---|---|---|
| 代码中的唯一帧类型 | **55** | 见下面三组 |
| ├ 中继本地（不转发） | 7 | `hello`、`hb`、`hb_ack`、`ping`、`pong`、`ready`、`peer`（`error` 与插件共用） |
| ├ container → browser | 29 | `start`、`evt`、`end`、`msg`、`approval`、`resync`、`error`、`hist`、`chats`、`chat_deleted`、`chat_renamed`、`prompts`、`prompt_saved`、`skills`、`models`、`model_changed`、`status`、`effort`、`usage`、`stats`、`export_begin/chunk/end`、`search_results`、`att_begin/chunk/end`、`file_ready`、`file_error` |
| ├ browser → container（独占名） | 19 | `msg`/`hist`/`chats`/`skills`/`models` 共享；独占：`stop`、`approve`、`deny`、`resume`、`del_chat`、`rename_chat`、`get_prompts`、`set_prompt`、`set_model`、`get_effort`、`set_effort`、`get_usage`、`get_stats`、`export`、`search`、`att_get`、`file_begin`、`file_chunk`、`file_end` |
| `frames.md` 原有唯一帧类型 | **45** | 上面 55 个减去 §17 的 10 个 |
| **新增** | **10** | 下行 6：`chats`、`chat_deleted`、`chat_renamed`、`prompts`、`prompt_saved`、`skills`；上行 4：`del_chat`、`rename_chat`、`get_prompts`、`set_prompt` |
| **修正** | **9** | 5 个帧条目 + 3 个错误码 + 1 个文档头（下表） |
| 既有条目未改动 | 40 | 45 − 5 个被修正的帧类型 |

修正明细：

| # | 位置 | 原文档 | 实际代码 | 改法 |
|---|---|---|---|---|
| 1 | 文档头 | “v1 / draft, M0” | 信封 v1 + 累加修订到 v11 | 改为 “v11 / current” |
| 2 | §2.3 | 有一行 `pong` | 容器从不发 `pong`，只有两个中继回答 `ping` | 删除该行；`pong` 只在 §2.2/§2.5 |
| 3 | §2.4 | `ping` 列在 browser → container | 中继本地回答，永不转发（`relay-node/server.js:182`、`relay-cf/src/index.ts:352`） | 新增 §2.6 “browser → relay (answered locally)” 并移过去 |
| 4 | §2.4 | `hist` 有 `before?` | 插件只读 `limit`（`hist_limit`，默认 50） | 删 `before?`，写明 `limit` 语义 |
| 5 | §2.3 | `approval` 无 `seq` | 经 `_emit` 编号（`channel.py:2383`） | 字段补 `seq?` |
| 6 | §2.3 | 没有 `error` 行 | 插件/中继都会发，字段比 `code/id` 多 | 补完整行（`chat/req_id/detail/status/reason/seq?`） |
| 7 | §6 `E_AUTH` | 只表示连接级鉴权失败 | SPA/relay 用 `chat`+`req_id` 区分审批拒绝（`relay.ts:260`） | 写清重载语义 |
| 8 | §6 `E_BUSY` | “该 chat 已有运行中的生成” | 实际是 relay-cf 的 30 帧/s 限流通知（`index.ts:571`），最多 1 条/秒 | 改成限流语义，并说明不是投递回执 |
| 9 | §6 `E_RESYNC` | 声称是 resume miss 的错误码 | 当前插件改发 `resync` 帧；`E_RESYNC` 只被 SPA 当兼容别名处理（`relay.ts:268`） | 标为 legacy alias |

新增错误码（不属于帧类型计数）：`E_PROMPT` —— `set_prompt` 的文件名/内容不合法或写入失败
（`channel.py:2204-2221`），已加入 §6。

新增 §17 的字段/语义（全部是 **control frame**，无 `seq`、不入 ring buffer、不重放）：

| 帧 | 方向 | 字段 | 关键语义 |
|---|---|---|---|
| `chats` | 双向 | 请求无字段；回复 `items:[{chat,title,updated_at}]` | 空列表不可信，不得据此清理本地会话/pin/tag |
| `del_chat` → `chat_deleted` | 双向 | `chat`；回复 `chat` | 删除 `ChatSpec`；未知会话也 ack，无 `E_*` |
| `rename_chat` → `chat_renamed` | 双向 | `chat,title`；回复同 | **仅浏览器显示名**，插件不写 `ChatSpec.name` |
| `get_prompts` → `prompts` | 双向 | 回复 `files:{SOUL.md,AGENTS.md,PROFILE.md,MEMORY.md}` | 缺失/不可读为 `""`，读取截断 65536 字符 |
| `set_prompt` → `prompt_saved` | 双向 | `file,content`；回复 `file` | 四白名单文件、≤65536 UTF-8 字节；否则 `E_PROMPT` |
| `skills` | 双向 | 回复 `items:[{id,name,description}]` | 取 `/api/skills` → registry → `agent.json`，去重、去 disabled |

`status` 的双 producer 保持 §16 的写法：插件身份帧（`agent_name`，可带 `provider`/`model`，无
`agentOnline`）与 relay presence（`agentOnline`，无 `agent_name`）字段互斥；§2.5 加了一句指引。
`docs/README.md` 的 M8 行也去掉了“协议文档尚未收录”的旧注记，改指 §17。

---

## 4. 收尾：release 校验

在改动**未提交**、HEAD 仍为 `7e7986d` 时执行：

```text
$ python3 tools/verify_release.py
...
PASS  version.json git == repo HEAD — live='7e7986d' head='7e7986d'
PASS  live bundle == fresh HEAD build (build id normalized) — 541881 vs 541881 chars
PASS  plugin-dist ZIP matches dist/webchannel.zip — e11d72ec641d8d392f8c30cb06934dae
PASS  package_plugin.sh rebuild of plugin/ == live ZIP — rebuilt=e11d72ec… live=e11d72ec…
PASS  relay /health ok — {"ok": true, "agentOnline": true, "clients": 0, "agentLastSeen": null}
PASS  /poll is still 501 (documented deferral) — 501

checks: 24, failed: 0, head: 7e7986d
M38 RELEASE SWEEP PASS
```

- **任务单写“应为 25/25”，但 `tools/verify_release.py` 当前只有 24 项检查**（`results` 长度即 24；
  该文件自 M38 起未改，`git log -- tools/verify_release.py` 只有 `e931747`）。这不是跳过了某项：
  24 项名称全部打印且全 PASS。第 25 项不会出现的原因也可解释——入口 bundle 内联了每次构建都变的
  build id，内容哈希必然与线上不同，`asset /assets/index-*.js` 那一项因本地同名声明的文件不存在而
  `continue`；只有 css 与懒加载 KaTeX 资产进入逐字节比较。为避免“凑数”没有改工具。
- **第一次运行曾 1 项 FAIL**：`live bundle == fresh HEAD build`（541881 vs 542576 chars）。
  原因是全套件验收时 e2e_m19 用**本地演示 env** 重建了 `spa/dist`，而线上是带生产
  `VITE_RELAY_WS`/`VITE_RELAY_HTTP` 的构建——正是 M38 工具注释里“spa/dist must be the build you
  just deployed”的前提。按 M39 报告 §5 第 6 条的同一命令用生产 env 重建（**不部署**）后，
  得到 541881 chars、24/24 PASS。这一条按原样记录，不掩盖。
- 额外跑了 `python3 tools/relay_lockstep.py`：**14/14 PASS**（两个 relay 的 generation/hb/presence 仍同步）。
- 本任务没有改 `plugin/`、`spa/src/`、`relay-node/`、`relay-cf/`、`.github/`；插件 ZIP 的
  MD5（`e11d72ec…`）与线上一致，说明“没动产品代码”不是推断而是可验证的。

---

## 5. 约束核对

| 约束 | 状态 |
|---|---|
| 不 `git commit` | 未提交；HEAD `7e7986d` |
| 不部署 | 未部署；只做了本地 build + read-only 校验 |
| `ci.yml` 触发/路径规则一字节不动 | `git status` 无 `.github/` 变更 |
| 不碰托管 QwenPaw | 未进容器、未调用管理接口；只读 `/health` 与 public ZIP |
| 不打印机密 | 全程未输出 `.secrets` / `.dev.vars` / token（`e2e_cf` 只读本地 dev 值，不打印） |
| 产品代码最小化 | 第二件只改 `tests/e2e_m19.mjs`，产品代码零改动 |

---

## 6. 文件清单

改动（`git diff --stat`）：

```text
 .gitignore           |   5 ++
 AGENTS.md            |   3 +-
 docs/README.md       |   3 +-
 protocol/frames.md   | 168 +++++++++++++++++++++++++++++++----
 tests/e2e_cf.mjs     |   5 +-
 tests/e2e_m1.mjs     |   7 +-
 tests/e2e_m19.mjs    | 246 +++++++++++++++++++++++++++++++++++++++++++++++++--
 tests/e2e_m2.mjs     |   7 +-
 tests/e2e_m29.mjs    |   7 +-
 tests/e2e_m5.mjs     |   7 +-
 tests/e2e_turso.mjs  |   9 +-
 tests/mobile_e2e.mjs |   7 +-
 tests/perf_m32.mjs   |  12 ++-
 tests/probe_m37.mjs  |  18 +++-
 14 files changed, 453 insertions(+), 51 deletions(-)
```

新增：`tests/artifacts.mjs`、`docs/m40-report.md`（本文件）。
