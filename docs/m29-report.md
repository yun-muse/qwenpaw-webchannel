# M29 · 手机 PWA 冷启动白页 — 探查与修复报告

> 基线：`fc78d72`（M28）。下文所有“修复前”行号均指 `git show fc78d72:<file>`，
> “修复后”行号指当前工作区。未提交。

---

## 0. 结论摘要

1. **白页不是 Service Worker 的 cache-first 造成的。** 旧 SW 的导航请求本来就是
   network-first（`sw.js:65-74,95-98`），而且它从不缓存 `index.html`（导航分支没有
   `cache.put`；只有 `/assets/` 走 cache-first，`sw.js:100-103`）。所以“SW 返回旧
   HTML”不成立；旧 SW 的离线兜底 `caches.match('/index.html')`（`sw.js:69`）实际上是
   死代码。
2. **真正的代码级根因是 M10 的更新路径：先删光所有缓存，再立刻 reload。**
   `version.ts:106-129` 先 `registration.update()`（109，只等到“检查完成”，不等到新
   worker 接管），再 `caches.delete` 全部缓存（114-119），最后 `location.reload()`
   （128）。旧 `sw.js` 的缓存名是常量 `webchannel-static-v1`（`sw.js:18`），构建也
   从不改 `sw.js` 的字节（`vite.config.ts:50-58` 没有 SW 插件），所以
   `registration.update()` 通常什么都不装——删缓存是页面的唯一一次清理，
   reload 时缓存必然为空。**只要 reload 后那一次 hashed JS 请求失败（长时间休眠后
   手机刚醒、射频未就绪，正是用户描述的场景），就没有任何 JS 执行。**
3. **`index.html` 没有任何不依赖 bundle 的启动画面/错误路径。**
   旧 `index.html:30-33` 只有空的 `#root` + module script；构建后 module 在 head 里
   最先执行（`dist/index.html:324`）。bundle 一失败，文档就是纯白，永远不会自己恢复，
   也没有任何提示——这解释了“必须杀掉 PWA 再开”。
4. **三闸放在 sessionStorage 里，恰好扛不过冷启动。** `version.ts:41-47,121-126`
   只写 sessionStorage；PWA 被杀 = 顶层浏览上下文销毁 = sessionStorage 清空。于是每次
   冷启动都重新走一遍“清缓存 → reload”，防死循环的闸门在真正出事的那一次完全不生效。
   白页本身不执行 JS，`reloadedFor` 的“改弹横幅”分支（157-165）也没有机会运行。
5. **复现已跑通。** 用真实的 Chromium + 持久化 profile，让旧的 M28 构建走
   “v1 在线加载并注册 SW → 换 v2 + reload 时让一次 bundle 请求失败”：
   旧构建稳定得到纯白页（`rootText:"", hasApp:false, splash:false`），再手动 reload
   即恢复——与“杀掉重开就好”一致。新构建**同一序列**（场景 6）：启动画面 → 一次自救 → app 挂载。
6. **强制新鲜没有退化。** 在线导航仍然永远先走网络；每个 build 都换 SW 缓存命名空间并
   在 `activate` 里清旧桶；离线只用“同一次构建缓存下来的 shell”，且仅在网络真正失败
   （或 5s 超时）时才用。新 buildId：**`fc78d72-1793352139638`**。

---

## 1. 假设清单与证据排序

### 1.1 逐条判定

