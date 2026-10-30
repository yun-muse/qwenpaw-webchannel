# M31 探查报告 — 附件/图片理解现状（AUDIT ONLY）

状态：**只探查，未改任何产品代码、未提交**。基准版本：QwenPaw `2.2.2.post1`
（`~/workspace/qwenpaw-ref`，同时是本地 venv 的 editable 安装，`agentscope 2.0.10`）、
仓库 HEAD `bf60f6b`（M30）。

一句话结论：**传得上去、看不见、回不来**。附件（图片/文件）从 SPA 到 QwenPaw 的
*运输*是完整的（10 MB、分块、sha256、媒体目录落盘），但 ①插件把所有附件一律包成
`FileContent`，运行时把它变成 `media_type=application/octet-stream` 的 DataBlock，
所有 formatter 都会**静默丢弃**它，模型只拿到一行「文件已下载到 /path」的文本；
②`hist` 投影只取 text part，附件元数据全丢，纯附件轮次**整条从历史里消失**；
③归档/搜索只对 ≤180 KB 的 inline 附件有文件名痕迹；④导出只有 `[附件: name]`。

---

## 1. 发送侧现状

### 1.1 入口与类型

| 入口 | 代码 | 行为 |
|---|---|---|
| 选择文件 | `spa/src/App.tsx:5193` `input[type=file] hidden` | **没有 `accept`**，任意类型 |
| 按钮 | `App.tsx:5185-5192` `.attach`，「上传文件或直接 Ctrl+V 粘贴截图（最大 10MB）」 | 同一入口 |
| 粘贴 | `App.tsx:4330-4344` `onPaste` → `clipboardData.items` 里第一个 `kind==='file'` | 任意剪贴板文件，不限图片 |
| 拖放 | `App.tsx:4346-4363` `onDragOver/onDrop` → `dataTransfer.files[0]` | **只取第一个**文件 |

类型白名单：**不存在**。SPA（`handleFileObject`，`App.tsx:4284-4321`）、插件
（`util.decode_file_entry` `plugin/util.py:391-418`；`FileTransfers.begin`
`util.py:512-554`）都不看 MIME；QwenPaw 的 `/api/console/upload` 只对图片做
`PIL.Image.verify()`（`app/routers/console.py:640-670`），其它类型照收。

数量：**每条消息至多 1 个**——`const [attachment, setAttachment] = useState<Attachment|null>`
（`App.tsx:1662`），单值而非列表。

### 1.2 大小与编码（两段式）

```
MAX_FRAME_BYTES  = 256 * 1024   App.tsx:121
MAX_FILE_BYTES   = 10 * 1024 * 1024  App.tsx:124
CHUNK_BYTES      = 96 * 1024    App.tsx:127
CHUNK_PACE_MS    = 40           App.tsx:130
UPLOAD_TIMEOUT_MS= 60_000       App.tsx:133
INLINE_PROBE_BYTES = 180 * 1024 App.tsx:136
```

- 选文件时先算真实的 `msg` 探测帧（当前输入文本 + base64 附件），**整帧 ≤256 KB 就走
  v1 inline**，附件以 base64 内联：`frame.files = [{name, mime, data}]`
  （`App.tsx:4096-4101`，pick 时 `4295-4312`）。
- 否则 ≤10 MB 走 **v2 分块**：`file_begin{chat,id,name,mime,size,chunks,sha256}` →
  `file_chunk{chat,id,i,data}`（96 KB 原始字节/片，40 ms 间隔）→ `file_end`；
  成功后 `file_ready{id}`，消息里只带引用 `{ref: id}`（`App.tsx:2304-2366`、
  `2368-2395`、`2891-2907`、`4100`）。
- 失败：`file_error{code}`；`E_CHECKSUM` 自动整文件重试一次（`App.tsx:2909-2926`），
  第二次失败落成 chip 红色失败态；60 s 无 `file_ready` 视为「插件版本不支持」。
- 帧与规则见 `protocol/frames.md:229-302`（§8）。

### 1.3 插件收到后：不落自己的盘，转交 QwenPaw 落盘

- 分块在**内存**里按 index 组装，`end()` 校验长度 + sha256 后进入 `_staged`，
  TTL 600 s（`util.py:445-450`、`587-640`；`FileTransfers.chunk` 的累计字节上限
  10 MB，`util.py:579-581`）。**插件自己不写磁盘**。
- `msg.files[]` 解析：`{ref}` 走 `_files.take()`（一次性），inline 走
  `decode_file_entry`，两条路都汇到 `_store_file`（`channel.py:677-715`）。
- `_store_file` 用 `httpx` `POST /api/console/upload`（multipart `file=(name,data,mime)`），
  拿回 `{url}` 后构造 **`FileContent(type=FILE, filename=name, file_url=url)`**
  （`channel.py:717-760`）。这里**所有类型都变成 `FILE`，图片也一样**。
- 落盘位置由 QwenPaw 决定：console 通道 `media_dir`（默认 `workspace_dir/media`，
  `app/channels/console/channel.py:117-120`），文件名为 `uuid4().hex + "_" + safe_name`
  （`app/routers/console.py:672-676`）。`/api/console/upload` 没有大小限制，除非
  部署设置了 `QWENPAW_UPLOAD_MAX_SIZE_MB`（`app/utils.py:169-187`）。
- 然后 `enqueue(native)` 把 `content_parts`（TextContent + FileContent）直接送进
  通道队列（`channel.py:655-675`），**绕过** console 的
  `_resolve_console_upload_refs`——顺带一提，那个函数在 2.2.2.post1 里**没有任何调用点**
  （`app/channels/console/channel.py:206`，全仓 grep 只有定义），即使调用它也不会把
  `FileContent` 改成 `ImageContent`。

### 1.4 发送侧的两个既有小坑

