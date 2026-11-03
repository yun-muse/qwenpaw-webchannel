# M41 — 手机粘贴文本被直接发送

**结论：** 粘贴本身不会发送——在桌面（1280×900）和手机（390×844、coarse pointer、iPhone 13
描述符）两个 pass 上，用**浏览器真实粘贴**（剪贴板 + `Input.dispatchKeyEvent` 的 `paste`
命令，`paste → beforeinput(insertFromPaste) → input` 全部触发、默认插入生效）分别粘贴单行、
多行、末尾带换行的文本，均 **0 条 `msg` 帧**、composer 内容逐字符保留且可继续编辑。M22 的
paste-to-attach 处理器、表单 submit、发送按钮点击合成三条候选全部排除。

能复现的隐式发送只有一条：**输入法（IME）自己的 Enter**。`onKeyDown` 在 HEAD 上对任何
非 Shift 的 Enter 直接 `send()`（`spa/src/App.tsx:5372-5375`），没有 composition 守卫；手机
上粘贴由输入法完成，输入法确认/提交（以及部分 Android 输入法提交后的回车）就以
`keydown Enter` 落到同一个处理器上——红测实测把正在输入的 `nihao` 整段发了出去、composer
被清空。修复后同一条用例 0 帧、文本留在输入框。顺带补上 Android `keyCode === 229` 这条
WebView 分支，并给 发送/停止 按钮加 `type="button"`（当前 composer 不在任何 form 里，属
语义加固而非真凶）。

> 行号是本次改动后的位置；「HEAD」指 `9c33ff4`（未 commit、未部署）。

---

## 0. 验收摘要

| 项 | 结果 | 证据 |
|---|---|---|
| e2e_m19（完整，含 build） | **589 / 589 PASS** | `checks: 589, failed: 0, elapsed: 248.0s` |
| └ 其中 M41 新增 | **52 条**（2 pass × 26） | 由 537 → 589 |
| e2e_m19 `M41_ONLY=1` 绿 | **55 / 55 PASS** | 52 条 M41 + 2 条 page-error + 1 条 locale 预检 |
| e2e_m19 `M41_ONLY=1` 红（关掉守卫） | **55 条中 6 FAIL** | 每 pass 3 条：composition 发送、composition 文本丢失、229 发送 |
| e2e_m29 | **26 / 26 PASS** | `checks 26, failed 0` |
| vitest | **312 / 312 PASS（20 files）** | 新增 `tests/keys.test.ts` 7 条 |
| 插件套件（21 个 `test_*.py`） | **21 / 21 ALL PASS** | 逐个以 `~/workspace/qwenpaw-local/venv/bin/python` 运行 |
| 全套件后 `git status --porcelain` | 只有本任务改动 | 见 §5.3 |

---

## 1. 复现矩阵

### 1.1 方法学

旧 M22 用例的「文本粘贴」是 `dispatchEvent(new ClipboardEvent('paste'))`：脚本合成的事件
**不会执行默认动作**，所以它只能证明「没有变成附件 chip」，而且断言的是
`textarea.value === ''`（`tests/e2e_m19.mjs:1174`）——文本根本没进输入框，自然也不会发送。
这解释了为什么旧套件一直是绿的，却漏掉了用户在手机上的真实路径。

M41 改用真实粘贴：

1. `navigator.clipboard.writeText(text)`（context 已授予 clipboard-read/write）；
2. 聚焦 composer（手机 pass 用 `tap()`，桌面用 `click()`）；
3. CDP `Input.dispatchKeyEvent { type:'keyDown', key:'v', modifiers:2, commands:['paste'] }`
   + 对应的 `keyUp`。

这样浏览器会自己发 `paste`（`clipboardData.types === ['text/plain']`）、
`beforeinput{inputType:'insertFromPaste', data:<全文>}`、`input`，并执行默认插入。
`msg` 帧的判据是 **mock agent 实际收到的 `msg`**（`state.received`），不是 UI 推断。

### 1.2 粘贴矩阵（桌面 + 手机，修复前后结果相同）

