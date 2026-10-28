# spa — QwenPaw WebChannel 前端

浏览器端单页应用：React 18 + TypeScript + Vite 5，构建产物是一个可安装的 PWA。它只做三件事——连接 relay、渲染帧、把用户操作变成协议帧；消息、会话、推理强度等业务状态以 QwenPaw 为准，本地只保留恢复界面所需的缓存。

相关文档：[`../protocol/frames.md`](../protocol/frames.md)（帧协议）、[`../plugin/README.md`](../plugin/README.md)（后端行为）、[`../relay-cf/README.md`](../relay-cf/README.md)（生产 relay）。

## 开发

```bash
cd spa
npm install
npm run dev        # http://localhost:5173
```

不设置任何环境变量时，SPA 是纯本地开发形态：连 `ws://127.0.0.1:8787/ws/client`，没有登录门。

### 构建期配置

| 变量 | 默认 | 作用 |
|---|---|---|
| `VITE_RELAY_WS` | `ws://127.0.0.1:8787/ws/client` | relay 的客户端 WebSocket 地址 |
| `VITE_RELAY_HTTP` | 空 | relay 的 HTTP 根地址（`POST /api/login`）；**非空即开启登录门** |

两个值都在构建时被内联（`src/config.ts`），改值必须重新构建。页面走 HTTPS 时 `VITE_RELAY_WS` 必须是 `wss://`，否则会被混合内容策略拦下。

### 构建与预览

```bash
npm run build      # tsc --noEmit && vite build → dist/
npm run preview
```

构建会做完整类型检查（`tsc --noEmit`），任何类型错误都会让构建失败。

## 部署到 Cloudflare Pages

```bash
cd spa
VITE_RELAY_WS=wss://<relay-host>/ws/client \
VITE_RELAY_HTTP=https://<relay-host> \
npm run build

npx wrangler pages deploy dist \
  --project-name qwenpaw-webchannel-spa \
  --branch main
```

`--branch main` 必须带：第一次部署如果不指定分支，wrangler 会继承当前 git 分支，产物会落到 **preview**，生产根路径返回 404 "Deployment Not Found"（`../docs/m3-deploy-cf.md`）。

`public/` 会原样复制到 `dist/`，因此 Pages 站点同时提供：

- `/manifest.webmanifest`、`/sw.js`、图标；
- `/webchannel.zip` — QwenPaw 插件的安装包，可作为 `POST /api/plugins/install` 的 `source` URL。

### 缓存头

`public/_headers` 是 Pages 的响应头配置：

| 路径 | Cache-Control |
|---|---|
| `/`、`/index.html`、`/sw.js`、`/manifest.webmanifest`、`/webchannel.zip` | `no-cache` |
| `/version.json` | `no-store` |
| `/assets/*` | `public, max-age=31536000, immutable` |

## PWA 与强制刷新

### Service Worker

`public/sw.js` 是手写、无构建步骤的 worker，缓存名是版本标签 `webchannel-static-v1`：

- `install` 不预缓存任何东西，直接 `skipWaiting()`；`index.html` 优先走网络，避免重新部署被旧缓存掩盖。
- `activate` 删除所有非当前缓存并 `clients.claim()`。
- 导航请求 network-first，离线时回退到缓存的 `/index.html`；`/assets/*` cache-first（文件名带哈希，可永久缓存）；其余同源 GET network-first。
- **永不拦截**：跨源请求（relay 的 WS/HTTP）、非 GET 请求（登录 POST）、`/version.json`、`/webchannel.zip`、`/sw.js` 本身。

### version.json 与 `__BUILD_ID__`

`vite.config.ts` 在配置求值时生成一份构建标识：

- `build` = `<git short hash>-<Date.now()>`
- `git` = `git rev-parse --short HEAD`（失败时为 `unknown`）
- `time` = ISO 时间

同样三个值通过 `define` 注入为 `__BUILD_ID__` / `__BUILD_GIT__` / `__BUILD_TIME__`，`writeBundle` 再把它们写到 `dist/version.json`（不会写进 `public/`，否则会发布一份过期探针）。

`src/version.ts` 的 `startVersionWatch()` 在 `main.tsx` 里、React 树之外启动（登录页也照样检测更新）：

1. 页面加载时和每次 `visibilitychange` 变为可见时，用 `cache: 'no-store'` 拉 `/version.json`；
2. 远端 `build` 与当前 `BUILD_ID` 不同时，先更新 Service Worker、删除所有 Cache Storage，再在 `sessionStorage` 记下 `webchannel.reloadedFor` / `webchannel.lastReloadAt`，然后 `location.reload()`；
3. 如果这个 build 已经自动刷新过，或 60 秒内刚刷新过，不再自动刷新，改为顶部横幅提示“新版本已发布，但自动更新未生效”，由用户点“刷新页面”。

开发模式或未注入构建常量时，`BUILD_ID` 是 `dev`，监视器直接不启动。

## 登录与 localStorage

登录流程：`POST {VITE_RELAY_HTTP}/api/login`，body `{password}` → `{token, expires}`。token 形如 `v1.<expires>.<sig>`，由 relay 用 `LOGIN_SECRET` 做 HMAC 签名，服务端 TTL 是 **30 天**（`../relay-cf/src/index.ts`）。

SPA 只存 token 和过期时间，**从不存密码**（`src/App.tsx::rememberAuth`）：