- 纯附件轮次 `text:""`（`App.tsx:4080-4095`）：插件 `content_parts` 只有 FileContent，
  没有文本 part —— 这是第 3 节「历史整条消失」的根因。
- `chunks = Math.ceil(size / CHUNK_BYTES)`，空文件会得 0，插件 `begin` 要求 `chunks>=1`
  → `E_STATE`；但空文件在 pick 阶段就被 base64 判空拦掉了，实际不可达（`App.tsx:4296-4300`）。

---

## 2. QwenPaw 侧能力（源码证据，2.2.2.post1）

### 2.1 通道消息里的附件表示

内容块是 pydantic 联合类型（`src/qwenpaw/schemas.py:51-57` 的 `ContentType`：
`TEXT/IMAGE/AUDIO/VIDEO/DATA/FILE/REFUSAL`）：

- `ImageContent{image_url}`（`schemas.py:91-94`）
- `FileContent{filename, file_url}`（`schemas.py:107-110`）

`AgentRequest.input` → agentscope `Msg` 的转换在
`src/qwenpaw/runtime/message_convert.py:73-187`：

| ctype | 产物 |
|---|---|
| `image` | `DataBlock(URLSource(url, media_type=image/*))`（`:117-150`） |
| `file` | `DataBlock(URLSource(url, media_type="application/octet-stream"))`（`:152-165`，**media_type 硬编码**） |

也就是说：**`FileContent` 永远变成 octet-stream 的 DataBlock**，原始 MIME 只留在了
上传那一刻的 multipart 里，消息模型里没有。

### 2.2 运行时到底有没有把图片多模态喂给模型

结论：**对当前 webchannel 的附件路径，没有**。链路三处都会丢：

1. **formatter 级**：OpenAI 兼容 formatter 只接受 `text/plain / image/* / audio/* /
   application/pdf`，其余 media_type 打一条 warning 后 **直接跳过该 block**
   （`agentscope/formatter/_openai_formatter.py:30-75`，`input_types` 见 `:236-240`）。
   DashScope 是 `text/plain / image/* / audio/* / video/*`（`_dashscope_formatter.py:30-44`），
   DeepSeek 默认 **只有 `text/plain`**（`_deepseek_formatter.py:26-32`，注释原文
   「image input is only supported by `deepseek-flash`」）。octet-stream 三边都不匹配。
2. **能力级**：`normalize_messages_for_model_request(..., supports_multimodal=...)`
   在 `supports_multimodal` 为假时 **删掉所有媒体 block**
   （`agents/utils/message_request_normalizer.py:326-377`，删除点在 `:354`）。
3. **降级提示级**：唯一进模型的是文本——`MediaProcessHook`（PRE_EXECUTE，注册于
   `app/workspace/bootstrap_factory.py:105`）会对每个本地 `file://` DataBlock 追加一行
   `用户上传文件<名字>，已经下载到 <绝对路径>`
   （`hooks/request_setup/media_hook.py:15-36` → `agents/utils/message_processing.py:519-594`，
   文案在 `:124-134`）。注意 `filename` 取自 `getattr(block,"name")`，而
   `message_convert` 取的是 `FileContent.file_name`（不存在），所以这行**不含文件名**。

这行提示是**写进会话状态**的（hook 直接改 `ctx.input_msgs`，随后
`executor.run(ctx.input_msgs)` 进 agent context，`runtime.py:132-137`；SessionSaveHook 落盘）。
对本项目当前路径它**不会出现在历史里**，因为 `FileContent` 触发了
`qwenpaw_original_user_content` 的保存、历史还原时整条替换掉了（见 3.1）。
**但这条保护只对 `file` part 生效**——这是 G2 的关键副作用，见 §6。

所以 agent 的「可见性」= 知道有个文件 + 绝对路径；文本类文件可以自己
`read_file`（`agents/tools/file_io.py:126`），PDF/Office 要靠 skill（本地 skill_pool 里有
`pdf`/`docx`/`xlsx`/`pptx`/`file_reader`，`file_reader` 的描述明确「PDF/Office/images
交给别的 skill」），图片要靠 `view_image` 工具（`agents/tools/view_media.py:684`）。

`view_image` 才是真正的多模态入口：它把文件重新包成**正确 media_type** 的 DataBlock，
并在模型不支持时附加一段「你看不见这张图」的提示（`view_media.py:684`、`617-670`）。

### 2.3 vision 判定：三级证据与 fail-open

- 元数据字段：`ModelInfo.supports_multimodal / supports_image / supports_video`，
  `None` = 未探测（`providers/model_info.py:46-59`）。
- 判定：`get_active_model_supports_multimodal()` 在元数据缺失时 **返回 True**
  （fail-open，注释：宁可让上游报 400，也不要把多模态模型的图悄悄删掉）
  （`agents/prompt.py:432-446`）。
- 形式化提示：能力为 False 时系统提示会明说「只能理解文本」
  （`prompt.py:534-553`）。
- 运行时会**自动探测**：切换到非 `hub-managed` 的 provider 时
  `maybe_probe_multimodal` → 后台发一张 32×32 PNG，先看是否 400，再做语义校验
  （`providers/provider_manager.py:667-700`；`openai_provider.py:586-700`；
  `multimodal_prober.py:42-97`）。探测结果写回 `supports_image/probe_source`。
  也可以手动 `POST /api/models/{provider_id}/models/{model_id}/probe-multimodal`
  （`app/routers/providers.py:869-882`）。
- 反向学习：一旦上游真的以 media 报错，`ModelCapabilityCache` 会记住
  `rejects_media` 并在后续请求里剥图（`providers/model_capability_cache.py:42-57`）。

### 2.4 托管在用的 sensenova / deepseek 是不是多模态

**只能给源码/元数据证据，不给印象：**

