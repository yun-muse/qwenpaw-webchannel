# M35 报告 — 历史缩略图实装修复 + 一条消息多附件

状态：**已完成**。插件、SPA、e2e 全绿；未提交；未触碰 `.github/workflows/ci.yml`。

## 0. 结论

1. 托管环境「上传的 PNG 在历史里只显示文件 chip」**不是 hist 投影字段错了**。真实投影与
   旧 mock 的字段语义一致；失败点在 `att_get` 的**媒体根包含校验**：插件只猜了一个
   `media_dir`，与 QwenPaw 实际落盘目录不一致，取字节返回 `E_ATT`，SPA 按设计降级成
   chip。修复为多根校验（上传目录 → 配置报告目录 → 旧猜测），包含规则不弱化。
2. 一条消息多附件：插件的内容组装、hist 投影、导出、归档在 M31 时已按数组实现；缺口
   全在 SPA（单附件状态）与两端上限（原先没有）。M35 补上多选、追加、逐个删除、提示，
   以及 10 个/条、10MB/条（总量）两个上限。
3. 本轮修掉 3 个 M35 e2e 检查的 6 次失败（桌面+手机各 3）：2 个是 harness 陈旧断言，
   1 个是产品真实 UX 缺口（上限提示被成功路径立即清掉）。

## 1. 托管 chip-vs-thumbnail：根因

### 1.1 两条数据路径

**真实路径**（`tests/fixtures/real_history_m35.json`）：QwenPaw v2.2.2.post1
`GET /api/chats/{id}` 的 body（`ConsoleChannel.stream_one` + Agent 入库 +
`SafeJSONSession` + `chats.api.get_chat`），再经 `plugin/util.py::history_messages`
投影。图片在持久化内容里是 **两个 part**：`file`（`filename` + `file_url`）在前，
`image`（`image_url`，同一个 URL）在后；投影按 URL 去重成一条，保留 FileContent 的
原始文件名。

**旧 mock 路径**（M31 的 `tests/e2e_m19.mjs`，见 `git show HEAD:tests/e2e_m19.mjs`）：
mock agent 在收到发送帧时**只取 `frame.files[0]`**，按发送方给的 MIME 造一条：

```js
{ name, mime, size: bytes.length, kind: mime.startsWith('image/') ? 'image' : 'file', ref }
```

### 1.2 字段级对比

| 字段 | 旧 mock | 真实投影 | 结论 |
|---|---|---|---|
| `name` | 发送帧的文件名 | `_attachment_name`：优先显式 `filename`/`name`，双 part 合并时优先显式名 | 同值 |
| `kind` | 发送 MIME 前缀 | `part.type == image` 或 MIME `image/*` 或存在 `image_url` | 本例同值（`image`）；真实规则更宽 |
| `mime` | 上传时 MIME | part MIME → data-URL MIME → `mimetypes.guess_type(name)` | 本例同值（`image/png`） |
| `size` | 发送字节 `Buffer.length` | `os.stat(file_url)` 的 `st_size`（179） | 同值，但真实值是**落盘文件大小** |
| `ref` | 固定 `mock-att-N`，`state.media` 里预置字节，**永远可取** | `AttachmentRefs` 仅在 URL 是本地绝对路径时签发；`att_get` 还要重新校验 | **语义不同：mock 没有“取不到”这一态** |
| 可选性 | 五个字段恒在 | `mime`/`size` 未知时省略（不补 0） | mock 从未覆盖省略态 |
| 多重性 | 只镜像 `files[0]` | 遍历全部 part，按 URL 去重后全量投影 | mock 不可能测出多附件 |
| 键序 | `name, mime, size, kind, ref` | `name, kind, mime, size, ref` | SPA 按名取值，无功能影响；但说明旧 mock 是手搓的 |

**因此：** 托管历史的 `files` 条目本身是对的（`kind:"image"`、`mime:"image/png"`、
`size:179`、`ref` 存在）。字段级对比排除了投影；问题在 `ref` → 字节这一段，而旧 mock
用“永远可取”的 ref 把这段完全短路了。

### 1.3 SPA 分支

`AttachmentList` 只按 `file.kind === 'image'` 选 `AttachmentThumb`；`AttachmentThumb`
在 **没有 `ref` 或取字节失败** 时 `return <AttachmentChip …>`（`spa/src/App.tsx:1228`）。
chip 上的文件名与大小来自 `hist` 元数据，所以“chip 上 179 B 完全正确”与“字节取不到”
可以同时成立。

### 1.4 失败链

1. `hist`：`util.py:401 _history_files` 合并双 part → `util.py:510
   _project_history_files` 为本地绝对路径签发 ref（10 分钟，绑定 chat + `original_id` +
   part index）。每次 `hist` 都重新签发，与“是否刚上传”无关（`test_m35.py::
   test_hist_always_reissues_a_ref_for_a_stored_attachment`）。
2. SPA：`kind=image` + `ref` → `AttachmentThumb`，先发 `att_get`。
3. 插件：`_handle_att_get` 重新校验 ref/归属/消息仍在，然后做包含校验。
   **M31 只认 `_media_dir()` 一个根**：`CONSOLE_MEDIA_DIR`，否则
   `<workspace_dir>/media`（`plugin/channel.py:2060`）。
