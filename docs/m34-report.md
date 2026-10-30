# M34 · 全量备份导出（SPA-only，一个 .zip 带走全部会话）

状态：**已实施，未提交**。基线 HEAD `40aa7d7`（M33）。改动只落在 SPA 与测试：
`spa/src/lib/zip.ts`、`spa/src/lib/backup.ts`（新增），`spa/src/App.tsx`、
`spa/src/App.css`、`spa/tests/zip.test.ts`、`spa/tests/backup.test.ts`（新增）、
`tests/e2e_m19.mjs`、本报告与 `AGENTS.md` 一条约定。
`plugin/`、`protocol/`、`relay-node/`、`relay-cf/` 零改动（`git status` 可验）。

---

## 0. 结论

**手写 store-only ZIP 完全可行，没有引入任何依赖**（任务书允许的「微型库」分支未触发）。

- 浏览器端增量写出 ZIP32：每个会话的 `.md` 一经校验就写成「本地文件头 + Blob」，
  内存里只保留中央目录（每条约 46 + 文件名长度字节）；`finish()` 返回一个复合 Blob，
  由浏览器负责落盘，**从不把全部 Markdown 拼成一个巨型字符串**。
- 产物：`webchannel-backup-YYYYMMDD-HHmm.zip`（本地时间），内含
  **每会话一个 `.md`（与单会话导出逐字节相同）+ `index.md` + `backup.json`**。
- 进度/取消/失败核算/100 上限完全复用 M25 的 `planBulk` / `runBulkExport`；
  失败会话同时出现在 `index.md`、`backup.json`、`console.warn` 与 toast 里，不会静默丢弃。
- 取消：不产出任何文件（半份备份比没有备份更危险），toast 如实报「已完成 N 个 · 剩余 M 个未备份」。
- 总大小 > 200 MB 时弹出确认框（继续 / 停止并取消），不会被无声截断。
- 既有套件全绿：vitest 244（新增 38）、`tests/e2e_m19.mjs` 396 项 0 失败、
  `tests/e2e_m29.mjs` 26 项 0 失败。

---

## 1. 交互形态

```
[⤓ 导出全部（2）] [🗄 备份全部 .zip]      ← 同一行，两个动作并排
仅服务器列表 · 最多 100 个 · 归档会话不计入
```

- **并排而不是上下两行**是硬约束：M26 的密度用例要求 390×844 的手机抽屉里
  至少完整显示 8 行会话（行高 46 px）。实测列表可用高度 432 px 时正好 8 行；
  任何额外的一行按钮（44 px）或说明行（17 px）都会掉到 7 行。因此两个动作
  共用原来的那一行，**说明文字、行高、列表高度与 M25 完全一致**
  （`listHeight` 432 px，8 行，e2e 可复验）。
- 文案区分：左侧仍是 M25 的「导出全部（N）」（散下多个 .md），右侧
  「备份全部」+ `.zip` 徽标（单个打包文件）；完整名称「备份全部会话（单个 .zip）」
  放在 `aria-label` 与 `title`（侧栏变窄、会话数到三位时按钮文字会先用省略号，
  可读名不受影响）。
- 备份期间复用 M25 面板的样式（`.bulk-panel` + `.backup-panel`），标题是
  「备份中 n/N」，取消按钮是 `.backup-cancel`；两个批次互斥（任一运行中，另一动作、
  顶部「导出」、菜单里的「导出 Markdown」全部禁用）。
- 完成后 toast：`备份完成：成功 2 · 失败 0 · 1.2 MB`（有失败时 tone 为 danger，
  并点名前三个失败标题）；取消：`备份已取消：已完成 3 个（成功 2 · 失败 1）· 剩余 7 个未备份`。

### 1.1 >200 MB 护栏

`BackupSizeGuard` 在累计字节首次超过 `200 × 1024 × 1024` 时返回一次 `true`，
`runBackup` 随即 `await` 一个确认 Promise（`.backup-confirm-mask` 模态框）：
「继续备份」放行，「停止并取消」等价于取消（丢弃压缩包，计数如实）。
弹框打开时点击面板取消或组件卸载都会把该 Promise 解析为 false，不会悬挂。

