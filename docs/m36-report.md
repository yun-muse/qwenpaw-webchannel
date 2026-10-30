# M36 — 数学公式渲染（KaTeX，懒加载）

结论先行：用 **KaTeX 0.16.22**，marked 扩展只产出惰性占位符，KaTeX + CSS + 字体在**第一条含公式的消息出现时**才通过 dynamic import 拉取。首屏 JS 从
530.37 kB（gzip 178.01 kB）变为 534.42 kB（gzip 179.33 kB），只增加 **+4.05 kB / +1.32 kB gzip**；公式运行时的 262.55 kB（gzip 77.49 kB）在主包之外。全部套件全绿：
插件 21/21 套件（394 个测试函数）、vitest 18 文件 / 279 项、`e2e_m19` **447 项 0 失败**、`e2e_m29` 26/26。

---

## 1. 探查：现有管线、`$` 的处理、扩展点

### 1.1 现有 Markdown 管线

| 位置 | 作用 |
| --- | --- |
| `spa/src/App.tsx:720` `renderMarkdown()` | 整条消息：`md.parse` → `DOMPurify.sanitize` |
| `spa/src/App.tsx:745` `splitMarkdown()` | M32 流式分块：`md.lexer` 出 token，最后一个非空 block 留在活尾巴，之前的前缀按 token 缓存 HTML |
| `spa/src/App.tsx:918` `decorateMarkdown()` | DOM 后处理：代码高亮、`pre-copy`、表格工具条；M36 在这里接管占位符 |
| `spa/src/App.tsx:1025-1029` | `md-head` 走 `decorateMarkdown(..., true)`，`md-tail` 走 `false` |
| `spa/src/App.css:1572` | `.md-head/.md-tail { display: contents }`，两块在排版上仍是 `.md` 的直接子节点 |

### 1.2 marked 对 `$` 的现状（实测 v15.0.12）

```
marked.parse('cost $5 and $10')        -> <p>cost $5 and $10</p>
marked.parse('`$x$`')                  -> <p><code>$x$</code></p>
marked.parse('```\n$$a$$\n```')        -> <pre><code>$$a$$
```

也就是说：**`$` 不被 marked 当作任何语法**，普通段落原样保留；代码块和行内代码由 marked 先整体 token 化，内容不会再进 inline 词法器。这给了两条路：

1. 渲染后扫描文本节点 —— 简单，但 `$a_1 + a_2$` 会先被 marked 解析成 `<em>`，公式体已经被破坏；
2. 在 marked 的 **extension** 层拦截，把整个 `$...$` 作为一个 token 吃掉，再输出占位符。

选 2。`marked` 的扩展点是 `new Marked({extensions})`（`spa/src/lib/markdown.ts:11`）：
block 级 tokenizer 处理独占一行的 `$$...$$`，inline 级 tokenizer 处理段落/表格单元里的
`$...$` 与 `$$...$$`（`spa/src/lib/math.ts:232-284`）。渲染器只输出
`<span class="math ..." data-tex="..." data-math-state="pending">$...$</span>`，
此时没有任何 KaTeX 代码参与。

### 1.3 与 M32 冻结头/活尾巴的衔接

- `$$...$$` 是 **block token**：回复流到 `$$` 闭合之后，它仍是最后一个 block（活尾巴），
  不渲染；当后面的段落出现、它被推进 `md-head` 时，才由 `decorateMarkdown(head, true)`
  触发水合。
- 段落内的 `$...$` 属于该段落的 inline token；段落整体进入冻结区后才水合。
- 活尾巴 `decorateMarkdown(tail, false)` 不做任何公式替换，占位符保持字面量 `$...$`。
- 未闭合的定界符不会产生 token（`readInlineMath` / `readDisplayMath` 返回 `null`），
  marked 把它当普通文本，KaTeX 从头到尾看不到半截公式。

**踩到的坑（已修）**：`marked` 的 `md.lexer(text, options)` 会用传入的 options **替换**实例
options（包括 `extensions` 注册表）。原来的 `splitMarkdown` 传了
`MD_OPTIONS = {gfm, breaks}`，结果流式期间所有公式 token 消失，只有消息落定后
`md.parse(text)` 才渲染。现在 `md.lexer(text)` / `md.parser(tokens)` 都不再传第二参，
`md` 实例自带 `gfm/breaks`（`spa/src/App.tsx:745-771`，回归用例在
`spa/tests/math.test.ts` 的 "streaming lexer/parser path"）。这个坑值得记住：以后给 marked
加任何 per-call options 都会静默丢扩展。