| # | 假设 | 判定 | 证据（修复前 `fc78d72`） |
|---|---|---|---|
| 1 | SW 以 cache-first 返回旧 `index.html`，其 hashed assets 已被清掉/404 → JS 不执行 → 白页；杀掉重开时 SW 更新/缓存重建才恢复 | **不吻合（作为 SW 机制）**；结果本身仍可能，但来源是浏览器 HTTP 缓存，未被证明 | 导航分支是 network-first：`sw.js:65-74` 先 `fetch`，只有抛错才 `caches.match('/index.html')`；`sw.js:95-98` 把它用于 `mode==='navigate'`。导航成功时**没有任何 `cache.put`**（对比 `cacheFirst` 37-48、`networkFirst` 50-63），所以 `index.html` 根本不在 Cache Storage 里，第 69 行的兜底永远 miss。`/assets/` 才是 cache-first（100-103）。浏览器侧：`_headers:4-5` 对 `/index.html` 只给 `no-cache`（允许在 revalidate 失败时复用旧副本），没有 `must-revalidate`——这是“旧 HTML + 新部署”唯一可能的上游，但本次没有设备日志能证明它发生过。 |
| 2 | “清缓存 → reload”与 SW update 的时序竞态：新 SW 未 controlling 就 reload，页面落到半清缓存 | **吻合（代码确定），且是主因** | `version.ts:106-129`：`await registration.update()`（109）只等到 update 检查结束；`caches.keys()` → 全删（114-119）；`location.reload()`（128）之间没有 `controllerchange`、没有等新 worker、也没有验证新 shell 可加载。旧 SW 的 `CACHE_NAME` 是常量（`sw.js:18`），且 `sw.js` 在不同 build 间字节相同（`vite.config.ts:56` 只挂 `react()` + version.json 插件），所以 update 通常不安装新 worker——**缓存被页面清空后，旧的同一个 worker 继续控制页面，reload 的所有 asset 请求都必须打到网络**。任何一次失败 = 0 个 JS。`activate` 里虽然有 `claim()`（`sw.js:25-35`），但它在旧构建里既不会被触发（没有新 worker），也不解决“清空后网络失败”。 |
| 3 | sessionStorage 在 PWA 冷启动（进程被杀后重建）时保留还是清空？三闸在“第一次白屏、杀掉重开又好”里各扮演什么角色？ | **吻合：清空；三闸跨不过冷启动** | `version.ts:41-47` 的 `readSession` 只读 sessionStorage；`121-126` 只写 sessionStorage。sessionStorage 的生命周期是顶层浏览上下文：reload 保留，标签/进程销毁即清空（Chrome/Android 的 PWA 杀掉进程就是这种情况；即便个别 WebView 会恢复页面，也不能把防循环建立在它上面）。冷启动 → `reloadedFor=null`、`lastReloadAt=0` → 每次都判定为“第一次”，再次 purge+reload。三闸的实际作用：①`reloadedFor`（157,162）只在 reload 后的同一标签里生效；②60s 冷却（158-160）同样在同一标签；③手动横幅（162-165）需要 JS 能跑——白页时不存在。因此“杀掉重开”不是三闸救的，而是一次全新的导航碰上了网络已就绪的新进程。 |
| 4 | version.json 拉取失败/超时（休眠后网络未就绪）时启动流程走到哪一步，会不会卡住渲染？ | **不阻断渲染（吻合“不会卡渲染”）；但没有超时，watcher 会卡住** | `version.ts:151` 的 `fetch` 没有 `AbortController`/超时；失败被 168 行吞掉，`inFlight` 在 `finally` 里复位（170-172），但 fetch 永不 settle 时 `finally` 也不会跑 → 之后的 visibilitychange 检查全部被 147-148 的 `inFlight` 挡住。它**不阻断首屏**：`main.tsx:7-14` 先 `createRoot(...).render(...)`，`startVersionWatch()` 在最后。真正会长时间等待的是 `activateUpdate` 里的 `registration.update()`（109），但那也不是首屏渲染，而是更新路径。 |
| 5 | `index.html` 若被缓存，shell 里有没有不依赖 JS bundle 就能显示的东西？现在是不是纯白底空 root？ | **吻合（这是把“一次资源失败”放大成“永久白页”的原因）** | 旧 `index.html:30-33`：`<div id="root"></div>` + `<script type="module" src="/src/main.tsx">`，没有内联样式、没有启动 DOM、没有 error 监听、没有 `<noscript>`。构建后 module 被 Vite 提到 `<head>` 且带 hashed 文件名（`dist/index.html:324`），CSS 也是 hashed link。module 404/503 → 0 个 JS → 纯白，直到用户杀进程。`App.css` 的 `body{background:var(--bg)}`（`App.css:157-163`）也要等 CSS 加载后才生效，之前就是 UA 白底。 |

### 1.2 额外发现（不在原假设里，但同属这条链路）

