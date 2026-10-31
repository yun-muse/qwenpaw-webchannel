# docs — 设计文档与里程碑报告索引

这里放两类材料：**设计/实施文档**（仍然有效，可当规范读）和**里程碑报告**（按时间记录当时做了什么、怎么验证的）。报告是历史记录，里面的 URL、版本号和“下一步”可能已经过时；当前行为以代码和 [`../protocol/frames.md`](../protocol/frames.md) 为准。

## 设计与实施

| 文档 | 内容 |
|---|---|
| [`design.md`](design.md) | 总体设计：目标、组件、帧协议草案、部署与安全考虑 |
| [`IMPLEMENTATION_BRIEF.md`](IMPLEMENTATION_BRIEF.md) | 实施总纲：范围、阶段划分、验收标准 |
| [`source-notes.md`](source-notes.md) | QwenPaw v2.2.2.post1 源码笔记：流式 delta 语义、channel 基类、插件 API、审批与本地 HTTP 接口 |

## 里程碑报告（按顺序）

| 里程碑 | 文档 | 主题 |
|---|---|---|
| M0 | [`m0-report.md`](m0-report.md) | relay-node、SPA 骨架、mock agent，以及本地链路验证 |
| M1 | [`m1-report.md`](m1-report.md) | QwenPaw 插件与本地 QwenPaw 验证（第一阶段；后续里程碑补齐了剩余能力） |
| M2 | [`m2-report.md`](m2-report.md) | 审批、附件、历史、`resume`/`resync` 与 SPA 打磨 |
| M3 | [`m3-prep-report.md`](m3-prep-report.md) | 部署准备：relay-cf、SPA 登录/配置、插件打包 |
| M3 | [`m3-plan.md`](m3-plan.md) | 逐条部署清单（含验证命令与预期输出） |
| M3 | [`m3-deploy-cf.md`](m3-deploy-cf.md) | Cloudflare 侧实际部署记录与验证输出 |
| M3 | [`m3-findings.md`](m3-findings.md) | 线上发现：e2e、重启持久化、审批未触发的根因、凭据事故复盘 |
| M4 | [`m4-report.md`](m4-report.md) | SPA 刷新后恢复会话、附件上限对齐 |
| M5 | [`m5-report.md`](m5-report.md) | 协议 v2：96 KB 分块、10 MB 附件 |
| M6 | [`turso-report.md`](turso-report.md) | Turso 会话归档（写入路径与回读工具） |
| M7 | [`m7-report.md`](m7-report.md) | `/` 命令面板、模型切换、SPA 打磨 |
| M7.1 | [`m7.1-findings.md`](m7.1-findings.md)、[`m7.1-report.md`](m7.1-report.md) | 模型切换后通道静默：agent slot 代际（close 4000 致命） |
| M7.2 | [`m7.2-findings.md`](m7.2-findings.md)、[`m7.2-report.md`](m7.2-report.md) | relay 连接自愈、插件文件日志 |
| M7.3 | [`m7.3-findings.md`](m7.3-findings.md)、[`m7.3-report.md`](m7.3-report.md) | 端到端心跳 `hb`/`hb_ack`，穿透“边缘代答 ping”的假活链路 |

## M8 之后

M8 – M15 没有单独的 `*-report.md`。这些能力直接记录在协议文档和代码里：

| 里程碑 | 能力 | 从哪里读 |
|---|---|---|
| M8 | 会话列表与删除（服务端）、重命名（本地存储）；工作区提示词；技能列表 | `plugin/frames.py` 的 `chats`、`del_chat`→`chat_deleted`、`rename_chat`→`chat_renamed`、`get_prompts`→`prompts`、`set_prompt`→`prompt_saved`、`skills` 帧（`protocol/frames.md` 尚未收录这批附加帧）、`plugin/channel.py` |
| M9 | 会话推理强度 | `protocol/frames.md` §10、`plugin/util.py` 的 effort 映射 |
| M11 | 30 天登录、会话用量 | `protocol/frames.md` §11、`spa/src/relay.ts`、`relay-cf/src/index.ts` |
| M12 | Markdown 导出 | `protocol/frames.md` §12、`plugin/util.py::build_export_markdown` |
| M13 | Turso 归档全文搜索 | `protocol/frames.md` §13、`plugin/turso_search.py` |
| M14 | 移动端单手布局 | `spa/src/App.css` 的 `max-width: 720px` 段 |
| M15 | 每轮用量回执、上下文仪表 | `protocol/frames.md` §11.2、`plugin/util.py::history_messages`、`spa/src/App.tsx::ContextMeter` |

## M16 – M26