---

## 2. 选型：KaTeX vs MathJax（实测数据）

两组数字都在本机取得。KaTeX 是 Vite 生产构建产物；MathJax 取其 npm 包自带的浏览器 bundle
（未经过二次打包，所以对 MathJax 略有利）。

| 维度 | KaTeX 0.16.22 | MathJax 4.1.3 |
| --- | --- | --- |
| 运行时 JS | **262.55 kB / gzip 77.49 kB**（Vite 产物） | `tex-svg.js` 1,849,625 B / **gzip 616,713 B**；`tex-chtml.js` 997,445 B / gzip 282,062 B |
| 样式 | `katex.min.css` 26.24 kB / gzip **7.56 kB** | CHTML 的样式与字体由 loader 组织；SVG 输出无 CSS 字体 |
| 字体 | 19 个 woff2，共 **256,168 B（约 250 KiB）**，20 个 `@font-face` 的 woff/ttf 回退全部被构建剥离 | CHTML 需要 `@mathjax/mathjax-newcm-font`：**105 个 woff2 / 1.8 MB**（解包 50 MB）；SVG 输出不需要字体，但 JS 就是上面的 1.85 MB |
| 冷启动 | Node：`require` 29.7 ms，首次 `renderToString` 6.4 ms | Node：`init({tex-svg})` **257 ms** |
| 稳态渲染 | **0.30 ms/式**（4 个样张 × 1000 次平均） | **2.9 ms/式**（同一台机器、同一组样张，`tex2svg`） |
| 集成方式 | 同步 `katex.render(tex, el, opts)`，一次一个元素；无全局状态、无启动器 | 需要全局 `MathJax` 启动/loader，通常 `typesetPromise()` 扫整棵子树；与 M32 的“只重绘活尾巴”模型相反 |
| 字体托管 | CSS 里 `url(fonts/*.woff2)`，Vite 自动 hash 到 `/assets/`，同源自托管 | 默认从 `[mathjax]/output/chtml/woff2` 取字体；自托管要额外同步 1.8 MB 字体目录并配置 `fontURL`，否则会落到默认 CDN |
| 错误模型 | `throwOnError:false` + 我们自己的 try/catch；不抛到消息流 | 内部错误/加载失败走全局 startup promise，容易在流式路径里产生未处理 rejection |

选择 KaTeX 的理由，按权重排序：

1. **首屏纪律**：两者都能懒加载，但 KaTeX 的懒加载包是 77.49 kB gzip，MathJax SVG 是 616.71 kB gzip——差 8 倍；CHTML 虽然 JS 小一些，但要多带 1.8 MB 字体。
2. **与 M32 结构同构**：KaTeX 是“给一个已存在的元素渲染”，正好对应“冻结块出现时才水合”；MathJax 的 `typesetPromise` 是整树扫描，会在每个 delta 上重复访问已完成块，和 M32 的缓存目标冲突。
3. **字体可控**：KaTeX 的字体是 CSS 静态引用，Vite 直接产出同源 hash 文件；MathJax 4 的字体默认走运行时 loader 路径，自托管配置更重，且很容易在离线/PWA 场景漏掉。
4. **速度**：稳态约 10×，冷启动约 1/8。公式少时差距是毫秒级，但流式场景每个完成块都会触发一次，KaTeX 的确定性更好。

代价：KaTeX 不支持 MathJax 的部分宏包（`\require`、部分 `ams` 扩展）、不内置化学式（mhchem 需另加 contrib），字体是 19 个文件而不是 SVG 内联。本项目只要求 `$...$` / `$$...$$` 的常规 LaTeX，接受这些边界。

---

## 3. 实现

### 3.1 定界符判定规则

实现分两层，规则只写一遍：

- `spa/src/lib/math.ts:54` `readInlineMath(src, start)`
- `spa/src/lib/math.ts:81` `readDisplayMath(src, start)`
- `spa/src/lib/math.ts:116` `scanMath(text)`：整文档扫描器，显式跳过 fenced code 与行内 code，供 vitest 与文档使用；生产 tokenizer 复用前两个函数（代码豁免由 marked 的 token 化顺序天然保证）。