- **导航没有超时。** 旧 `sw.js:65-74` 的 `await fetch(request)` 可以无限挂起；SW 进程刚被系统回收、射频未就绪时，`respondWith` 不 settle，浏览器就一直是白页。这与删缓存无关，是第二条白页路径。新实现加了 5s 超时（`sw.js:97-115`）。
- **离线兜底是死代码。** 旧 `sw.js:69` 的 `caches.match('/index.html')` 永远找不到东西，因为没有任何代码缓存它。所以真正离线时用户看到的是浏览器错误页，而不是白页；这也反证 H1 的“SW 旧 shell”不成立。
- **导航不检查 `response.ok`。** 旧 `sw.js:66-68` 把 404/5xx 的 HTML 也当 shell 返回；运营商门户/错误页会被当成 app 外壳显示。
- **旧 SW 的 `activate` 清理条件永远不会命中新 build。** `CACHE_NAME` 是常量（`sw.js:18`），所以 `names.filter(name !== CACHE_NAME)` 只可能删掉别的库；换版本时它不会清理自己的旧资源。

### 1.3 根因排序

1. **主因（代码确定 + 已复现）：M10 的“先删光缓存、再 reload”没有证明新 shell 可加载。** 缓存为空时，reload 的 hashed bundle 只要失败一次，就没有 JS；这是用户“长时间没开、冷启动”最容易撞上的时刻。
2. **放大器（代码确定）：shell 没有任何不依赖 bundle 的启动画面/自救路径。** 任何一次 JS 失败都从“可恢复的错误”变成“永久白页”。
3. **使问题反复出现（代码确定）：三闸只在 sessionStorage 里。** 杀进程后闸门归零，下一次冷启动又从头 purge+reload。
4. **次要/未证明：浏览器 HTTP 缓存里的旧 `index.html` 配已删除的 hashed asset。** `no-cache` 允许 revalidate 失败时复用旧副本，但本次没有设备侧证据；新实现的自救会清 Cache Storage 并用 network-first 导航，即使这是真凶也能恢复。
5. **次要：`/version.json` 无超时。** 它不阻断首屏，只会让 watcher 停摆；不属于白页根因。

**残余不确定性：** 没有用户手机的远程日志，无法确定那次 reload 后具体是哪个请求失败（bundle？CSS？还是导航本身挂起）。三种情况都被同一套修复覆盖：导航 5s 超时 + 缓存 shell、bundle 的 error 监听、12s 看门狗。复现证明了“purge → reload → 一次 bundle 失败 → 白页”这条机制在真实 SW 下成立，但不等于证明了用户设备上的那一次失败就是它。

---

## 2. 修复设计

### 2.1 Service Worker（`spa/public/sw.js`）

- **缓存命名空间带 build id**：`const BUILD = '__WE_CHANNEL_BUILD__'` → `webchannel-static-<build>`（`sw.js:28-30`）。
- **构建期注入**：`vite.config.ts:50-79` 的 `serviceWorkerBuildPlugin` 在 `writeBundle` 把占位符替换成 `buildInfo.build`，并在占位符丢失时直接让构建失败。这样每次部署 `sw.js` 字节都会变 → 浏览器一定会安装新 worker。
- **清理权归 `activate`**：先删所有非当前命名空间的缓存，再 `clients.claim()`（`sw.js:41-53`）。页面不再参与清缓存。
- **导航 network-first + 超时 + 可用 shell**：`navigation()`（`sw.js:97-115`）成功时把响应存到稳定的 `/index.html` 键；只有 `fetch` 抛错或 5s 超时才回退缓存的 shell；4xx/5xx 原样返回、绝不缓存成 shell。
- `/assets/` 保持 cache-first（内容 hash 不可变，且只被同一代 shell 引用）；`/version.json`、`/sw.js`、`/webchannel.zip`、跨域、非 GET 保持直通。

### 2.2 版本更新（`spa/src/version.ts`）

- **页面不再删缓存**（整个 `caches.delete` 段移除）。
- `activateUpdate`：先挂 `controllerchange` 监听，再 `registration.update()`（4s 上限），等新 worker 接管（4s 上限），然后写标记并 reload（`version.ts:179-195`）。最坏情况 8s，但不会在“新 worker 未接管 + 缓存已空”的状态下 reload。
- **标记改 localStorage**：`webchannel.reloadedFor` / `webchannel.lastReloadAt`（`readLocal`/`writeLocal`，`version.ts:54-73`），跨杀进程保留。
- **防循环逻辑抽成纯函数**：`spa/src/lib/versionGuard.ts`。同一 build 已 reload 过 → 10 分钟内只弹横幅；任意 reload 后 60s 内只弹横幅；时间戳在未来（时钟回拨）也按“最近”处理。
- **探测超时**：`AbortController` + 6s（`version.ts:197-211`）；所有失败继续静默，且 `startVersionWatch()` 仍在 `render()` 之后调用。