这条分支只有单元测试覆盖，不放进 Playwright：mock agent 的每个 `export_chunk`
都受 relay 256 KB 帧上限约束，要凑出 200 MB 需要 ~800 个 256 KB 帧的真实传输，
不值得（报告 §8 记为已知边界）。

---

## 2. ZIP 选型

### 2.1 为什么能手写

备份里的内容是 Markdown / JSON 文本，压缩收益有限；浏览器又**没有同步 deflate**
（`CompressionStream` 是异步流，会打乱「一个会话写完就释放」的增量节奏）。因此
store-only（method 0）既是最简单的，也是最快的路径。一个 store-only ZIP 只需要：

| 结构 | 字节数 | 关键字段 |
|---|---|---|
| 本地文件头 | 30 + 文件名 | 签名 `0x04034b50`、版本 20、通用标志 `0x0800`（UTF-8）、方法 0、DOS 时间/日期、CRC-32、压缩/原始大小、文件名 |
| 数据 | 原样 | 不压缩 |
| 中央目录项 | 46 + 文件名 | 签名 `0x02014b50`、同样的 CRC/大小、本地头偏移 |
| 中央目录结束 | 22 | 签名 `0x06054b50`、条目数、目录大小/偏移 |

CRC-32 用标准的反射多项式 `0xEDB88320` 建 256 项表，一次遍历算完
（`crc32("123456789") === 0xCBF43926`，vitest 有断言）；时间戳是本地墙钟的
MS-DOS 时间/日期（与备份文件名同一时区口径，ZIP 本身没有时区字段）。

实现规模 `spa/src/lib/zip.ts` ≈ 230 行（含注释），无 import、无 polyfill。

### 2.2 兼容性验证（三层独立校验）

1. **vitest 自带独立读取器**（`spa/tests/zip.test.ts`）：位运算逐位 CRC（不是查表），
   从 EOCD 走到中央目录再走到本地头，检查名字、方法、CRC、大小、偏移与内容；
   覆盖中文名、空文件、100 条 + 1 MB 负载、重复名/空名/二次 `finish()` 的报错。
2. **e2e 的 Node 读取器**（`tests/e2e_m19.mjs::unzipStore`）：另一份独立实现，
   同样校验 CRC 后返回 `Map<name, Buffer>`。
3. **现成解析器**：e2e 用 `python3 -c "zipfile.ZipFile(...).testzip()"` 做 CRC 校验，
   再把 `namelist()` 与上面两层的条目名逐一对齐。三方一致。

### 2.3 为什么不用库

`fflate` / `jszip` 体积 8–30 KB（gzip 后 3–10 KB）且都带压缩器；本任务只需要
store-only，手写 230 行已经覆盖全部需求，还省掉一次依赖与供应链审查。任务书
「若手写不可行才许引微型库」的分支因此没有触发。

### 2.4 ZIP32 上限

单归档 ≤ 4294967295 字节、≤ 65535 个条目（写入器显式抛错，不静默截断）。
实际边界由 export 协议决定：单会话 ≤ 10 MB（`MAX_EXPORT_BYTES`）× 100 会话
= 1 GB，远在 4 GB 之下；条目最多 102 个。所以不需要 ZIP64，也就没有它的额外复杂度。

---

## 3. 内存与体积口径

**写入是增量的，按会话推进：**

```
for 每个会话（M25 的 runBulkExport 顺序执行）
    export 分块 → verifyExport（长度 + SHA-256）→ 10 MB 以内的 ArrayBuffer
    zip.add(name, bytes)         // 本地头（几十字节）+ new Blob([bytes])
    bytes 立即成为垃圾；只有中央目录记录（46 + 名字）留在 JS 里
finish()
    push 中央目录 + EOCD → new Blob(parts)   // 复合 Blob，不复制数据
```

- **峰值 JS 常驻**：一次只有**一个**会话的导出载荷（≤ 10 MB）加上验证时的
  base64 分块（约 1.33×，与 M25 单会话导出完全相同），外加固定的两三百字节
  元数据。会话结束即释放。