- **sensenova：QwenPaw 完全不认识。** 全仓（含
  `src/qwenpaw/providers/data/`、`index.json`、`model_capabilities.json`）
  grep `sensenova` **零命中**；内置 provider 目录 31 个 JSON 里也没有
  （`providers/data/providers/`）。因此它在托管侧只能是 **custom provider**，
  其模型能力在 QwenPaw 元数据里就是 `None`（未探测）→ 请求时 fail-open（当成多模态，
  图片会被发出去，真不支持就吃上游 400）。**没有「QwenPaw 认定它是多模态」这回事**；
  唯一权威答案是运行时探测结果（`supports_image` + `probe_source`）或
  `probe-multimodal` 的返回。本次没有访问托管环境，未执行。
- **deepseek：内置元数据是明确的**（`providers/data/providers/deepseek.json`，
  `probe_source=documentation`）：

  | model | supports_image |
  |---|---|
  | `deepseek-chat` | false |
  | `deepseek-reasoner` | false |
  | `deepseek-v4-pro` | false |
  | `deepseek-v4-flash` | **true** |
  | `deepseek-flash` | **true** |
  | `deepseek-v4-flash-vision-exp` | **true** |

  但即便 `supports_image=true`，只要走的是 **DeepSeek formatter**，默认
  `input_types=["text/plain"]` 仍会把图片 block 丢掉（`_deepseek_formatter.py:26-32`），
  除非该模型用的是别的 formatter/被显式放宽。托管侧「deepseek」若是自定义
  OpenAI 兼容 provider，则按 `supports_image` 走 OpenAI formatter（接受 `image/*`）。
  **托管侧具体提供哪些 model id 未验证**（不可从本仓库推断）。

### 2.5 对 M31 的直接含义

插件目前**永远发不出 image block**（1.3 的 `FileContent` + 2.1 的 octet-stream），
所以「模型是不是多模态」在现状下**根本不影响结果**：图片一律进不了模型。
只有把插件侧改成按 MIME 发 `ImageContent`，vision 能力才第一次成为变量。

---

## 3. 历史侧现状

### 3.1 QwenPaw 的 `ChatHistory` 里其实有附件

`GET /api/chats/{chat_id}`（`app/chats/api.py:820-912`）→ `agentscope_msg_to_message`
→ 用户轮次优先用 `metadata.qwenpaw_original_user_content` 还原原始 content parts
（`app/chats/utils.py:549-571`）。这份 metadata 是 `message_convert._request_message_metadata`
在**存在 `file` 且带 `file_url` 的 part** 时写入的（`message_convert.py:26-45`）。
所以本项目的附件在历史里是 **`FileContent{filename, file_url}`**，`file_url` 是
容器内绝对路径（`_resolve_content_url` 返回本地路径，`chats/utils.py:332-338`）。

重要不对称：**只有 `file` part 会触发这份「原始内容」保存**。纯 `ImageContent` 的轮次
没有这份 metadata，历史只能读持久化的 Msg —— 而那里面**带着 `media_hook` 插入的
绝对路径提示行**（2.2 第 3 点）。这正是现状（全 `FileContent`）历史里看不到提示行的原因，
也是 §6 G2 不能「只改类型」的原因。

### 3.2 插件 `hist` 把附件全丢了，纯附件轮次整条消失

`plugin/util.py:335-366 history_messages` 只投影 `{role, text, turn?}`；
底层 `_history_entries`（`util.py:298-332`）用 `_part_texts`（`util.py:180-194`）
**只取 `type=="text"` 的 part**，并且 `if not text: continue`。

两个后果：

1. `hist` 帧（`frames.hist_frame`，`frames.py:187-200`；协议
   `protocol/frames.md:69` 的 `messages:[{role,text,turn?}]`）**没有任何附件字段**。
2. **纯附件轮次（`text:""`）被整条过滤掉**：`metadata.qwenpaw_original_user_content`
   里只有 `FileContent`、没有 TextContent（`message_convert.py:39-44` 只排除空
   TextContent），于是 `_part_texts` 返回空 → 该用户消息从 `hist` 里消失，
   而助手回复还在 —— 刷新后会出现「没有提问的答案」。导出不受影响（见 4.2，
   它直接遍历原始 messages）。

### 3.3 SPA 历史渲染

- `historyMessages()`（`App.tsx:610-628`）只读 `role/text/turn`，产出
  `HistoryMessage{role,text,turn?}`；`appendHistory`（`App.tsx:2231-2276`）
  生成的 `ChatMessage` 不带 `attachments`。
- `ChatMessage.attachments?: string[]`（`App.tsx:339`）**只在乐观发送时**被赋值：
  `attachments: file ? [file.name] : undefined`（`App.tsx:4126`）。
- 渲染只有文件名 chip：`.bubble-files` + `FileText` 图标 + 名字
  （`App.tsx:1007-1016`，样式 `App.css:2003-2008`）。**没有缩略图、没有下载、没有尺寸/类型**。
- 助手方向的媒体 part（`send_content_parts` 序列化，`channel.py:2004-2028`）只落到
  `PartCard` 的 `<details><pre>{JSON}</pre>`（`App.tsx:741-748`），同样不渲染图片。

---

## 4. 归档 / 导出 / 搜索

### 4.1 Turso 归档：只有一行文本后缀，且分片附件没有

- 表结构只有 `chats/messages(chat_id, role, content, created_at)`
  （`plugin/turso_archive.py:33-40`），**没有附件列、不存字节**。
- 用户轮次的 `content = text + format_files_suffix(files_meta)`，形如
  `\n[attachments: a.png (image/png, 12345 bytes)]`（`turso_archive.py:100-117`、`150-159`）。
