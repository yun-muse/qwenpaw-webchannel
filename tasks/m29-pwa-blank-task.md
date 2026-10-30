# M29 — 手机 PWA 冷启动白页根治

用户反馈：手机 PWA 放了很久没打开，下一次冷启动时总是先弹一个 blank 白页，必须把 PWA 结束（杀进程）再重新打开才正常。用户原话：「在手机PWA上放了很久没打开下一次冷启动的时候，手机总是弹一个blank的白页，然后要吧这个PWA结束了，重新打开PWA才正常」。

## 现有实现（M10，先逐行核对）

- 手写 Service Worker：`spa/public/sw.js`（无 workbox）。
- `spa/src/version.ts`：启动 + `visibilitychange` 时以 no-store 拉 `/version.json` 比对 buildId；不一致 → SW update → **清全部缓存** → reload。
- 防死循环三闸：sessionStorage 已重载标记、60 秒冷却、重载后仍是旧版则改弹纯 DOM 手动刷新横幅。
- Pages `_headers`：index.html 与版本文件不进长缓存。
- Vite 构建产物为带 hash 的 assets 文件名；buildId = git 短哈希+时间戳。

## 探查任务（列假设、按证据排序，不许拍脑袋改）

逐条审计冷启动链路，对每个假设标注「吻合/不吻合」及依据（读 `sw.js`、`version.ts`、`index.html`、`_headers`、vite 配置）：

1. SW 以 cache-first 返回旧 index.html，其引用的 hashed assets 已被「清全部缓存」删掉或新部署后 404 → JS 不执行 → 纯白页；杀进程重开时 SW 更新/缓存重建才恢复——是否吻合？
2. 「清缓存 → reload」与 SW update 的时序竞态：新 SW 尚未 controlling 时 reload，页面落到半清状态的缓存上？
3. sessionStorage 在 PWA 冷启动（进程被杀后重建）时到底保留还是清空？三闸在「第一次打开白页、杀掉重开又好」这组现象里各扮演什么角色？
4. version.json 拉取失败/超时（长时间休眠后网络未就绪）时启动流程走到哪一步，会不会卡住渲染？
5. index.html 本身若被 SW 缓存，shell 里有没有任何不依赖 JS bundle 就能显示的东西（现在是不是纯白底空 root）？

若条件允许，在 Playwright（SW 开启）下构造复现：v1 加载并注册 SW → 换 v2 dist/version 模拟新部署+缓存被清 → 冷重启页面，验证白页出现/修复后消失。构造不出完整复现就写明卡在哪一步，改为对具体守卫逻辑做单元级验证，不许假装复现过。

## 修复要求（保住「强制新鲜」的前提下修）

用户硬要求：PWA 必须强制新鲜（M10 的初衷），修复**不许**退化成长期用旧缓存。方向按探查证据取舍：

- 导航请求改 network-first，仅网络失败才回退缓存 shell；
- 清缓存与新 SW 接管的顺序修正（skipWaiting/clients.claim 语义核对），不许在缓存半清状态下 reload 到坏 shell；
- **启动看门狗**：内联在 index.html 的纯 HTML/CSS/JS（不依赖 bundle）——显示最低限度启动画面（品牌+加载中），若 N 秒内 app 未挂载或动态资源加载失败 → 一次性自救（清缓存+reload），自救标记放 localStorage 带时间戳，跨杀进程也能防死循环；app 成功挂载即撤除启动画面；
- 资源加载失败（script/chunk error）也要能触发同一条自救路径，而不是白页到底；
- version 检查流程的任何异常都不许阻断首屏渲染。

## 测试与交付

- vitest 覆盖看门狗/防循环判定等纯逻辑；Playwright 覆盖：正常冷启动无白页（启动画面→app）、模拟坏缓存时自救恢复、版本自动更新既有行为不回归。
- 既有套件全绿并报数；构建后报新 buildId 供 Muse 核对线上。
- 报告写 `docs/m29-report.md`：假设清单与证据排序、选定根因（或最可能根因+残余不确定性）、修复设计、复现/验证方式、用户真机下次应观察到的现象。