- **归档本体**：交给 Blob 存储（Chrome/Firefox 会把大 Blob 落到磁盘），
  不占 JS 堆；`finish()` 的复合 Blob 是引用拼接，不会再复制一遍 100 MB 级数据。
- **刻意不做的事**：不把 100 个 `.md` 拼成一个字符串、不用 `TextEncoder` 二次编码
  （导出字节本来就是 UTF-8，直接原样入包）、不 base64 回环。
- **体积**：store-only，包大小 = Σ文件大小 + Σ(30+名字) + Σ(46+名字) + 22。
  两个会话的 e2e 样本 182 + 181 字节正文，包本身仍是几百字节级；100 MB 级备份
  的开销只有 ~7 KB 中央目录。
- **文件名与时间**：DOS 时间用本地时间；`generated_at` 在 `backup.json` 里是
  ISO-8601 UTC，`index.md` 里是可读的本地时间。

---

## 4. 与 M25 的关系

| 维度 | M25 导出全部 | M34 备份全部 |
|---|---|---|
| 目标列表 | 最后一个非空 `chats` 帧，服务器顺序 | **同一个**（共享 `serverChatsRef` 与等待器） |
| 上限 | 100 | **同一个** `planBulk` |
| 循环/进度/失败/取消 | `runBulkExport` | **同一个函数**，`shouldCancel`/`onProgress` 语义不变 |
| 单会话取数 | `requestExport(chat,title)` → `saveBlob` | `requestExport(chat,title,deliver)` → 拿到同一份已校验字节 |
| 产物 | 每会话一个 `.md` 下载 | 一个 `.zip`（每会话一个 `.md` + `index.md` + `backup.json`） |
| 取消 | 丢弃在途文件，不再开始下一个 | 丢弃在途文件与整个压缩包，toast 报已完成/剩余 |
| 失败 | 计数 + 控制台 + toast 点名 | 同上，**并且**写进 `index.md` 的「失败」段与 `backup.json.failures` |

实现上只给 `requestExport` 增加了一个可选 `deliver` 回调：`finishExport` 校验通过后，
有 `deliver` 就交出 `Uint8Array`，否则照旧 `saveBlob`。M25 的调用点与行为不变
（`ExportOutcome` 仍是 `{ok:true,filename}`）。

`startBulkExport` 里原来内联的「没有服务器列表就先要一次」被抽成
`requestServerChats()`，两个动作共用同一个 waiter + 6 s 超时；toast 文案与顺序保持原样。

---

## 5. 归档内容

### 5.1 文件命名

- 包名：`webchannel-backup-YYYYMMDD-HHmm.zip`（本地时间，精确到分钟）。
- 会话文件名：与单会话导出**同一条清洗规则**（`exportFileName`：控制字符与
  `<>:"/\|?*` 换成 `_`，按码点截断 50，去掉结尾的 `.`/空格，补 `-YYYY-MM-DD.md`）。
- 重名去重：同名标题依次得到 `标题-2026-10-30.md`、`标题-2026-10-30 (2).md`、
  `(3)`…；比较**大小写不敏感**（Windows / macOS 的解压目标不允许 `Alpha.md`
  与 `alpha.md` 共存），并且 `index.md` / `backup.json` 两个名字被预留。

### 5.2 `index.md`

```markdown
# WebChannel 会话备份

- 备份时间：2026-10-30 16:01:18
- 生成工具：QwenPaw WebChannel（构建 40aa7d7-1793375902385）
- 会话：成功 2 · 失败 0
- 导出口径：每个 .md 与「导出当前会话」的内容完全一致（插件导出，未做改写）

## 会话

| # | 标题 | 消息数 | 状态 | 文件 |
| --- | --- | --- | --- | --- |
| 1 | Alpha 会话 | 2 | 成功 | [Alpha 会话-2026-10-30.md](<Alpha 会话-2026-10-30.md>) |
| 2 | Beta 会话 | 24 | 成功 | [Beta 会话-2026-10-30.md](<Beta 会话-2026-10-30.md>) |
```

- 链接用 CommonMark 的 `<...>` 目标写法，`(2)` 后缀和空格都能正确打开。
- 失败段固定出现在表格之后，一行一个失败：
  **Beta 会话**（`chat-beta`）：导出失败：E_EXPORT — mock export refused。