### 2.3 内联启动画面与看门狗（`spa/index.html`）

- `#boot-splash` 是纯 HTML + 内联 CSS（`index.html:29-135`），在 `#root` 之前，深色主题用 `[data-theme='dark']` 跟随 M22 的预置主题。品牌、`正在启动…`、进度条全部不依赖 App.css / bundle。
- `#boot-watchdog` 是内联 IIFE（`index.html:138-318`）：
  - 12s 内未挂载 → 自救一次；script / stylesheet 加载失败、动态 import/chunk 失败 → 立即自救（`error` capture + `unhandledrejection` 文案匹配）。
  - 自救 = `caches.keys()` → 删除所有缓存 → `location.reload()`；清缓存最多等 1.5s，绝不因为 Cache Storage 卡住而不 reload。
  - 标记 `webchannel.selfHealAt` 带时间戳；localStorage 不可用时回退 sessionStorage。10 分钟内再次失败不自动 reload，而是把启动画面切成可见的“启动没有完成，可能是网络不稳定。”+「重新加载」按钮（`index.html:240-290`）——用户永远看不到纯白。
  - `window.__webchannelBootReady()` 由 app 调用；`App` 顶层 `useEffect` 在第一次 commit 时调用 `notifyAppMounted()`（`App.tsx:1646-1650`，`lib/boot.ts`），登录门与工作区两个分支都会撤除启动画面。
- 测试钩子：`window.__webchannelBootDeadlineMs` 可缩短 deadline；`window.__webchannelBoot` 暴露 `fail/dismiss` 给 e2e。产品路径不依赖它们。

### 2.4 强制新鲜为什么没退化

- 在线时导航始终 `fetch` 优先，`cache.put` 只是为“网络失败”留后路；不存在 cache-first 返回旧 HTML 的分支。
- 每次部署 `sw.js` 字节必变 → 新 worker 安装 → `activate` 清旧命名空间；旧资源不会跨 build 复用。
- 更新仍由 `/version.json` 的 buildId 不一致触发；`version.ts` 只在确认新 worker 接管后才 reload。
- 旧缓存只在“网络真正失败/超时”时作为 shell 使用，而且它与同代 assets 在同一个命名空间里，不会出现“旧 shell + 已删 assets”的半清状态。

---

## 3. 复现与验证

### 3.1 旧构建白页复现（真实 Chromium + 持久化 profile）

前置：改动前把 M28 的 `spa/dist` 快照到 `/tmp/m29-v1-dist`。

```sh
cd tests
M29_SKIP_BUILD=1 M29_ONLY=legacy M29_LEGACY_DIR=/tmp/m29-v1-dist node e2e_m29.mjs
```

步骤（`tests/e2e_m29.mjs::scenarioLegacy`）：

1. 用持久化 profile 打开旧 v1，等 `.app`、等 SW `controller`，再 reload 一次确保旧 assets 进入 SW 缓存。
2. 服务器切到 v2（复制 dist、重命名 hashed 资源、改 `version.json`，但**不**改 bundle 里的 build id——这是“旧客户端”）。
3. 触发 `visibilitychange` → 旧 `version.ts` 看到 build 不一致 → 删光所有缓存 → reload。
4. reload 后的 v2 bundle 请求只失败一次（503），模拟手机刚醒的射频。
5. 断言页面状态。

实际结果：

```
[m29-e2e] ok   legacy: pre-M29 build ends on a white page —
  {"rootText":"","hasApp":false,"splash":false,"splashState":"","retry":false,"healAt":0}
[m29-e2e] ok   legacy: a manual reload recovers (kill-and-reopen equivalent)
```

即：**旧构建确实能在真实 SW 下复现纯白页**；手动 reload（等价于杀掉重开）后恢复。截图：`tests/m29-shots/m29-legacy-blank.png`。这不是“用户设备日志”，但把 H2+H3+H5 的机制端到端跑通了。