4. QwenPaw 的 app 路径用 `ConsoleChannel.from_config`：`media_dir=config.media_dir or ""`
   优先，否则 `workspace_dir/media`；它**不读 `CONSOLE_MEDIA_DIR`**（只有 `from_env`
   读）。所以部署一旦设置 `channels.console.media_dir`（或环境变量与配置路径分叉），
   插件的单一猜测就与真实落盘目录不一致。这正是 M31 报告 §5（已知边界）已列出的边界。
5. 包含校验失败 → `E_ATT` → `AttachmentThumb` 置 `failed` → chip。刷新后现象保持，
   因为每次 hist 都签发新 ref，不是 ref 过期。

### 1.5 修复设计：多媒体根

新增 `_media_roots()`（`plugin/channel.py:2079`），按权威性排序：

1. **上传目录**：`_store_file` 从 `POST /api/console/upload` 返回的 URL 取父目录
   （`util.attachment_media_dir`，`channel.py:877`）。这是 QwenPaw 自己刚写文件的地方，
   任何部署配置都无法让它猜错。
2. **配置报告目录**：首次需要时 `GET /api/config/channels` 读 `console.media_dir`
   （`_ensure_console_media_dir`，`channel.py:2111`），成功/失败都只查一次；只在便宜的
   根都失败后才查，正常取字节不付这次调用。
3. **旧猜测**：`CONSOLE_MEDIA_DIR` 或 `<workspace>/media`。

字节解析改为 `media_file_path_in(path, roots)`（`util.py:1066`）：对每个根调用原有的
`media_file_path`，因此 `Path.resolve()` 后的 `is_relative_to`、普通文件、符号链接逃逸、
10MB 上限 **逐根完全相同**。根全部来自 QwenPaw 自身（上传返回值、配置接口、环境/工作区），
没有任何客户端可控值进入路径。

`att_get` 的校验顺序变为：先查已知根；全失败再懒加载配置根后重试一次；仍失败才
`E_ATT`，并记录“已知根数量”的警告（`channel.py:1933`）。

插件测试（`plugin/tests/test_m35.py`）固定了这条链：

- 真实 body → 真实 hist 投影逐字段/逐键序相等，且线上不出现路径/`file_url`/`image_url`；
- 多附件真实 body → 三份文件顺序与 kind 完整；
- 每次 hist 重新签发 ref；
- 只在“上传目录”可解析时 `att_get` 成功；
- 只在“配置 media_dir”可解析时成功，且配置接口只调一次；
- 所有根之外的文件仍被拒绝（伪造 ref → `E_ATT`）；
- `..`、符号链接、空根、远程/data URL 的边界保持不变。

## 2. 一条消息多附件

### 2.1 探查结论

| 层 | M35 前 | 结论 |
|---|---|---|
| SPA composer | `const [attachment, setAttachment] = useState<Attachment \| null>`（HEAD `App.tsx:1962`）；每次选择/粘贴先 `cancelUpload()` 再覆盖 | **单附件，真实缺口** |
| 插件内容组装 | `_handle_msg` 已对 `files[]` 全量循环，`_store_file` 返回 FileContent+ImageContent 两个 part，`_resolve_file_entry` 逐个 `extend` | 已支持 N，**无上限** |
| hist 投影 | `_history_files` 遍历全部 part，按 URL 去重；`_project_history_files` 全量输出 | 已支持 N |
| 导出 | `build_export_markdown` 每个文件一行 `[附件: …]`（按 URL 去重） | 已支持 N |
| 归档 | `archive_user(..., files_meta)` 接收元数据列表 | 已支持 N |
| e2e | mock 只镜像 `files[0]` | 覆盖缺口 |

所以 M35 的主体工作在 SPA 与上限；插件只补“防御性上限”和预算计量，不重写已能工作的
组装路径。

### 2.2 实现范围

- `spa/src/lib/attachments.ts`
  - `MAX_MESSAGE_ATTACHMENTS = 10`、`MAX_MESSAGE_ATTACHMENT_BYTES = 10MB`（单文件
    `MAX_ATTACHMENT_BYTES` 仍是 10MB）；
  - `planAttachments(pending, incoming)`：按顺序收，超出数量或总量即拒绝其余；单文件
    超限单独拒绝；未知大小按 0 计，服务端仍会兜底；
  - `describeRejections()`：数量/单文件/总量各一句中文。数量文案为
    `一条消息最多 10 个附件，其余已忽略`。
- `spa/src/App.tsx`
  - 待发列表由单个 `attachment` 改为 `attachments[]`；再次选择/粘贴/拖放**追加**而不是
    覆盖；每个 chip 的 × 只移除自己（同时取消对应分片上传）；
  - 发送时按列表顺序映射为 `files[]`，一个用户轮次、一个气泡；
  - 上限提示放在独立的 `attachNotice`（`App.tsx:2003`），与瞬时 `composerError` 分开：
    上传开始/成功会清 `composerError`，但不会清掉本批次的上限说明；下一次“干净”选择、
    删除任一 chip、发送或切换会话才清。渲染仍在 `.composer-error`（`App.tsx:5856`）。