| key | 内容 |
|---|---|
| `webchannel.token` | relay 客户端 token |
| `webchannel.tokenExpires` | 过期时间（Unix 秒） |

`readToken()` 会先本地预检：已过期就清掉这两个 key 并显示登录页；但这只是预检，**socket 才是权威**——服务端仍会在每次升级时验签和验过期。

登录态失效的判定有两条路：

- 连接级 `E_AUTH`（没有 `chat` / `req_id`）→ 立即回登录页；
- hosted relay 在 WebSocket 升级阶段返回 401，浏览器只能看到一次“从未打开”的 close。连续 **3 次**未打开的握手后，客户端判定为认证失败并回登录页（`src/relay.ts`）。这条规则只在应用传入 `onAuthFailure`（即登录构建）时生效，本地开发会一直重试。

退出登录 / `E_AUTH` 只清 `webchannel.token` 和 `webchannel.tokenExpires`，不动会话和其他偏好。

其余本地键：

| key | 内容 |
|---|---|
| `webchannel.chats` | 会话 id 列表（刷新后恢复） |
| `webchannel.activeChat` | 上次打开的会话 |
| `webchannel.chatNames` | 用户自定义的会话标题 |
| `webchannel.effort` | 每个会话的推理档位 |
| `webchannel.theme` | `light` / `dark` |
| `webchannel.endpoint` | 本地预览时的 `local` / `cloud` 端点选择 |

`sessionStorage` 另有两个仅用于更新流程的键：`webchannel.reloadedFor`、`webchannel.lastReloadAt`。

## 移动端布局（M14）

断点是 `max-width: 720px`（`src/App.css`）：

- 顶栏只有一行：汉堡菜单 + 标题 + 连接状态 + 溢出菜单；`top-secondary` 和身份信息在窄屏隐藏，次要操作收进溢出菜单。
- 侧栏变成抽屉：宽 `min(82vw, 300px)`，带遮罩和显式关闭按钮，滑入滑出。
- 主要可点区域按 44×44 px 设计（新建会话、搜索框、会话操作、发送/附件等），部分为 48/56 px。
- 输入区在窄屏重排为“工具行 + 强度/发送行”；上下文仪表只保留进度条和 `上下文 ≈N%`，点按展开明细（`min-height: 28px`，这一行是刻意排除在 44 px 点击目标审计之外的，见 [`../AGENTS.md`](../AGENTS.md)）。

移动端的布局与截图复核记录在 `../tests/mobile-shots/`。

## 用量仪表与每轮回执（M15）

**上下文仪表**（`ContextMeter`，位于输入框上方）：

- 有 `context_tokens` + `context_limit`：细进度条 + `上下文 ≈N%`；75% 起变琥珀色，90% 起变红色；桌面端同一行再显示会话累计 `↑<input> ↓<output>`。
- 只有 `context_tokens` 没有 limit：退化为 `上下文 ≈<n>` 文本，不显示百分比。
- 只有累计值：只显示 `↑… ↓…`；两者都没有则不渲染。

点按仪表会展开一块小面板，显示精确数字（千分位）、累计值和“最近一轮结束后刷新”的说明。

**每轮回执**（`MessageView` 的 `.bubble-foot`）：

- 第一项就是 `≈本轮 ↑<input> ↓<output>`，`≈` 只在 QwenPaw 标记为估算时出现；没有 `turn` 的轮次什么都不显示（不是 0）。
- tooltip 给出精确 token、合计和 `耗时 <s>s（含工具调用）`。
- 移动端回执独占一行，位于复制/重新生成按钮上方。

数据来源是 `hist.messages[].turn` 和 `usage.last_turn`；两者的 `id` 是同一个去重键。SPA 在打开/切换会话、每轮结束后（延迟 1.2 s 等后端落盘）、`model_changed` 之后和每次进入 `live` 时重新请求 `get_usage`。

## 源码结构

| 文件 | 内容 |
|---|---|
| `src/main.tsx` | React 入口；在 React 树之外启动版本监视 |
| `src/App.tsx` | 几乎全部 UI 与协议处理：会话/消息状态、流式渲染、附件、模型、技能、提示词、审批卡、导出、搜索、用量、命令面板 |
| `src/relay.ts` | `RelayClient` 状态机：连接、退避重连、`resume`、按 `seq` 去重、25 s `ping`、认证失败判定 |
| `src/config.ts` | 构建期 relay 地址与登录开关 |
| `src/version.ts` | 构建标识、`/version.json` 轮询、强制刷新与手动横幅 |
| `src/prompts.ts` | 启动提示词、默认技能、费曼式人设文本 |
| `src/App.css` | 主题变量、消息/侧栏/输入区样式、M14 移动端断点、M15 仪表与回执 |
| `public/sw.js` | Service Worker（见上） |
| `public/manifest.webmanifest` | PWA manifest（standalone，中文，暖陶色主题） |
| `public/_headers` | Pages 缓存头 |
| `public/icons/`、`public/apple-touch-icon.png` | 图标 |
| `public/webchannel.zip` | 插件安装包 |
| `scripts/gen_icons.py` | 生成图标 |

## 测试

仓库根目录的 `tests/` 有 Playwright / WebSocket 端到端脚本（`e2e_*.mjs`、`mobile_e2e.mjs`），它们需要本地 QwenPaw、relay-node 和 Playwright 浏览器；截图基线在 `tests/mobile-shots/`。SPA 自身没有单元测试套件，类型检查由 `npm run build` 的 `tsc --noEmit` 覆盖。
