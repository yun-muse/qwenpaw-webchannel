# M38 — 生产验收扫荡 + 文档收尾（收官项）

背景：M3 上线以来功能叠了三十多个里程碑，单项验收都过，但缺少一次「以真实生产环境为准」的全量扫荡。本任务做最后的系统性核对：线上到底是不是以为的样子。

## 扫荡清单（逐项给 PASS/FAIL + 证据，写进 `docs/m38-report.md`）

以公开线上环境为准（SPA https://qwenpaw-webchannel-spa.pages.dev 、中继 health、plugin-dist），能用仓库已有工具（tools/ 下的探活/e2e_cf 等）就用，没有的写一次性检查脚本放 tools/ 并说明：

1. 版本一致性：SPA version.json 的 git/build 与仓库 HEAD 一致；线上 sw.js 的 BUILD 戳与之一致；plugin-dist 的 webchannel.zip 与仓库 dist/ 构建产物 MD5 一致。
2. 中继：/health 返回 agent 在线口径正常；relay-cf 与 relay-node 的协议关键语义（hb、槽位世代）在代码层面仍 lockstep（diff 关键路径）。
3. 功能在线冒烟（通过本地 mock 或既有 e2e 套件证明即可，托管真人验收由 Muse 另做）：登录、在线状态、发消息往返、模型列表与切换、思考等级（已存在会话改档生效）、用量统计（含缓存与 by_model）、全文搜索、单会话导出、批量导出、备份打包、附件发送与历史回看、PWA 版本检查与看门狗存在性（线上 index.html 里能查到内联看门狗代码）。
4. 仓库卫生：`git status` 干净；无被跟踪的二进制制品（M33 守卫口径）；.secrets 未入库（git 历史抽查口径说明）；README/docs 索引与现实一致。

## 文档收尾

- 根 README 与 docs/README.md 里程碑索引补齐 M27–M38（含 M30 跳过结论），功能清单与现状对齐（如附件、备份、用量 v3、白页修复）。
- 仓库 AGENTS.md 补本批次新约定（如有：如公式渲染的代码豁免规则、outbox 与草稿边界、缩略图 fixture 必须用真实 hist 形状）。

## 约束

- 扫荡中发现的小问题（文案、文档、明显小 bug）可顺手修并在报告里列明；**大问题只记录不上手**（写清现象与怀疑方向，留给后续决策）。
- 本任务以 docs/tools 为主；如改了 spa/plugin 代码，走完整测试+部署流程并在报告里说明。
- 既有套件全绿并报数（docs-only 的提交按路径门控不触发 CI，属正常）。