- 超过 100 个会话时多一行「仅备份前 100 个（共 N 个）」。
- 标题里的 `|` 会转义，换行压成空格，表格不会被标题破坏。

**消息数来源**：不额外请求 `hist`（那会让每个会话多一次可能很大的往返），而是
读导出文档自己的 M20 头 `- 消息条数：N`（只解码前 8 KB）。读不到就是 `null`，
`index.md` 显示 `—`、`backup.json` 是 `null`，**绝不写 0**。

### 5.3 `backup.json`

```json
{
  "generator": "qwenpaw-webchannel",
  "format": 1,
  "generated_at": "2026-10-30T16:01:18.289Z",
  "build_id": "40aa7d7-1793375902385",
  "limit": 100,
  "total": 2, "planned": 2, "succeeded": 2, "failed": 0,
  "cancelled": false, "skipped": 0, "unprocessed": 0,
  "index": "index.md",
  "chats": [
    { "id": "chat-alpha", "title": "Alpha 会话", "filename": "Alpha 会话-2026-10-30.md",
      "messages": 2, "status": "ok", "bytes": 182 }
  ],
  "failures": []
}
```

失败项：`filename: null`、`status: "failed"`、`reason` 为原始失败文案（例如
`导出失败：E_EXPORT — mock export refused`、`导出失败：文档超过 10MB`），并同时在
`failures[]` 里重复一份 {id, title, reason} 便于脚本直接消费。
`unprocessed` 是被取消/未处理的数量，只在取消时非 0。

**失败不会被丢掉**：`buildBackupRecords` 以 `BulkRunResult.failed` 为准来生成失败记录
（不是靠 UI 自己记账），所以任何一个失败都必然出现在两份清单里；单元测试里专门有
「produced 里没有字节的失败」用例。

### 5.4 取消

取消时**不产出 ZIP**：半份压缩包最容易被误当成完整备份。此时
`index.md` / `backup.json` 根本不会写，toast 报「已完成 N 个（成功 A · 失败 B）· 剩余 M 个未备份」，
控制台另有一条 `[backup]` 说明。in-flight 的 `.md` 与 M25 一样被丢弃（不下载）。

---

## 6. 测试

### 6.1 vitest（`cd spa && npx vitest run`）

| 文件 | 用例 | 覆盖 |
|---|---|---|
| `tests/zip.test.ts`（新） | 12 | CRC 标准向量/空串/逐位对照、DOS 时间、独立读取器往返（中文名/空文件/1 MB/100 条）、UTF-8 标志、本地头偏移、重复名/空名/写完再加、`application/zip` |
| `tests/backup.test.ts`（新） | 26 | 包名、重名去重（含大小写、清洗后同名、保留名）、`消息条数` 解析（含只扫前 8 KB）、记录顺序与失败不丢失、取消未处理、`index.md` 全文（表格/链接/失败段/空集）、`backup.json` 字段与序列化、200 MB 护栏（阈值与只触发一次）、toast 文案（成功/失败/取消/上限/空） |
| 其余 15 个文件 | 206 | 既有套件 |

合计 **17 个文件 / 244 项全部通过**（新增 38 项）。

### 6.2 Playwright（`tests/e2e_m19.mjs`，mock agent，桌面 + iPhone 13 两遍）

新增 M34 段（每遍 20 项）：

1. 按钮与 `导出全部` 并排、文案含 `.zip`、`aria-label` 是「备份全部会话」；
2. 先用**单会话导出**各下一份 `chat-alpha` / `chat-beta` 作为基准；
3. 点「备份全部」→ 只产生 **1 个**下载，文件名匹配 `webchannel-backup-YYYYMMDD-HHmm.zip`；
4. 独立 Node 读取器解包：4 个条目（两个 `.md` + `index.md` + `backup.json`）；
5. 包内 `.md` 的文件名与单会话导出**完全一致**；
6. 包内每个 `.md` 与单会话导出**逐字节相同**（`Buffer.equals`）；
7. `index.md` 含备份时间、两个标题、消息数、成功状态与包内文件名链接；
8. `backup.json` 是可解析的机器清单（构建号、时间、上限 100、每会话 messages 为数字），
   且消息数与 mock 历史的条数一致（`chat-alpha` 2、`chat-beta` 24）；