- `files_meta` 在 `channel.py:619-647` 里从 `msg.files[]` 的 **`name` 字段**收集；
  分片上传的消息只带 `{ref: id}`（`App.tsx:4100`）→ **没有 name → 什么都不记**。
  M6 报告已把这条记为 known limitation（`docs/turso-report.md:28-33`）。
- 所以：**≤180 KB 的 inline 附件有文件名痕迹；>180 KB（几乎所有截图/文档）没有。**

### 4.2 导出 Markdown：有占位，但只有名字

- `build_export_markdown`（`util.py:2392-2445`）直接遍历原始 `ChatHistory.messages`，
  不经过 `_history_entries` 的「必须有文本」过滤，所以**纯附件轮次能导出**。
- `_content_blocks` 遇到 `_is_attachment(part)` 输出 `[附件: name]`
  （`util.py:2303-2304`）；`_attachment_name` 取 `filename`/`name`，退而取 URL 末段，
  data URL 记 `内嵌附件`，并且**只保留裸文件名，绝不泄露绝对路径/字节**
  （`util.py:2226-2259`）。
- 协议与 README 已写明「附件仅记录文件名等元信息，不含附件内容」
  （`protocol/frames.md:581-592`、`README.md:110`）。
- 缺口：没有 MIME、没有大小、没有「可回看」的入口（只有一个方括号字符串）。

### 4.3 搜索：文件名能搜到，但只有 inline 附件，且跳不过去

- 搜索是 `messages.content LIKE %q%`（`plugin/turso_search.py:58`、`233-303`），
  所以 **inline 附件的文件名可以被命中**（后缀在 content 里）。
- 分片附件 → 后缀不存在 → **搜不到**（4.1）。
- 命中后 `findMessageAnchor` 是**纯文本锚定**（`spa/src/lib/jump.ts:87-160`），
  而 `hist` 里既没有 `[attachments: …]` 后缀、纯附件轮次甚至整条不存在，
  所以命中会退化成「已打开会话，无法在会话内定位」
  （`App.tsx:3393-3405`）。搜索本身=部分，跳转=不可用。

---

## 5. 现状矩阵

| 能力 | 状态 | 证据（file:line） | 说明 |
|---|---|---|---|
| **发送图片** | **已支持** | `App.tsx:4284-4321`、`2304-2366`、`4096-4101`；`channel.py:717-760`；`console.py:640-676` | 选择/粘贴/拖放均可，任意图片类型，≤10 MB，分块 + sha256；图片会写进 `media_dir`。**只是「送达」，不是「看懂」** |
| **发送文件** | **已支持** | 同上；`util.py:391-418`、`512-627` | 任意类型、单文件/条、10 MB 上限；无 MIME 白名单（QwenPaw 只对图片做 PIL 校验） |
| **agent 可见性** | **部分** | `message_convert.py:152-165`（octet-stream）；`_openai_formatter.py:30-75`、`_deepseek_formatter.py:26-32`（丢弃）；`message_processing.py:124-134`（路径提示） | 文本文件：拿到路径 → `read_file`；PDF/Office：靠 skill；**图片：模型看不到像素**（即便多模态），只能由 agent 主动 `view_image` 才有机会。注意 `ImageContent` 的修复有历史副作用（§6 G2） |
| **历史回看** | **缺失** | `util.py:180-194`、`298-332`、`335-366`；`App.tsx:610-628`、`2231-2276`、`1007-1016` | `hist` 无附件元数据；**纯附件轮次整条消失**；SPA 只有乐观气泡上的文件名 chip，刷新即无 |
| **导出** | **部分** | `util.py:2226-2259`、`2262-2309`、`2392-2445`；`protocol/frames.md:581-592` | 有 `[附件: name]` 占位（纯附件轮次也导得出来），但无 MIME/大小/内容/链接 |
| **搜索** | **部分** | `turso_archive.py:100-117`、`150-159`；`channel.py:619-647`；`turso_search.py:58`；`jump.ts:87-160` | 只有 ≤180 KB inline 附件的文件名可被 LIKE 命中；分片附件无痕；命中后无法定位 |

---

## 6. 缺口清单（按价值排序，每项给具体修法）

### G1（P0）历史里附件不可见 + 纯附件轮次消失

**证据**：3.2 / 3.3。**影响**：刷新后「图没了、连问题都没了」，是最刺眼的产品缺陷。

**修法（插件为主，SPA 收尾，协议只加可选字段）**

1. `plugin/util.py::history_messages`：把非 text part 投影成
   `files:[{name, mime?, size?, kind:"image"|"file"}]`（`image_url`/`file_url`/
   `video_url`/`audio_url` 都算附件，复用 `_is_attachment`/`_attachment_name` 的判定，
   名字只留裸文件名）。size 用 `os.stat(file_url)` 尽力而为，失败就**省略**而不是 0
   （与 M11「unknown 不写 0」一致）。**按 URL 去重**：G2 方案 A 会让同一个文件同时以
   FileContent + ImageContent 出现（URL 相同），投影必须合并成一条并取 `kind="image"`。
2. 让「有附件但没文本」的消息**保留**：`text` 允许为 `""`，只要 `files` 非空就进 entries。
   注意 `_history_entries` 同时被 `_attach_history_turns` 使用（turn 锚点要求 assistant
   文本），加附件不能改变 turn 的锚定规则——最稳的做法是给 `history_messages` 单独
   走一遍投影，而不是改 `_history_entries` 的过滤。
3. `frames.hist_frame` 不需要改结构（messages 里多一个可选键）；`pack_history` 已经按
   实际帧大小打包，附件元数据只有几十字节，不影响 256 KB。
4. SPA：`historyMessages()` 解析 `files`；`ChatMessage.attachments` 从 `string[]` 升级为
   `{name,mime?,size?,kind}[]`（乐观消息也构造同构对象）；`appendHistory` 在重叠段
   像 `turn` 一样把 `files` 补到已显示的气泡上（`App.tsx:2255-2263`）；
   气泡渲染 chip（图片在 G3 落地后升级成缩略图）。