| 视口 / 指针 | 内容 | `msg` 帧 | composer 值 | 可继续编辑 | 判定 |
|---|---|---|---|---|---|
| desktop 1280×900 | 单行 `M41 单行粘贴文本` | **0** | 逐字符一致 | `+ " +edit"`，仍 0 帧 | PASS |
| desktop | 多行 `M41 第一行\n第二行\n第三行` | **0** | 两个 `\n` 都在 | 追加后 0 帧 | PASS |
| desktop | 尾换行 `M41 末尾带换行的粘贴文本\n` | **0** | 末尾 `\n` 保留 | 追加后 0 帧 | PASS |
| mobile 390×844 coarse | 单行 | **0** | 一致 | 追加后 0 帧 | PASS |
| mobile | 多行 | **0** | 一致 | 追加后 0 帧 | PASS |
| mobile | 尾换行 | **0** | 一致 | 追加后 0 帧 | PASS |
| 两者 | 粘贴图片（`image/png` File） | **0** | 仍为 `''`（不插入） | 1 个 `已就绪` chip，可移除 | PASS |

每格还额外断言 `发送` 按钮此时是**可点**的（`sendDisabled === false`）：证明 0 帧不是因为
断线/空内容把发送挡住了，而是粘贴真的没有触发发送。

修复前的临时探针（`M41_PROBE`，已删除）在同样的 4 种输入方式上各跑了一遍，结论一致：
真实粘贴 `cdp` / `Ctrl+V`、IME 风格 `Input.insertText` 都是 `sent=0`、值完整；
脚本合成 `paste` 是 `sent=0`、值 `""`（无默认动作）。

### 1.3 按键矩阵（红 → 绿）

| 视口 | 用例 | 修复前 | 修复后 | 断言 |
|---|---|---|---|---|
| desktop | IME composition 中按 Enter | **发出 1 帧 `"nihao"`，composer 清空** | 0 帧，`"nihao"` 保留 | `M41 Enter during IME composition sends nothing` / `the composing text stays` |
| mobile | 同上 | **发出 1 帧 `"nihao"`，composer 清空** | 0 帧，`"nihao"` 保留 | 同上 |
| desktop | `key:'Enter'` + `keyCode:229`（Android WebView 形态） | **发出 1 帧 `"M41 android 229"`** | 0 帧，文本保留 | `M41 an Android keyCode-229 Enter sends nothing` |
| mobile | 同上 | **发出 1 帧** | 0 帧 | 同上 |
| desktop/mobile | 真实 Enter | 1 帧（保持不变） | **恰好 1 帧**，composer 清空 | `M41 a real Enter sends exactly one msg frame` |
| desktop/mobile | Shift+Enter | 换行、0 帧（保持不变） | 换行、0 帧 | `M41 Shift+Enter inserts a newline and sends nothing` |

红测复现命令（本报告实测过）：把 `spa/src/lib/keys.ts` 的两条判定临时改回
`isImeKey → false`、`shouldSendOnEnter → key === 'Enter' && !shiftKey`，然后
`M41_ONLY=1 node e2e_m19.mjs` → `checks: 55, failed: 6`；恢复后 `failed: 0`。

### 1.4 事件轨迹（裸 textarea，Chromium，非 SPA）

用 CDP 在只有 textarea 的页面上抓的真实序列，用来分清「粘贴」和「按键」：

| 场景 | 页面看到的事件 |
|---|---|
| composition + 粘贴 | `compositionstart → compositionupdate → beforeinput(insertCompositionText) → input → keydown v (isComposing:true) → paste → beforeinput(insertFromPaste, isComposing:false) → input → keyup v` —— **没有 Enter** |
| composition + Enter（输入法确认键） | `keydown Enter (isComposing:true, keyCode:13)` → 旧代码在这里 `send()` |
| 粘贴 → 再按 Enter | `paste → beforeinput(insertFromPaste) → input`，之后才是独立的 `keydown Enter (isComposing:false)` |
| `keyCode 229` + `text:'\r'` | `keydown Unidentified (keyCode:229)` → `beforeinput(insertLineBreak)`；旧代码靠 `key === 'Enter'` 恰好没发，但 WebView/Safari 会把 `key` 报成 `Enter` 而 `keyCode` 仍是 229 |

结论：**粘贴事件序列里根本没有 Enter**；能「粘贴后自己发出去」的，只可能是输入法在粘贴
上下文里补出的那个 Enter（确认/提交），也就是 composition 那条路径。

---

## 2. 真凶