这一段没有单独的 `*-report.md`，能力以代码、协议文档和测试为准（`docs/m21-test-notes.md` 记录了测试加固那一次）。

| 里程碑 | 能力 | 从哪里读 |
|---|---|---|
| M16 | 各组件 README（根 / plugin / spa / relay-cf）与索引 | 各目录 `README.md` |
| M17 | SPA 打磨：导出 toast、去掉误导性的 0.0s 耗时 | `spa/src/App.tsx`、`git show a9eedcb` |
| M18 | GitHub Actions CI（按路径门控）+ gitignore 卫生 | `.github/workflows/ci.yml` |
| M19 | 复制按钮、回到底部、跨设备失效会话回退、置顶、快捷键 | `spa/src/App.tsx`、`tests/e2e_m19.mjs` |
| M20 | 导出 v2：元数据头 + 每轮用量脚注；重新生成/编辑重发探测后跳过 | `plugin/util.py::build_export_markdown`、`protocol/frames.md` §12 |
| M21 | 测试加固：SPA vitest、3 个插件套件、relay-node smoke，以及 `e2e_cf` 的取舍结论 | [`m21-test-notes.md`](m21-test-notes.md) |
| M22 | SPA 体验包：深色主题、粘贴附件、每会话草稿、提示词库、44px 点击区 | `spa/src/lib/{drafts,promptLibrary}.ts`、`spa/src/App.css` |
| M23 | 会话标签与筛选、`⌘/Ctrl+K` 命令面板、搜索命中跳转 | `spa/src/lib/{palette,jump}.ts` |
| M24 | 用量看板：`stats` 帧（总量/按天/排行/覆盖）与视图 | `protocol/frames.md` §14、`plugin/util.py::aggregate_usage_stats` |
| M25 | 批量导出（进度/取消/失败计数/100 上限）；fork 探测后跳过；e2e 固定 UTF-8 locale | `spa/src/lib/bulkExport.ts`、`tests/e2e_m19.mjs` |
| M26 | 侧栏重构：单行会话、⋯ 菜单、移动端底部弹层、密度目标 | `spa/src/App.tsx`、`spa/src/App.css` |

## M27 – M39

| 里程碑 | 文档 | 主题 |
|---|---|---|
| M27 | [`m27-report.md`](m27-report.md) | 思考等级 404 是“会话还没创建”的预期状态，不再上报为错误 |
| M28 | [`m28-report.md`](m28-report.md) | 用量 v3：缓存命中/未命中/命中率、按模型明细（`—` 不冒充 0%） |
| M29 | [`m29-report.md`](m29-report.md) | PWA 白屏：构建期缓存命名空间、worker 接管后才 reload、内联 splash + 看门狗自愈 |
| M30 | [`m30-report.md`](m30-report.md) | **探测后跳过**：`/poll` 兜底不做（relay 是无状态广播，控制帧不可重放，轮询要第二套游标且抵消 DO 休眠收益） |
| M31 | [`m31-report.md`](m31-report.md) | 附件历史：`hist.files`、`att_*` opaque ref 回取、媒体根守卫（协议 v10） |
| M32 | [`m32-report.md`](m32-report.md) | 长会话流式性能：冻结头 + 活尾、`MessageView` memo；窗口化被否决 |
| M33 | [`m33-report.md`](m33-report.md) | 分发卫生：plugin-dist 是唯一 ZIP 渠道，CI 拒绝任何被跟踪的 `*.zip` |
| M34 | [`m34-report.md`](m34-report.md) | 单文件备份：手写 store-only ZIP + `index.md` + `backup.json`，与单会话导出逐字节一致 |
| M35 | [`m35-report.md`](m35-report.md) | 历史缩略图修复：`att_get` 在多个媒体根上做包含校验，而不是猜一个 `media_dir` |
| M36 | [`m36-report.md`](m36-report.md) | 数学公式：KaTeX 懒加载、占位符水合、代码豁免与货币守卫、woff2 单格式 |
| M37 | [`m37-report.md`](m37-report.md) | 离线 outbox：只在浏览器可观测的离线入队，永不自动重发已写 socket 的条目 |
| M38 | [`m38-report.md`](m38-report.md) | 生产验收扫荡（版本/中继/功能/卫生）+ 文档收尾 |
| M39 | [`m39-report.md`](m39-report.md) | agent presence：中继在槽位变化时广播 `status{agentOnline}`，SPA 页眉与 outbox 接入（协议 v11） |

进度与验证记录还可以看仓库根目录的 `AGENTS.md`（只记非显然的约定和教训）以及 `tasks/` 下的任务书。