- `plugin/util.py` / `plugin/channel.py`
  - `MAX_MESSAGE_ATTACHMENTS = 10`、`MAX_MESSAGE_ATTACHMENT_BYTES = 10MB`；
  - `_handle_msg`：超过 10 个截断并 warning；按 `_entry_size`（inline base64 → 声明
    `size` → staged 记录 → 未知 None）累计，超过 10MB 停止处理其余文件并 warning；
  - 顺序不变：先到先得，`files_meta` 与 `content_parts` 同一顺序。

### 2.3 上限与理由

- **10 个/条**：一次手机截图批次、一组日志或几份文档足够；把单轮的读取、上传、
  乐观气泡都限制在可控范围。需要更多时拆成两条消息。
- **10MB/条（总量）**：沿用 M31 的单文件 10MB 规则并扩展到整条消息，避免十个 9MB
  文件变成 90MB 的一轮。单文件上限仍独立生效。

两端常量互相镜像（`test_m35.py::test_message_budget_constants_match_the_product_rule`
与 `attachments.test.ts`），数量文案直接由 SPA 常量生成。

## 3. 本轮 6 个 e2e 失败与处置

6 次失败 = 3 个检查 × 桌面/手机两遍，全部在 M35 新增块。

| 检查 | 实际断言 | 根因 | 归属 | 处置 |
|---|---|---|---|---|
| `the image is visible after a history refresh` | `naturalWidth === 1`（M31 的 1×1 PNG 遗留） | M35 把样张换成了托管的 179 B、**64×64** PNG（`tests/fixtures/m31-acceptance.png`），断言没跟着换；日志里 `width:64`、blob URL、alt 都对 | harness | 从 fixture 的 IHDR 读 `ATT_PNG_WIDTH/HEIGHT`，断言 `naturalWidth/naturalHeight` 都等于 64。比原来的“只看 1”更精确，未放宽 |
| `one message carries three attachments in order` | 期望 `[图一, 图二, 笔记二]` / `[image, image, file]` | 检查前一步主动删除图二再重新选择；产品是**追加**语义（同文件已有“later pick appends”检查），所以发送顺序应为 `[图一, 笔记二, 图二]`；日志里的 files 正是这个顺序 | harness | 发送前抓取 composer chip 顺序，断言 wire 顺序 === chip 顺序，并显式断言 `[图一, 笔记二, 图二]` / `[image, file, image]`。仍逐项校验顺序与 kind |
| `an 11th attachment is refused with the cap stated` | `.composer-error` 文本含 `10` | 产品先 `setComposerError(describeRejections(...))`，随后第一个 inline 文件成功时执行 `setComposerError(null)`，把刚出现的上限提示清掉；chip 正常（10 个），提示为 `""` | **产品**（真实 UX 缺口） | 新增独立 `attachNotice`，成功路径不再能清它；e2e 断言原样保留。现在读到 `一条消息最多 10 个附件，其余已忽略` |

没有删除检查、没有把断言改成恒真；两处 harness 修复都保留了原意图（解码后的真实尺寸 /
附件顺序与 kind），第三处让产品满足原断言。

## 4. 测试结果（本轮复跑）

| 套件 | 结果 |
|---|---|
| 插件（`~/workspace/qwenpaw-local/venv/bin/python plugin/tests/test_*.py`） | **21/21 套件 ALL PASS**，共 394 个测试函数 |
| SPA vitest（`spa && npm test`） | **17 个文件 / 250 项全绿** |
| SPA 构建 | e2e 内含 `npm run build`（`tsc --noEmit` + `vite build`）通过 |
| Playwright（`node tests/e2e_m19.mjs`） | **418 项，0 失败**（桌面 + 手机），187.7 s |

M35 新增的 e2e 覆盖：真实 hist 键序、opaque ref 取图、三附件同消息（顺序/两缩略图一
chip/非图片下载）、10 个上限与提示、逐 chip 删除。剩余 0 失败。

## 5. 产物

插件 ZIP 在本轮重新构建（插件代码含主会话的 M35 改动）：

- `dist/webchannel.zip`，**86,122 bytes**，MD5 **`e11d72ec641d8d392f8c30cb06934dae`**
  （`bash tools/package_plugin.sh`，固定时间戳、10 个运行时文件）。

未提交；`.github/workflows/ci.yml` 未触碰；未访问托管环境。

## 6. 已知边界

- 配置接口 `GET /api/config/channels` 只查一次；若部署在运行中改 `console.media_dir`，
  需重启插件进程或重新上传一次文件来刷新“上传目录”根。
- 多根校验仍是“QwenPaw 拥有的目录”集合；没有引入客户端路径，也没有放宽 `..`/符号
  链接规则。
- `E_ATT` 依旧不区分“越界/过期/已删除”，避免把容器目录结构暴露成探测面。
- 数量上限是产品规则，不是协议硬限制：插件截断是防御性的，正常客户端在 SPA 就被拦下
  并看到文案。