**`spa/src/App.tsx:5372-5375`（HEAD）：**

```ts
if (e.key === 'Enter' && !e.shiftKey) {
  e.preventDefault();
  send();
}
```

没有 `isComposing`，也没有 `keyCode === 229`。手机上的粘贴由输入法执行，输入法的确认/提交
键就是一个 `keydown Enter`（Chromium 实测 `isComposing:true`、`keyCode:13`）；旧代码把它
当成用户显式发送，于是「刚粘进来、还没编辑」的内容被整段发出。红测把这条路径完整复现：
发送的正是 composer 里正在组合的文本，且发送后 composer 被清空——与用户描述一致。

修复位置：

- `spa/src/App.tsx:5343` —— `if (isImeKey(e.nativeEvent)) return;`，放在 `onKeyDown` 的
  **最前面**（早于命令面板分支），所以输入法 Enter 既不会发送，也不会误选 `/`、`@` 面板行。
- `spa/src/App.tsx:5379` —— `if (shouldSendOnEnter(e.nativeEvent)) { preventDefault(); send(); }`。
- `spa/src/lib/keys.ts` —— 纯逻辑，两个平台信号：`KeyboardEvent.isComposing`（Chrome/Firefox/
  Safari 15+）与 `keyCode === 229`（Android WebView / 旧 Safari，此时 `key` 可能已是 `Enter`）。

---

## 3. 逐项排查（四个候选）

| 候选 | 结论 | 证据 |
|---|---|---|
| **M22 paste-to-attach 处理器**（`onPaste`，HEAD `App.tsx:5455`） | **排除** | 只处理 `item.kind === 'file'`：`preventDefault()` 后交给 `addFiles` 生成 chip；纯文本分支直接 `return`，让浏览器默认插入。处理器和 `addFiles` 都不可达 `send()`。修复前后 6 格粘贴矩阵全是 0 帧、文本完整；图片粘贴是 1 个 chip、0 帧（`M41 pasted image becomes one ready chip and sends nothing`）。 |
| **Enter 发送键 / `beforeinput` 里的 `\n`** | **真凶（IME Enter）**；`beforeinput` 无关 | 全仓库没有 `beforeinput` 监听；`insertFromPaste` 只经 React `onChange → setComposer`，不发送。多行/尾换行文本的 `beforeinput.data` 含 `\n`，实测 0 帧。真正的发送只来自 `keydown Enter`，且缺 composition 守卫（§2）。 |
| **表单 submit / 发送按钮 click 合成** | **排除（已加固）** | composer 的 textarea `closest('form') === null`（e2e 断言 `M41 composer is not inside a form`），Enter 不可能 submit；`send()` 在空内容时提前返回（`App.tsx:5126`：`if (!rawInput && pending.length === 0) return;`），所以即便粘到空 composer 时误触 发送，也不会发出任何帧。`发送`/`停止` 原本是默认 `type="submit"` 的 `<button>`，现已显式 `type="button"`（`App.tsx:6647`），关掉「将来被 form 包住就变提交键」这一整类隐患。移动端粘贴菜单由浏览器/系统绘制，页面收不到它的点击；布局上 发送 在 textarea 下方的工具行（390 px 截图与 44 px 审计均如此），不覆盖输入区。 |
| **输入法 composition** | **真凶** | 见 §2。`isComposing` 全仓库此前没有任何引用（`grep -rn "isComposing\|composition" spa/src/` 为空），即从未防过。修复后 composition Enter 0 帧、文本保留；composition 结束后真实 Enter 仍恰好发送 1 帧。 |

补充：Android 的 `keyCode 229` 分支在同一处修复中覆盖（旧代码在 `key === 'Enter'` 时仍会
发送；在 `key === 'Unidentified'` 时靠运气没发）。这不是另一个 bug，而是同一个「IME 按键被
当成用户按键」的第二个平台信号。

---

## 4. 修复点

