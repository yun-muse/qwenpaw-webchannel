# M33 — 插件分发制品防漂移（spa/public/webchannel.zip）

背景：`spa/public/webchannel.zip` 是一份被 git 跟踪的插件包二进制（2026-10-27 的旧包），与 `plugin/` 源码、与正式分发渠道（plugin-dist Pages 项目上的 `dist/webchannel.zip`）之间没有任何同步机制，是个已知的漂移雷。但刚核实过两个事实，动手前必须再验证并纳入决策：

- `spa/public/sw.js` 明确把 `/webchannel.zip` 列为「不拦截」路径，注释称其为 plugin distribution archive——即 SPA 站点根路径下确实在对外提供这个文件；
- QwenPaw 控制台装插件支持「or from URL」，历史上 URL 下载在托管容器里被代理 426 挡住（所以才有本地路径安装路线），但用户在自己网络环境下未必被挡——不能排除有人/有文档在引用 SPA 站的这个 URL。

## 探查任务

1. 全仓+文档搜索谁引用了 SPA 站的 `/webchannel.zip`（README、docs、SPA 界面里的下载入口、脚本）：有引用列出处；无引用也要给出搜索范围作为证据。
2. 核对该 ZIP 当前内容与 `plugin/` 源码、与 plugin-dist 现行包的差异（文件清单+关键文件哈希），量化「漂移了多少」。
3. 两个候选方案各写利弊：
   - A 下架：从 git 移除该文件，SPA 站该 URL 404；若有引用先改引用指向 plugin-dist；
   - B 同步化：构建时由 `plugin/` 自动生成该 ZIP（构建产物不进 git 或进 git 但有 CI 漂移检查），保证它永远等于现行插件包。
   给出推荐及理由，写进 `docs/m33-report.md`，由协调者复核拍板后实施（协调者：若证据显示零引用且 plugin-dist 已是唯一正式渠道，选 A 并加防回归；若存在真实引用，选 B）。

## 实施要求（按选定方案）

- 方案 A：`git rm` 该文件；加 CI 检查（或构建期检查）：git 跟踪的二进制制品清单守卫，防止 `.zip` 类构建产物再被提交进 `spa/public/` 与仓库源码区（`dist/` 本来就不跟踪，不要误伤本地回滚包流程）；SW 中关于 `/webchannel.zip` 的豁免逻辑如无其他用途可保留无害，但注释要更新为事实。
- 方案 B：构建脚本生成 ZIP 到 public（gitignore 之），CI 增加漂移断言（重新生成与发布物比对）；文档写明该 URL 的定位。
- 两种方案都要：更新相关 README/docs 里过时的分发描述（如有）。

## 约束

- 不许动 plugin-dist 的正式分发流程与 `dist/` 本地回滚包约定。
- 既有套件全绿并报数（注意 `spa/tests/sw.test.ts` 里有 `/webchannel.zip` 不拦截的用例，方案 A 下要相应调整并说明）。
- CI 路径门控不许动（本任务若改 workflow，只能在既有文件内加 job/step 且不得改变触发路径规则——如确需改触发规则，先在报告里停下来说明，等协调者确认）。