5. 协议：`protocol/frames.md` §4 的 `hist` 行补 `files?`，§7 说明是附加字段（无版本协商）。

**测试**：`plugin/tests/test_m15.py` 旁新增用例——(a) 纯附件轮次出现在 hist；
(b) 图片/文件/视频/音频四种 part 的投影；(c) `file_url` 绝对路径不外泄；
(d) 无文本 + 无附件仍然跳过；`spa/tests` 加投影与合并的 vitest；
e2e 用 mock agent 的 `hist` 带 `files`，刷新后断言 chip 仍在。

**风险**：低。唯一需要注意的是 `_history_entries` 的复用面（导出/turn 锚点）。

### G2（P0）图片对模型不可见（即便模型是多模态）

**证据**：1.3 + 2.1 + 2.2；现状下 vision 能力根本不参与。

**先看一个不能忽略的副作用**：把 `FileContent` 换成 `ImageContent` 会让
`qwenpaw_original_user_content` **不再保存**（`message_convert.py:34-38` 只认 `file`），
历史于是退回去读持久化 Msg，而那里面有 `media_hook` 插入的
「用户上传文件，已经下载到 /绝对路径」文本（2.2 第 3 点、3.1）。结果：图可能能看了，
但**绝对路径会出现在历史气泡和导出 Markdown 里**。所以 G2 不是一行改动。

**修法（三选一，推荐 A）**

- **A（插件内可交付，推荐）**：`image/*` 同时发**两个 part**（同一个 `file_url`）：
  `FileContent` 先、`ImageContent` 后。
  - `FileContent` 负责触发原始内容保存（历史干净、没有提示行）；
  - `ImageContent` 负责让 `message_convert.py:117-150` 产出 `media_type=image/png`
    的 DataBlock，OpenAI 兼容 formatter 才会生成 `image_url`；
  - octet-stream 那个 block 会被 formatter 跳过（一条 warning/次，可接受），模型只看到一张图；
  - 代价：原始 content 里同一个文件出现两次，**G1 的投影和 G5 的导出必须按
    `file_url` 去重**（两个 part 的 URL 完全相同，去重是精确的）。
- **B（更省事但脆）**：只发 `ImageContent`，插件在 `history_messages` 与
  `_render_message` 里过滤 QwenPaw 的两条提示模板
  （`用户上传文件…已经下载到 ` / `User uploaded a file…, downloaded to `，
  `message_processing.py:132-134`）。省掉双 part，但依赖上游文案，改版就漏路径。
- **C（最干净，需上游）**：推动 QwenPaw 把 `_request_message_metadata` 的保存条件从
  「有 `file` part」扩到 `file/image/video/audio`（`message_convert.py:34-38` 一处条件）。
  这属于容器侧改动，超出本仓库交付面，按「探查门控」记为待上游。

**其余两点与 A/B/C 无关**

1. 保留路径提示：`media_hook` 对任何本地 DataBlock 都会补「已下载到 /path」
   （`message_processing.py:357-380`、`581-592`），所以文本模型仍能拿到路径并调用
   `view_image`/`read_file`，不会因为改了类型而变瞎。
2. 能力提示（建议）：`models` 帧（控制帧）在 `{provider, model, active}` 之外
   加可选 `vision: true|false|null`，数据来自插件已经拉过的 `GET /api/models`
   （`ProviderInfo.models[].supports_image/supports_multimodal`，
   `app/routers/providers.py:347-355`、`providers/provider.py:130-170`）。
   **只拷布尔值，绝不转发 `api_key`**（沿用 `util.model_items` 的白名单思路，
   `util.py:738-783`）。SPA 在 `vision===false` 时给「当前模型可能看不到图片」的提示。

**探查门控**：sensenova 的能力**未知**（2.4），所以这一步不能承诺「托管一定能看图」。
落地顺序建议：先做 A 的类型分流（当前也不会更差），再用 `probe-multimodal`
把托管 provider 的真实能力测出来；结果写入 provider 元数据后，SPA 提示自动变准。

**验收必须包含的反向检查**：发一张图 → `GET /api/chats/{id}` 里**不应**出现
`已经下载到`/`downloaded to` 文本；历史投影里同一文件只出现一次。

**测试**：`plugin/tests/test_m5.py`/`test_m12.py` 加 `_store_file` 的 MIME 分流单测
（mock httpx，断言 image 产出两个 part 且 URL 一致）；`test_m7.py` 加 `models` 帧的
`vision` 字段（含 null）；`test_m15.py` 加「双 part 去重后只有一个附件」。

### G3（P1）历史里的图片没有取回通道（无缩略图/无下载）

**证据**：3.3；`FileContent.file_url` 是容器内绝对路径，SPA 永远取不到。

**修法（按 export 的既有约定新增一对控制帧，复用其字节数 + sha256 校验）**

```
client → agent : {"t":"att_get","chat":"…","id":"<corr>","ref":"<opaque>"}
agent → client : {"t":"att_begin","chat","id","bytes","chunks","sha256","name","mime"}
                 {"t":"att_chunk","chat","id","i","data"}   // ≤96 KB 原始字节, 40 ms 间隔
                 {"t":"att_end","chat","id"}
                 失败: {"t":"error","code":"E_ATT","chat","id","detail"}
```

- **`ref` 绝不能用客户端给的路径**：插件在 hist/serve 时按 `(chat, msg original_id,
  part_index)` 自签一个短引用，并只在内存里维护 `ref → 绝对路径` 的映射（TTL 与
  `FileTransfers` 一致的 10 min）；收到 `att_get` 时重新 `GET /api/chats/{id}` 校验该
  消息仍存在，再 `Path(p).resolve()` 并要求 `is_relative_to(media_dir)`（`media_dir`
  默认为 `workspace_dir/media`，`console/channel.py:117-120`），`is_file()`，大小 ≤10 MB。