规则（R1–R7，与 `math.ts` 顶部注释一一对应）：

| 规则 | 内容 | 例子 |
| --- | --- | --- |
| R1 | `\$` 是字面量，不能开/闭公式 | `\$x\$` → 原文 |
| R2 | 开 `$` 后不能是空白；闭 `$` 前不能是空白；空内容不算 | `$ a$`、`$a $`、`$ $` → 原文 |
| R3 | `$...$` 不跨行 | `$a +\nb$` → 原文 |
| R4 | **货币保护**：闭 `$` 后不能紧跟数字；第一个未转义的 `$` 是唯一候选闭符，候选不合法就整体放弃这个开符 | `$5 and $10` → 原文；`$2 + 2 = 4$` → 公式 |
| R5 | 找不到闭符 → 原文，不抛异常 | `$x`、`$$x` → 原文 |
| R6 | `$$` 从行首（最多 3 空格缩进）开始、闭合后只允许空格到行尾，可跨行；空内容不算 | `$$\nE=mc^2\n$$` → display |
| R7 | fenced code / 行内 code 内的 `$` 一律不处理 | `` `$x$` ``、```` ```$$a$$``` ```` → 原文 |

R4 是货币误判的核心：`$5 and $10` 里唯一可能当闭符的 `$` 紧跟 `10`，被拒绝；扫描器从下一个
`$` 重新开始，仍然找不到合法闭符，于是整段是普通文本。`$5 and $10, or $x^2$` 会在第三个
`$` 处重新配对成功（有专门用例）。

### 3.2 占位符与惰性水合

- `mathHtml()`（`spa/src/lib/math.ts:218`）输出带 `data-tex`、`data-math-state="pending"`
  的 span，内容就是字面量 `$...$`。DOMPurify 保留 `data-*` 与 class；KaTeX 不在 HTML 里。
- `spa/src/lib/mathRender.ts:16` `loadKatex()`：`Promise.all([import('katex'), import('katex/dist/katex.min.css')])`，
  Vite 把 JS、CSS、字体全部拆成独立 chunk；失败只 `console.warn`，占位符保留原文。
- `spa/src/lib/mathRender.ts:46` `hydrateMath(root)`：只处理 `pending` 节点，先标 `loading`，
  再 `katex.render(tex, node, {displayMode, throwOnError:false, strict:'ignore', trust:false})`。
  `trust:false` 禁掉 `\href`/`\url`/`\includegraphics`，避免公式成为外链/文件读取入口。
- 水合是 **DOM 驱动**的，不缓存“已渲染 HTML”：M32 每完成一个 block 会重新注入整个
  `md-head`，旧节点被替换后自然回到 `pending`，下一轮 `decorateMarkdown` 会重新渲染。
- `data-math-state` 三态：`pending` → `loading` → `done` / `failed`。CSS 对
  `pending|failed` 用等宽字体显示原文，保证 chunk 失败时不是空白。

### 3.3 流式行为

- 活尾巴不调用 `hydrateMath`（`App.tsx:1028`），`$E=mc^2$` 以占位符的字面量文本出现；
- 冻结块进入 `md-head` 的同一帧，`useLayoutEffect` 调 `decorateMarkdown(head, true)`，
  水合在 chunk 已缓存的条件下于微任务内完成；
- `e2e` 的采样记录（desktop）：
  - 122 ms：`.md-tail` 有 1 个 math 占位符，`tailKatex = 0`；
  - 280 ms：`md-head` 的行内公式 `done`，活尾巴仍在输出；
  - 922 ms：`md-head` 的块级公式 `done`，`.caret` 仍在；
  - 1.9 s：`end` 后整条落定，2 个公式全部呈现，无 `$$` 残留。

### 3.4 复制 LaTeX（加分项）

点击/轻触公式复制 `data-tex` 原文（`App.tsx:1037`），1.2 s 的绿色描边高亮由
`.math-copied` 提供（不用 `::after` 角标：块级公式本身是 `overflow-x:auto` 容器，会把
画在它上方的角标裁掉）。长按没有单独实现：移动端长按会进入系统文本选择菜单，和复制
手势冲突；点击已经覆盖手机。该行为有 e2e（`navigator.clipboard.readText()` 与 `data-tex` 相等）。