**复现边界（卡在哪一步）：** 任务书设想的是“v1 注册 SW → 换 v2 + 清缓存 → **冷重启** → 旧 shell 白页”。这一步没法按字面构造，因为旧 SW 从不缓存 `index.html`（导航分支没有 `cache.put`，见 §1.1 H1），冷重启的导航永远是网络优先——只要网络能返回 v2 HTML，就不会拿到“旧 shell”。真正的白页需要“HTML 已到、hashed JS 失败”，而旧代码唯一会主动清空缓存、把页面推到下一次网络请求的时刻，就是版本更新后的那个 reload。所以 legacy 复现用 `visibilitychange` 触发同一段 `activateUpdate`，再让 reload 后的首个 bundle 请求失败一次；这正是 H2 的完整路径。冷重启这一维度由场景 2（离线冷重启）和场景 4（坏 shell 冷启动）用真实的 context 关闭/重启单独覆盖，只是它们跑的是新构建。**没有伪造“冷重启直接白页”的复现。**

### 3.2 新构建的六个场景（`tests/e2e_m29.mjs`，26 项断言）

| 场景 | 验证点 | 结果 |
|---|---|---|
| 1 正常冷启动 | bundle 延迟 700ms 时启动画面可见（品牌 + 正在启动），挂载后 `#boot-splash` 被移除，无 pageerror | 通过（截图 `m29-1-splash.png` / `m29-1-app.png`） |
| 2 离线冷重启 | 关闭 context（杀进程）→ 同一 profile 离线打开 → network-first 失败 → 缓存 shell → app 挂载；启动画面先出现 | 通过（`m29-2-offline.png`） |
| 3 版本自动更新 | v1 → 服务端换 v2 → visibilitychange → 新 SW 接管 → reload 到 v2 bundle；缓存只剩 `webchannel-static-<v2>`；无手动横幅 | 通过（`m29-3-updated.png`） |
| 4 坏 shell 自救 | 冷启动拿到“JS 404”的 shell → 启动画面可见 → 清缓存 + 一次 reload → app 挂载；`selfHealAt` 有时间戳 | 通过（`m29-4-healed.png`） |
| 5 防死循环 | 永久坏 shell → 第一次自救 → 第二次进入 cooldown，显示“启动没有完成”+「重新加载」，2.5s 内无额外导航 | 通过（`m29-5-stuck.png`） |
| 6 更新 + 单次失败 | 与 legacy 完全相同的序列跑新构建：v1 → v2 + reload 后首个 bundle 503 → 启动画面 → 一次自救 → app；v2 bundle 请求 2 次（503/200），无手动横幅，v2 缓存命名空间保留 | 通过（`m29-6-update-healed.png`） |

场景 4 的具体过程：先在线加载一次（SW 就绪）→ 关闭 context → 服务器只对下一次导航返回坏 shell（`index.html` 指向不存在的 `/assets/index-M29BROKEN.js`）→ 冷启动 → script error → 自救 reload → 第二次导航拿到好 shell → app。导航计数 +2，证明只自救了一次。

### 3.3 单元级守卫（vitest）

- `spa/tests/bootWatchdog.test.ts`：用 `node:vm` 直接执行 `index.html` 里**真实的**内联脚本（不是重写一份），覆盖 12 个用例：12s deadline、挂载撤除并取消定时器、清缓存 + reload、10 分钟 cooldown 的 stuck 卡、超时后再次自救、script error 立即自救、stylesheet 致命 / icon 忽略、chunk rejection、挂载后不再自救、Cache Storage 缺失/挂起（1.5s 上限仍 reload）、localStorage 被禁时回退 sessionStorage、deadline override。
- `spa/tests/sw.test.ts`：在 VM 里执行真实的 `public/sw.js`，覆盖 13 个用例：build 注入/缓存名、install skipWaiting、activate 先删旧命名空间再 claim（顺序断言）、导航在线缓存 shell、离线回退、无 shell 时 reject（不挂死）、404 不缓存也不替换 shell、5s 超时回退、`/version.json`/`/sw.js`/`/webchannel.zip` 直通、跨域/非 GET 直通、assets cache-first、失败 asset 不缓存。
- `spa/tests/versionGuard.test.ts`：8 个用例覆盖首次更新、同 build 横幅、10 分钟重试、60s 冷却、时钟回拨、NaN/负数时间戳、测试窗口覆盖。