- 走 `_send_control`（无 seq、不进 ring、不重放），与 `export_*` 完全同构
  （`channel.py:1698-1714`、`protocol/frames.md:542-575`）。
- SPA：只对 `image/*` 自动请求并渲染 `<img>`（object URL，用完 revoke），其它类型给
  「下载」按钮；失败就退回 chip，不阻塞会话。

**替代方案（不新增帧）**：插件用 Pillow 生成 ≤24 KB 的 320 px JPEG 缩略图，以
`data:image/jpeg;base64,…` 内联进 hist 的 `files[]`。代价：多一个 Pillow 依赖 + CPU，
hist 帧变大（`pack_history` 会把单条消息单独成帧，超过 256 KB 就直接破限），
且不能取原图。**建议仍走 `att_*` 帧**，只在「不想扩协议」时选缩略图。

**测试**：路径穿越（`../../etc/passwd`、符号链接、media_dir 之外）必须 403/E_ATT；
超限 10 MB；过期 ref；跨 chat 引用；sha256 不符丢弃。SPA vitest 判定
「image 渲染 img / 其它渲染下载」。

### G4（P1）分片附件的文件名在归档与搜索里不存在

**证据**：4.1（`channel.py:622-631` 只认 `name`，分片消息只有 `{ref}`）。

**修法（最小改动，协议附加字段）**

- SPA 发送时带上已知元数据：`files:[{ref, name, mime, size}]`（`App.tsx:4100` 一行改动，
  数据本来就在 `Attachment` 里）。
- 插件在 `_handle_msg` 收集 `files_meta` 时：先看 entry 自己有没有 `name`，没有再用
  `_files` 里暂存记录的名字（给 `FileTransfers` 加一个只读 `peek(tid, now)`），
  两者都没有才跳过。
- 附带收益：纯附件轮次的归档 title 为空（`make_title(text)`，`turso_archive.py:95-97`），
  可以用第一个附件名兜底，搜索列表不再显示 chat id。

**测试**：`test_m5.py` 断言分片消息的 `archive_user` 收到 `files_meta`；
`test_turso.py` 断言 content 里出现 `[attachments: …]`；`test_search_edges.py`
加「按文件名搜到分片附件」的端到端用例。

### G5（P2）导出占位信息太薄

**证据**：4.2。**修法**：`[附件: name · mime · size bytes]`（`util.py:2303-2304` 一处），
有 `att_*` 通道后可选追加一句「可在会话中回看」。协议 §12.2 与既有断言
（`test_m12.py:194,317-318,363`）同步更新；仍然**不输出路径与字节**。

### G6（P2，可选）SPA 附件交互的成熟度

- 单附件：`Attachment` 是单值（`App.tsx:1662`）→ 多附件需要改成列表 + `msg.files[]`
  多元素（协议已支持数组，插件也已按数组遍历，`channel.py:623-651`）。
- 类型提示：`input` 没有 `accept`（`App.tsx:5193`），可以考虑
  `accept="image/*,.pdf,.txt,.md,.csv,.json,..."` 但**不要**因此拒绝其它类型
  （与现有「任意类型」行为冲突时以产品决定为准）。
- 图片缩略图/粘贴预览：依赖 G3。

这三项都不是「缺陷」，是产品化增量；本次不主张必须做。

---

## 7. 探查门控 / 建议跳过

| 想法 | 结论 | 依据 |
|---|---|---|
| 让插件直接把图片「塞进模型上下文」（绕过 QwenPaw 的 formatter） | **跳过** | 通道 API 只接受 content parts；formatter 是基于能力元数据的唯一出口，硬塞等于自己实现一套 model client（`message_convert.py` + `model_factory.py`） |
| 强制把文本模型「升级」成多模态 | **跳过** | `message_request_normalizer.py:354` 会删媒体块；`view_media` 的能力提示是 QwenPaw 的既定降级路径 |
| 让 agent 原生读 PDF/Office | **跳过（skill 门控）** | 核心 `read_file` 明确「Images, PDFs and other binaries come back as unusable bytes… Use view_image for images」（`agents/tools/file_io.py:126-150`）；PDF 由技能池里的 `pdf` skill 负责 |
| 把附件字节写进 Turso | **跳过** | 现有 schema 无列、fire-and-forget 队列 200 条；且与「归档只存文本」的既定口径冲突（`docs/turso-report.md`） |
| 服务端另存一份附件副本 | **跳过** | `media_dir` 已经是权威副本，QwenPaw 历史里带绝对路径 |
| 用 `/api/files/preview/<abs>` 取附件 | **可用但非首选** | 存在且有 WORKING_DIR/sensitive 双重守卫（`app/routers/files.py:59-100`），但插件与容器同进程/同机，直接读 `media_dir` 更少一层 HTTP，也更容易做路径穿越测试 |

---

## 8. 复验命令（只读，不改托管）

```bash
# 1) 当前发送路径与阈值
grep -n "MAX_FILE_BYTES\|CHUNK_BYTES\|INLINE_PROBE_BYTES" spa/src/App.tsx

# 2) 插件把附件包成什么
grep -n "FileContent\|application/octet-stream" plugin/channel.py \
  ~/workspace/qwenpaw-ref/src/qwenpaw/runtime/message_convert.py

# 3) hist 是否带附件
grep -n "def history_messages" -A 32 plugin/util.py

# 4) 托管 provider 的真实 vision 能力（需要容器内 API 访问；本次未执行）
curl -s $QWENPAW_API/api/models | jq '.[] | {id, models: [.models[] | {id, supports_image, supports_multimodal, probe_source}]}'
curl -s -X POST $QWENPAW_API/api/models/sensenova/models/<model>/probe-multimodal | jq .
```