### 3.5 样式

`spa/src/App.css` 新增约 55 行：

- `.math-block` 是独立的横向滚动容器（`overflow-x:auto`），宽公式在 390px 下滚动，
  不撑开 `.messages` 或页面；e2e 实测 390px：容器 `clientWidth 322`、`scrollWidth 610`，
  页面 `scrollWidth 390`。
- `.katex { color: inherit }`，深/浅色都跟随消息正文；e2e 在两种主题下断言
  `getComputedStyle(.katex).color === getComputedStyle(.md).color`。
- 占位符（未加载/失败）用 muted 等宽字体，字号 0.9em。

---

## 4. 体积账（生产构建实测）

基线为同一台机器、同一份 `vite.config.ts`（仅去掉 M36 依赖）的构建：

| 产物 | 改前 | 改后 | 变化 |
| --- | --- | --- | --- |
| 首屏 JS `index-*.js` | 530.37 kB / gzip 178.01 kB | **534.42 kB / gzip 179.33 kB** | **+4.05 kB / +1.32 kB** |
| 首屏 CSS `index-*.css` | 60.72 kB / gzip 11.70 kB | 61.36 kB / gzip 11.86 kB | +0.64 kB / +0.16 kB |
| `index.html` | 10.71 kB / gzip 3.65 kB | 10.71 kB / gzip 3.65 kB | 0 |
| 懒加载 JS `katex-*.js` | — | **262.55 kB / gzip 77.49 kB** | 首次含公式消息才请求 |
| 懒加载 CSS `katex-*.css` | — | **26.24 kB / gzip 7.56 kB** | 与 JS 同一次 dynamic import |
| 字体 | — | **19 个 woff2，256,168 B（约 250 KiB）** | 按 KaTeX 实际用到的 family 请求 |

说明：

- 首屏增加的 4.05 kB 是 `lib/math.ts` + `lib/markdown.ts` + `lib/mathRender.ts` 的判定、
  扩展与水合逻辑；KaTeX 的运行时代码不在主包，而是独立的 `katex-*.js`（262.55 kB）。它在
  点击含公式的会话后才会出现在 `performance` 资源里；e2e 在数学无关会话上断言 `/katex/i`
  资源数为 0。
- 首次进入含公式会话的额外网络量：77.49 + 7.56 kB（gzip）加上按需字体。e2e 样张实际只
  请求 **3 个** woff2，不是 19 个；字体由 CSS 的 `font-family` 驱动，浏览器只取渲染用到的
  family。
- KaTeX 的 CSS 自带 woff2 + woff + ttf 三份。`spa/vite.config.ts:88`
  `katexWoff2OnlyPlugin` 在 Vite 处理 URL 之前把 `src:` 重写成只保留 woff2：否则会产出
  60 个字体文件、1,076,572 B（约 1.05 MiB）。现在产物里 `*.woff`/`*.ttf` 数量为 0。

---

## 5. 字体与 Service Worker

**选择：字体进运行时缓存，不进 SW 预缓存。**

- 构建后字体是 `/assets/KaTeX_*-<hash>.woff2`，命中 `_headers` 的
  `Cache-Control: public, max-age=31536000, immutable`；
- `spa/public/sw.js:141-142` 对 `/assets/` 走 `cacheFirst`：首次渲染公式时由浏览器请求，
  SW 顺手写入当前 build 的 `webchannel-static-<buildId>`；下次离线/弱网直接命中。
- 不预缓存的原因：
  1. M29 明确不在 `install` 里 precache（shell 是 network-first，避免旧壳掩盖部署）；给
     字体单开白名单会破坏这个模型；
  2. 19 个文件 256 kB 对“从不看公式”的用户是纯浪费，而 KaTeX 字体是**按 family 惰性请求**
     的，预缓存反而会把所有 family 都拉下来；
  3. 字体文件名带 build hash，`activate` 时旧 cache 整桶删除，不存在跨版本残留。
- 验证：构建产物 CSS 里是 `url(/assets/KaTeX_....woff2)`；e2e 在公式渲染后检查
  `performance` 里有 `KaTeX_*.woff2` 请求，且 `document.fonts.check('16px KaTeX_Main') === true`。
