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

进度与验证记录还可以看仓库根目录的 `AGENTS.md`（只记非显然的约定和教训）以及 `tasks/` 下的任务书。