---

## 9. 未验证项与风险

1. **托管侧 provider 的实际 model id 与能力**未验证（本地 workspace 的 active model 是
   `kilo/kilo-auto/free`，与托管无关；`sensenova` 在 QwenPaw 里没有任何元数据）。
   结论只能落在「未知 → fail-open → 以 probe 为准」。
2. **容器里的 QwenPaw 版本**未直接确认；本报告以 `2.2.2.post1` 源码为准（与本地 venv 一致）。
   若托管版本更旧，`qwenpaw_original_user_content` 的还原逻辑可能不存在，G1 的数据源
   需要先做一次 `GET /api/chats/{id}` 的实包检查（看 content 里有没有 `type:"file"`）。
3. **formatter 行为**依据安装的 agentscope `2.0.10`（QwenPaw 的 pin）。升级 agentscope
   需要重验 `_openai_formatter.py` 的 `input_types` 与 `_deepseek_formatter.py` 的默认值。
4. G3 的 `att_*` 帧会让 relay 多转发分块（与 export 同量级），30 帧/s 的租约上限意味着
   10 MB 附件约 4–5 s；**不要**在 hist 里内联原图。
5. 本次**未运行**任何测试套件（审计任务，且未改代码）；测试条目是给实现任务的验收清单。

---

# 实现记录（M31 IMPLEMENTATION）

状态：**G1 / G2-A / G3 / G4 / G5 已实现；G6 按任务范围延后**。未提交、未触碰托管环境；
插件 ZIP 已重新构建（`dist/webchannel.zip`）。基线仍是 QwenPaw `2.2.2.post1`。

## 1. 逐项交付

### G1（P0）历史里的附件与纯附件轮次 — 已交付

- `plugin/util.py::_history_files` / `_hist_entries` / `history_messages`：
  - `hist.messages[]` 新增可选 `files:[{name, mime?, size?, kind, ref?}]`；
  - 按 URL 去重：G2-A 的 `FileContent` + `ImageContent`（同一 `file_url`）合并为一条，
    `kind="image"`，名字取带显式 `filename` 的那个 part；
  - `name` 只保留裸文件名；绝对路径、`file://`、data URL 均不会出现在帧里；
  - `mime` 依次取 part 字段 → data URL 头 → 扩展名猜测，未知则**省略**；
  - `size` 用 `os.stat` 尽力而为，失败**省略**（不写 0，沿用 M11 口径）；
  - 纯附件轮次（`text:""`）保留，`text`+`files` 都为空的消息仍然跳过；
  - `turn` 锚定规则**没有改变**：回执仍在旧的纯文本 `_history_entries` 投影上计算，
    再按原始消息下标合并进新投影，附件不可能把回执挪到别的消息上。
- `spa/src/App.tsx`：`HistoryMessage.files` 解析、`ChatMessage.attachments` 从
  `string[]` 升级为 `{name,mime?,size?,kind,ref?}[]`，`appendHistory` 在重叠段把
  `files` 覆盖到已显示的气泡（乐观气泡因此从“只有名字”升级到“可回看”），气泡统一由
  `AttachmentList` 渲染。
- `protocol/frames.md` §2.3 / §15.3 记录 `files?`。

### G2 方案 A（P0）图片对模型可见 + vision 提示 — 已交付

- `plugin/channel.py::_store_file` 返回**内容块列表**（不再是单个 `FileContent`）：
  `image/*` → `[FileContent, ImageContent]`，两者 `file_url`/`image_url` 完全相同，
  FileContent 在前。FileContent 继续触发 QwenPaw 保存 `qwenpaw_original_user_content`
  （历史干净、没有 media hook 的路径提示），ImageContent 让运行时生成真正的
  `image/*` DataBlock，OpenAI 兼容 formatter 才会把它交给模型。
- `plugin/util.py::model_items`：`models.items[]` 新增可选 `vision`，**只拷布尔值**
  （`supports_image`，否则 `supports_multimodal`）；`None`/未探测 → 字段省略，绝不
  写成 `false`。`api_key`、`base_url` 等 `ProviderInfo` 字段仍然不外发。
- SPA：模型面板/工具条只在 `vision === false` 时显示一行
  `图片可能不可见` 的弱提示；未知不提示（fail-open 语义）。
- **反向检查已进测试**（`test_m31.py::test_image_turn_history_has_no_media_hook_notice`）：
  先断言双 part 里确实存在带 `file_url` 的 `file` part（这是 QwenPaw 保存原始内容的前置
  条件），再用这组 part 构造历史，断言投影文本不含 `已经下载到` / `downloaded to`，
  且同一文件只出现一次。这是插件层对 `message_convert._request_message_metadata`
  规则的编码（仓库里没有容器源码，测试不启动托管容器）。

### G3（P1）附件取回通道 — 已交付

- 新帧（控制帧，无 `seq`、不进 ring、不重放）：
  `att_get` / `att_begin` / `att_chunk` / `att_end` + `error{code:"E_ATT", chat, id, detail}`。
  字节数 + sha256、96 KB 原始字节/片、40 ms 间隔，与 export 完全同构。
- **ref 完全由插件签发**：`util.AttachmentRefs` 用 `secrets.token_urlsafe(12)` 生成，
  绑定 `(chat, path, msg_id, part_index)`，TTL 10 分钟；帧里只有 ref，客户端无法传路径。
- 每次 `att_get` 重新校验：ref 存在且未过期 → 属于当前 chat → 重新
  `GET /api/chats/{id}` 确认该消息（`metadata.original_id`）与附件 URL 仍在 →
  `Path.resolve()` 后必须位于 `media_dir` 内 → 是普通文件 → ≤10 MB。
  `..` 穿越、符号链接逃逸、跨 chat、过期 ref、超限、消息被删都会得到 `E_ATT`。