- 不依赖任何海外 CDN：字体、KaTeX JS/CSS 全部由同源 `/assets/` 提供；`sw.js` 对跨源请求
  直接放行、不缓存（M29 约束），本项目也没有新增跨源字体。

---

## 6. 测试结果（本轮复跑）

| 套件 | 结果 |
| --- | --- |
| 插件（`~/workspace/qwenpaw-local/venv/bin/python plugin/tests/test_*.py`） | **21/21 套件 ALL PASS**，394 个测试函数 |
| SPA vitest（`spa && npm test`） | **18 文件 / 279 项全绿**（新增 `math.test.ts` 29 项） |
| SPA 构建（`npm run build`：`tsc --noEmit && vite build`） | 通过 |
| Playwright `node tests/e2e_m19.mjs` | **447 项，0 失败**，192.2 s（desktop + mobile） |
| Playwright `node tests/e2e_m29.mjs` | **26/26 通过**，24.9 s |

### 6.1 vitest 覆盖（`spa/tests/math.test.ts`）

- 成对：单行 `$...$`、多个公式、跨行拒绝、`$$` 单行/多行/缩进；
- 货币：`$5 and $10`、`$100-$200`、`$5, $6, $7`、`$2 + 2 = 4$`、货币后接真公式；
- 代码豁免：fenced（``` / ~~~）、行内 code、未闭合 fence、双反引号 code span；
- 未闭合降级：`$x`、`$`、`$$x`、多行未闭合 `$$`；
- 转义：`\$x\$`、块内 `\$`；
- 占位符：`data-tex` 转义、`pending`、`$$` 展示、`data-math-state`；
- marked 集成：`$a_1 + a_2$` 不被拆成 `<em>`、代码块/行内 code 保持字面量、表格单元、
  **流式 lexer/parser 路径**（防止 per-call options 丢扩展的回归）。

### 6.2 Playwright 新增（桌面 14 项、手机 15 项，合计 29）

1. 数学无关会话不请求任何 `/katex/i` 资源；
2. 打开含公式会话才触发懒加载；
3. 历史渲染 2 个行内 + 2 个块级，4 个 `.katex`、4 个 `done`、0 个 `pending`；
4. 无 `$$` 残留，`$5 和 $10` 仍是原文；
5. 行内 code 与 fenced code 里的 `$x$` 原样；
6. 深色下公式颜色 = 正文颜色；
7. 懒加载 JS、CSS、woff2 均实际请求，`KaTeX_Main` 字体可用；
8. 深/浅两种主题颜色都继承正文；
9. 宽公式不撑宽页面；
10. （手机）390px 下宽公式有独立横向滚动（client 322 / scroll 610）；
11. 点击公式复制 LaTeX 源码；
12. 流式开始（caret 出现）；
13. 活尾巴保留字面量 `$...$` 且 tail 内 0 个 `.katex`；
14. 冻结块在流式未结束时已渲染（head 内行内 + 块级均 `done`）；
15. 落定后 2 个公式、0 个 pending、无 `$$`。

产物截图：`tests/m19-shots/m19-desktop-math-history.png`、
`tests/m19-shots/m19-mobile-math-history.png`。

---

## 7. 已知边界

- **长按复制未实现**：点击/轻触已覆盖；长按与系统文本选择冲突，故留给平台菜单。
- **KaTeX 加载失败会停留到刷新**：`loadKatex()` 把失败结果（`null`）缓存在模块级 promise 中，
  避免流式期间每个 delta 重试造成请求风暴；占位符显示原文，不会阻塞消息。
- **行内公式不跨行**：这是 R3 的刻意选择，避免把两个段落之间的 `$` 误配；需要多行请用 `$$`。
- **货币规则是启发式**：`$5 and $10$` 这种用户主动写出成对 `$` 的文本会被当成公式 `10`；
  与 KaTeX auto-render 的默认行为一致。规则已在 R4 和用例中写明。
- **KaTeX 宏包范围**：未引入 mhchem、`\require` 等 contrib；`trust:false` 禁用链接类命令。
- 未改 `.github/workflows/ci.yml`，未提交，未访问托管环境。