---

## 4. 套件结果（2026-10-30）

| 套件 | 命令 | 结果 |
|---|---|---|
| 插件 | `~/workspace/qwenpaw-local/venv/bin/python plugin/tests/test_*.py` | **19/19 套件 ALL PASS** |
| vitest | `cd spa && npm test` | **14 文件 / 195 tests 全过**（M29 新增 3 个测试文件） |
| Playwright 全量 | `cd tests && M19_SKIP_BUILD=1 node e2e_m19.mjs` | **338/338 checks，0 failed** |
| M29 PWA | `cd tests && node e2e_m29.mjs` | **26/26 checks，0 failed** |
| M29 legacy 复现 | `M29_SKIP_BUILD=1 M29_ONLY=legacy M29_LEGACY_DIR=/tmp/m29-v1-dist node e2e_m29.mjs` | **5/5 checks**（其中 2 项为“旧构建白页 / 手动 reload 恢复”证据） |

**构建：**

- buildId：`fc78d72-1793352139638`
- git：`fc78d72`
- time：`2026-10-30T09:22:19.617Z`
- `dist/sw.js` 已含该 buildId，且无 `__WE_CHANNEL_BUILD__` 残留；`dist/index.html` 含 `id="boot-watchdog"`。
- 注意：工作区尚未提交，`git` 段仍是 `fc78d72`。提交后重新构建会得到新的短哈希 + 新时间戳；Muse 核对线上时应以部署产物里的 `version.json` 为准，而不是本报告的本地 buildId。

---

## 5. 用户真机下次应观察到什么

1. **正常冷启动**：点开 PWA 立刻看到暖色启动画面（Q 标记 + QwenPaw WebChannel + 正在启动…），几百毫秒到几秒内进入聊天界面；不再有纯白页。
2. **网络未就绪/坏缓存**：启动画面停留，文案变成“正在修复启动…”，自动 reload 一次后进入 app。若同一个设备 10 分钟内再次失败，停留在可见的“启动没有完成，可能是网络不稳定。”+「重新加载」，不会无限闪屏。
3. **版本更新**：和 M10 一样自动更新——打开或切回前台时检测到新 build，等新 SW 接管后只 reload 一次，进入新版本；旧缓存由新 SW 在 `activate` 中清掉。
4. **首次安装且完全离线**：仍然无法启动（没有任何 shell 可缓存）；此时浏览器显示自己的错误页，而不是白页。这是唯一未改变的限制。

---

## 6. 已知边界 / 后续

- **12s 是折中。** 极慢网络（2G/弱信号）下可能误判一次自救；10 分钟标记保证不会连环 reload，最坏是多一次加载。若线上反馈误报，可把 deadline 提到 15–20s，代价是坏缓存时多等。
- **新 SW 在旧页面还活着时 `activate` 并清旧桶。** 当前 SPA 是单 bundle、无动态 import，旧页面不会再请求旧 hashed 资源；一旦将来引入 code-splitting，需要重新评估（例如保留上一代命名空间到下一个激活周期）。
- **自救只清 Cache Storage，不 unregister SW。** 这符合任务书的“清缓存+reload”。如果 `sw.js` 本身在服务端被破坏（语法错误），需要用户手动更新/重装；这种情况下看门狗仍会给出可见的重试卡，而不是白页。
- **e2e 的 v2 部署是模拟的**：复制 dist、重命名 hashed 资源、改 `version.json` 与 `sw.js` 的 build，并把 bundle 里内联的 `__BUILD_ID__` 替换成新值。真实部署由 `vite build` 的 `define` + SW 插件完成；若只重命名文件而不改 bundle 内的 build id，“新页面”会仍认为自己是旧 build 并弹更新横幅（第一次跑场景 3 就踩到了，已写进 AGENTS.md）。
- **自救后的 reload 若导航本身也失败**，浏览器会显示自己的网络错误页（不是白页），并受 10 分钟标记保护；此时没有缓存 shell 可回退，用户需要手动重试。
- **本次没有在真机/真实运营商网络上验证**，只有本机 Chromium + 持久化 profile 的冷重启。残余不确定性见 §1.3。