| 文件 | 改动 |
|---|---|
| `spa/src/lib/keys.ts`（新增） | `IME_PROCESS_KEY_CODE = 229`；`isImeKey(e)` = `isComposing \|\| keyCode === 229`；`shouldSendOnEnter(e)` = `key === 'Enter' && !shiftKey && !isImeKey(e)`。无 DOM，可单测。 |
| `spa/src/App.tsx:5343` | `onKeyDown` 首行 IME 早退（同时保护命令面板的 Enter）。 |
| `spa/src/App.tsx:5379` | 发送判定改用 `shouldSendOnEnter(e.nativeEvent)`。 |
| `spa/src/App.tsx:5469` | `onPaste` 上方写清不变式：粘贴永不发送，文本走默认插入、文件走 chip。行为未改（本来就是对的）。 |
| `spa/src/App.tsx:6647` | `发送` / `停止` 显式 `type="button"`。 |
| `spa/tests/keys.test.ts`（新增） | 7 条：普通 Enter、Shift+Enter、`isComposing`、`keyCode 229`、229 不误伤普通键、非 Enter 键、缺省字段。 |
| `tests/e2e_m19.mjs` | 新增 `runM41Checks`（每 pass 26 条）+ 主流程调用 + `M41_ONLY=1` 快速入口。真实粘贴辅助函数用 CDP `paste` 命令。 |

没有时序 hack：不含 `setTimeout`/「粘贴后 N 毫秒内禁用发送」；守卫只看事件自身的语义字段，
与粘贴发生在何时无关。

显式发送的定义保持原样：**发送按钮点击**、**真实 Enter（非 Shift、非 IME）**。

---

## 5. 测试

### 5.1 新增 Playwright 用例（`tests/e2e_m19.mjs::runM41Checks`）

每个 pass（desktop / mobile）各 26 条：

1. composer 不在 form 内；`发送` 是 `type="button"`；
2. 单行 / 多行 / 尾换行 × {0 帧、文本逐字符一致、无 chip、发送可用但未发、仍可编辑}（5×3）；
3. 粘贴图片：`preventDefault`、1 个 `已就绪` chip、0 帧、无文本插入；chip 可移除且 0 帧；
4. Shift+Enter 换行且 0 帧；
5. IME composition + Enter：0 帧、composing 文本仍在；
6. Android `keyCode 229` + `key:'Enter'`：0 帧、文本仍在；
7. 真实 Enter：恰好 1 帧、内容正确、composer 清空。

### 5.2 vitest

`spa/tests/keys.test.ts` 7 条，覆盖 `isImeKey` / `shouldSendOnEnter` 的每个分支（含
`isComposing:false` + `keyCode:229` 的 WebView 组合、`Process`/`Unidentified` 不误判）。

### 5.3 全套件计数（本报告实测）

| 套件 | 命令 | 结果 |
|---|---|---|
| 插件（21 套） | `for f in plugin/tests/test_*.py; do ~/workspace/qwenpaw-local/venv/bin/python $f; done` | 21/21 `ALL PASS` |
| vitest | `cd spa && npm test` | 312/312（20 files，+7） |
| e2e_m19 | `cd tests && node e2e_m19.mjs` | 589/589（含 build；M41 +52） |
| e2e_m29 | `cd tests && node e2e_m29.mjs` | 26/26 |

全套件跑完 `git status --porcelain` 只有本任务文件（`spa/src/App.tsx`、`spa/src/lib/keys.ts`、
`spa/tests/keys.test.ts`、`tests/e2e_m19.mjs`、`docs/m41-report.md` 与既有未跟踪的
`tasks/m4*.md`），没有测试制品回写。

---

## 6. 说明与遗留

- **未 commit、未部署。** 生产 bundle、relay、插件均未触碰。
- `e2e_m19` 全量跑会把 `spa/dist` 重建为本地演示构建（`ws://127.0.0.1:8787`）。按 M40 的
  约定，在跑 `tools/verify_release.py` 之前需要用 `VITE_RELAY_WS` / `VITE_RELAY_HTTP` 重建，
  否则字节比对会失败；`dist/` 本身是 gitignored。
- 残留边界（明确说明，非遗漏）：若某个平台把粘贴**同时**派发成一个 `isComposing:false`、
  `keyCode:13` 的「真实 Enter」，SPA 无法把它与用户按 Enter 区分开——那正是被允许的显式
  发送手势。任务书禁止时序型启发式，所以这里只按事件语义判定，不猜时间窗口。
- 本任务顺带确认：`onPaste` 对「文件 + 文本」混合剪贴板仍是文件优先（文本被丢弃），与 M22
  原语义一致，未改。