- `media_dir`：优先 `CONSOLE_MEDIA_DIR`，否则 `<workspace_dir>/media`（console 通道默认）。
- SPA：`spa/src/lib/attachments.ts::AttachmentFetcher` 复用 export 的校验思路
  （长度 + SHA-256），按 `(chat, ref)` 合并并发请求，30 s 超时、失败/`E_ATT` 一律静默
  退回 chip；图片用 object URL 渲染，组件卸载/切换会话时 `revokeObjectURL`；其它类型
  显示“下载”按钮，保存时用插件返回的裸文件名。
- `protocol/frames.md` 新增 §15（含 ref 设计理由、帧格式、校验清单）。

### G4（P1）分片附件的名字 — 已交付

- SPA 的分片消息现在发送 `{ref, name, mime, size}`（`App.tsx::send`）。
- `plugin/util.py::FileTransfers.peek` 提供只读暂存元数据；`channel._file_meta` 先取
  entry 自己的名字，再退回暂存记录，最后才跳过；名字统一裁成裸文件名。
- `plugin/turso_archive.py::user_requests`：无文本轮次的归档标题回退到第一个附件名，
  搜索/会话列表不再显示 chat id；`[attachments: …]` 后缀照旧。

### G5（P2）导出占位 — 已交付

- `_content_blocks` 的附件行变为 `[附件: name · mime · size bytes]`（大小未知时省略），
  并**按 URL 去重**，所以 G2-A 的双 part 只产生一行。
- 仍然只输出裸文件名、MIME 与大小，不输出路径、不输出附件字节。
- `protocol/frames.md` §12.2 与 `test_m12.py` 的四处断言同步更新。

### G6（P2）— **未实现（按任务范围延后）**

单条消息仍只支持一个附件；`input[type=file]` 仍没有 `accept` 提示；多附件、粘贴预览、
批量拖放留待后续。现有协议 `msg.files[]` 和插件遍历已经是数组，扩展时无需改帧。

## 2. 关键设计取舍

1. **不做 media-hook 文本过滤**。G2 选 A，路径提示根本不进历史；没有采用 B 的
   “按上游文案过滤”，避免依赖易变的中文/英文提示模板。反向检查用测试锁住前置条件。
2. **ref 会话内复用**。同一 `(chat, path, msg_id, part)` 在 TTL 内返回同一个 ref，
   避免每次 `hist` 都制造新 token；token 本身不携带任何路径/消息信息。
3. **只读 `peek`**。G4 的元数据读取不能消耗暂存文件（`msg` 之后还要 `take` 上传），
   因此新增 `peek` 而不是改 `take`。
4. **vision 三态**。`true / false / 省略`；SPA 只在 `false` 时提示。托管侧 sensenova
   仍无 QwenPaw 元数据（fail-open），所以不会因为“没探测”而吓用户。
5. **0 字节附件**。G3 允许 `bytes=0, chunks=0`（插件不会上传空文件，但历史里可能有），
   SPA 用空缓冲区的 sha256 校验而不是直接拒绝。
6. **失败降级不阻塞**。`E_ATT` 带 `chat`+`id`，只结算对应的 chip，绝不进入通用 toast，
   也不会被误判成连接级 `E_AUTH`。

## 3. 测试

| 套件 | 结果 |
|---|---|
| 插件（`~/workspace/qwenpaw-local/venv/bin/python plugin/tests/test_*.py`） | **20 个套件 / 381 个测试函数全绿**；新增 `test_m31.py` 24 项（G1 投影、G2 双 part/vision/反向检查、G3 路径穿越/符号链接/跨 chat/过期/超限/消息删除、G4 peek/归档标题、G5 去重） |
| SPA vitest（`npm test`） | **15 个文件 / 207 项全绿**；新增 `tests/attachments.test.ts` 12 项（解析、去重、kind 判定、分块校验、并发合并、超时、`E_ATT`、0 字节、dispose） |
| SPA 构建（`npm run build`） | `tsc --noEmit` + `vite build` 通过 |
| Playwright（`node tests/e2e_m19.mjs`） | **356 项全绿**（M31 新增 18 项 = 桌面/手机各 9 项）：发图（纯附件轮次）→ 乐观 chip → 刷新 → 历史里出现 `img.att-thumb`（blob URL、naturalWidth>0、空文本用户行保留）→ 发文本文件 → 刷新 → 名字保留 → 点“下载”得到 `笔记.txt` |

路径穿越用例覆盖：`../`、media_dir 外文件、符号链接指向外部、跨 chat ref、过期 ref、
未知 ref、客户端直接传路径、消息被删除、>10 MB。

## 4. 产物

- 插件 ZIP：`dist/webchannel.zip`，**84,143 bytes**，MD5
  **`41b683a5e2ba19e40e2dad360bd81ad8`**（`bash tools/package_plugin.sh`，固定时间戳）。
- 未提交；未访问/修改托管环境。

## 5. 已知边界

- ref 10 分钟过期；页面停留过久后点下载会退化成 chip，重新加载历史（重新 `hist`）即可恢复。
  没有自动重试，避免后台无限请求。
- `E_ATT` 只表示“这次取不到”，不区分“已删除/越界/过期”，防止把容器路径结构当探测面。
- 反向检查是插件层模拟，真实容器仍以 QwenPaw 的 `message_convert` 为准；若未来
  QwenPaw 改变 `qwenpaw_original_user_content` 的保存条件，`test_m31` 的前置断言会先失败。
- `media_dir` 只认 console 通道的默认位置与 `CONSOLE_MEDIA_DIR`；若部署改了 console 的
  `media_dir` 配置（非环境变量），需要同步插件。
- G6 未做：单附件、无 `accept`、无多选/批量拖放。