9. **python3 现成解析器**：`testzip()` 通过、`namelist()` 与 Node 读取器一致；
10. 失败路径：`chat-beta` 返回 `E_EXPORT` → 仍下载，`index.md` 有「失败」段与原因、
    `backup.json.failures[0].id === 'chat-beta'` 且 `filename` 为 `null`、toast 为 danger；
11. 取消路径：面板显示「备份中 1/2」→ 取消 → 「已完成 0 个（成功 0 · 失败 0）· 剩余 2 个未备份」、
    **没有任何下载**、面板关闭。

整套 **396 项检查，0 失败**（`M19_SKIP_BUILD=1 node e2e_m19.mjs`，169 s）。
快速回归可用 `M34_ONLY=1 node e2e_m19.mjs`（两遍共 43 项）。

### 6.3 `tests/e2e_m29.mjs`

**26 项，0 失败**（PWA 新鲜度/自愈未被 ZIP 代码影响；sw.js 与缓存名未改动）。

### 6.4 体积增量（`npm run build`，与 HEAD `40aa7d7` 对比）

| 产物 | 改动前 | 改动后 | 差值 |
|---|---|---|---|
| `dist/assets/*.js`（磁盘字节） | 528,830 | 541,120 | **+12,290** |
| `dist/assets/*.css` | 59,021 | 60,720 | **+1,699** |
| js gzip（`gzip -9 -n`） | 171,766 | 175,773 | +4,007 |
| css gzip（`gzip -9 -n`） | 11,247 | 11,520 | +273 |

合计约 **+13.7 KB 原始、+4.2 KB gzip**，全部是本项目代码（ZIP 写入器 + 备份清单 +
面板/弹框样式），**没有新增依赖**。注意 Vite 终端里打印的 kB 是 JS 字符串长度，
与磁盘字节不同（AGENTS.md 既有条目）；gzip 用 `-9 -n` 去掉文件名/时间戳后测量，
否则同一个构建每次的数字都会不同。

---

## 7. 变更文件

```
spa/src/lib/zip.ts          新增  手写 store-only ZIP 写入器（CRC32/DOS 时间/中央目录）
spa/src/lib/backup.ts       新增  包名、去重、消息数、index.md、backup.json、200MB 护栏、toast
spa/src/App.tsx             改动  requestExport 的 deliver 回调；requestServerChats 抽取；
                                  备份批次状态/面板/确认框/按钮/清理
spa/src/App.css             改动  并排行、.backup-tag、确认框样式、移动端 44 px
spa/tests/zip.test.ts       新增  12 项（独立读取器 + CRC + 边界）
spa/tests/backup.test.ts    新增  26 项
tests/e2e_m19.mjs           改动  M34 段（每遍 20 项）+ 独立 unzipStore + M34_ONLY
AGENTS.md                   改动  一条 M34 约定
docs/m34-report.md          新增  本报告
```

---

## 8. 已知边界与未做的事

- **>200 MB 只有单元测试**：mock 无法在 256 KB 帧上限下产出 200 MB 导出，故
  e2e 不覆盖该分支；护栏逻辑（阈值、只触发一次、停止即取消）由 vitest 覆盖，
  弹框本身是纯展示层。
- **压缩**：store-only，不压缩。100 MB 文本备份的包也是 100 MB 级；这是
  「浏览器端零依赖 + 可增量」的代价，任务书接受。
- **ZIP64**：不支持，也不必要（4 GB / 65535 条目的上限远高于 100 × 10 MB）。
- **附件**：`.md` 与单会话导出一致（附件只以 `[附件: 名称 · mime · 大小]` 元数据行出现，
  二进制不进备份）——这是「一字不改复用现有导出」的直接结果。
- **取消不产出分卷**：见 §5.4。
- **会话顺序**：服务器列表顺序（与 M25 相同），不是按标题排序。
- `M34_ONLY=1` 是为了快速回归新增的测试开关（与既有 `M26_ONLY`/`M27_ONLY` 同风格）。
