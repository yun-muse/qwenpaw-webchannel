# M33 · 插件分发制品防漂移 — 探查与实施报告

状态：**方案 A（下架）已实施，未提交**。基线 HEAD `015d07f`（M32），QwenPaw
`2.2.2.post1`。工作区改动仅限：删除 `spa/public/webchannel.zip`、更新
`spa/README.md` / `spa/public/_headers` / `spa/public/sw.js` /
`spa/tests/sw.test.ts`、在既有 `.github/workflows/ci.yml` 内新增一个 job、在
`AGENTS.md` 追加一条约定、新增本报告。
`plugin/`、`tools/package_plugin.sh`、plugin-dist 流程与 `dist/` 回滚包约定均未改动。

---

## 0. 结论

**SPA 站的 `/webchannel.zip` 没有任何消费者，按任务书的决策规则选 A：下架。**

- 全仓 44 行 `webchannel.zip` 引用里，只有 **8 行（4 个文件）** 与「SPA 站点托管该
  文件」有关：`spa/README.md`（4）、`spa/public/_headers`（1）、`spa/public/sw.js`（2）、
  `spa/tests/sw.test.ts`（1）。没有 UI 下载入口、没有脚本、没有代码读取它。
- 其余 36 行都不指向 SPA 站：14 行是 `dist/webchannel.zip` / plugin-dist URL
  （本地构建物与正式分发），17 行是历史报告或通用占位，5 行是历史任务书。
- 被跟踪的旧包与现行插件包**零文件相同**：9 个文件全部哈希不同，且缺
  `turso_search.py`；旧包停留在 M8 时代（M9/M12/M13/M15/M24/M27/M28/M31 的功能全部缺失），
  压缩后 45,546 B → 84,143 B，解压后 152,428 B → 293,706 B（+92.7%）。
- 该文件自提交那一刻起就是旧包：添加它的 commit `7fc1511` 里 `channel.py` 是 53,219 B，
  而 ZIP 里是 54,598 B；`plugin.json` 也不同（738 vs 758 B）。此后 3 天没有任何同步机制。

---

## 1. 引用清单与搜索范围

### 1.1 搜索命令（HEAD，仅跟踪文件）

```bash
git grep -n "webchannel\.zip" HEAD -- .          # 44 行 / 22 个文件（46 次出现）
git ls-files -- '*.zip'                          # 只有 spa/public/webchannel.zip
grep -rni "zip" spa/src spa/index.html spa/package.json   # 无命中
git grep -n "pages\.dev" HEAD -- .               # 确认正式分发 URL
```

`git grep` 默认跳过二进制文件，所以被跟踪的 ZIP 本身不会污染结果；它由
`git ls-files` 单独确认。搜索覆盖全部跟踪文本（含 `docs/`、`tasks/`、`.github/`、
`tools/`），未做目录排除。

### 1.2 分类

| 类别 | 文件:行 | 内容 | 处理 |
|---|---|---|---|
| **SPA 托管** | `spa/README.md:53` | 「`/webchannel.zip` — 插件安装包，可作为 install 的 source URL」 | 改为指向 plugin-dist |
| **SPA 托管** | `spa/README.md:61` | 缓存头表把 `/webchannel.zip` 列为 `no-cache` | 删除该行 |
| **SPA 托管** | `spa/README.md:74` | SW「永不拦截」列表含 `/webchannel.zip` | 删除该项并说明站内已无此类文件 |
| **SPA 托管** | `spa/README.md:171` | 源码结构表 `public/webchannel.zip` | 删除该行 |
| **SPA 托管** | `spa/public/_headers:19` | `/webchannel.zip` → `no-cache` | 删除该规则 |
| **SPA 托管** | `spa/public/sw.js:11,132` | 注释称为 distribution archive；fetch 直通 | 删除直通与注释（理由见 §4.3） |
| **SPA 托管** | `spa/tests/sw.test.ts:254` | `/webchannel.zip` 直通用例 | 从 `it.each` 移除 |
| 正式分发 | `README.md:63,82`；`plugin/README.md:21,38-57`；`tools/package_plugin.sh:2,26,127,128`（共 14 行） | 只涉及 `dist/webchannel.zip` / plugin-dist URL | 不动（已是唯一正式渠道） |
| 历史报告 | `docs/m29-report.md:80,156`、`docs/m3-plan.md:173-187`、`docs/m3-prep-report.md:103`、`docs/m5-report.md:112`、`docs/m7-report.md:153,191`、`docs/m7.1-report.md:76`、`docs/m7.2-report.md:74`、`docs/m7.3-report.md:75`、`docs/m31-report.md:499,606`、`docs/turso-report.md:89,95`（共 16 行） | 里程碑记录 | 不动（历史事实，不是现行指引） |
| 任务书 | `tasks/m3-*`、`tasks/m20-*`、`tasks/m24-*`（共 5 行） | 历史任务书 | 不动 |
| 通用占位 | `docs/design.md:351` | `https://<你的静态托管>/webchannel.zip` | **不是 SPA 引用**：占位符泛指任意静态托管，且无域名；不动 |

### 1.3 消费者核查

- **UI**：`spa/src` 里 `zip` 零命中；`download` 只出现在 M31 附件下载与导出
  （`App.tsx:528-533`、`1094-1119`、`lib/export.ts`），与插件包无关。
- **脚本**：`.sh` / `.py` / `.mjs` / `.js` / `.ts` / `.tsx` 里唯一的 `webchannel.zip`
  是 `tools/package_plugin.sh`，它只写 `dist/`，不读 `spa/public/`。
- **构建**：Vite 把 `public/` 原样复制到 `dist/`，旧包因此随每次 SPA 构建被发布；
  没有任何构建步骤生成或校验它。

结论：SPA 站 URL 的唯一「消费者」是描述它存在的文档本身。删除后不存在需要改写的调用方。

---

## 2. 漂移量化

### 2.1 两个归档

| | 被跟踪的旧包 | 现行包 |
|---|---|---|
| 路径 | `spa/public/webchannel.zip`（已删） | `dist/webchannel.zip`（未跟踪） |
| 大小 | **45,546 B** | **84,143 B** |
| SHA-256 | `443e4a4fc3e2b37bb2a7a899e9c2bbe86c3cb0165320248471d01e4e0fae33e0` | `17fb318abd7093d44d07b9bc6a4f9a4805d76db0903e825856a6242f0968ec6a` |
| MD5 | `9b19a23ae02e7e44b067217ed2aaac5a` | `41b683a5e2ba19e40e2dad360bd81ad8` |
| 条目数 | 9 | 10 |
| 解压总计 | 152,428 B | 293,706 B（**+92.7%**） |
| 来源 | commit `7fc1511`（2026-10-27 20:39 +0800） | `bash tools/package_plugin.sh`，逐文件 MD5 与 HEAD 的 `plugin/` 一致 |

现行包的确认方式：按 `tools/package_plugin.sh` 的同一 allowlist / 固定时间戳重建到
`/tmp/m33-current.zip`，得到同样的 84,143 B 与 MD5 `41b683a5…`，与
`dist/webchannel.zip` 一致。

### 2.2 文件清单与哈希（MD5）

| 文件 | 旧包 | 现行包 | 变化 |
|---|---:|---:|---|
| `channel.py` | 54,598 `1a8f3a84a7c4a757d3e5c6182878d9db` | 90,569 `495694fdf57f68f4b0d7cb9e7163a5cd` | **+35,971（+65.9%）** |
| `util.py` | 27,578 `805d356d96b301e05ebf739834034ae0` | 107,545 `5070d125c0fd81f742a1d87cab98cdfc` | **+79,967（+290.0%）** |
| `frames.py` | 10,711 `31e0420a553500545f19b3e6cf15213c` | 24,967 `ab8b3c18b53dba87f977e436ff7177b3` | **+14,256（+133.1%）** |
| `relay_client.py` | 20,806 `df5e2ccfbd3f5102291cd00fe9519a0e` | 23,981 `3ef90b9490a6d89070efb3cfca53ad56` | +3,175（+15.3%） |
| `turso_archive.py` | 12,499 `879a6dcb5d8bd6dee7d6b7804e559a14` | 12,892 `14cff875c98f81269eb55ec9035d3acd` | +393（+3.1%） |
| `filelog.py` | 3,824 `3728b0085af5f92c6fa3f7d2473110c8` | 3,720 `f8127118d910806b8036466852b8b915` | −104（−2.7%） |
| `plugin.py` | 3,344 `5ecd989e3d7d021269967f5c76e4934d` | 3,252 `f0a7385854c0a0ad53c6b0e08ca10de1` | −92（−2.8%） |
| `plugin.json` | 758 `05cebd14eee5f92b5553bcd6a121eb3b` | 738 `719bc34d5a61645cc2efdd031375afa4` | −20（−2.6%） |
| `README.md` | 18,310 `71f6a5c8f7cc327fe29fa34bb65a76ec` | 14,338 `364dbd36e43e176b6a25fbd3ba208516` | −3,972（−21.7%） |
| `turso_search.py` | **不存在** | 11,704 `a22ba960c538758df33f2e0b93448ce1` | 新增 |

**9/9 个同名文件哈希全部不同，0 个相同。** 旧包还缺 `turso_search.py`。

### 2.3 时代判定

- 旧包 `channel.py` 54,598 B 落在 `7fc1511`（53,219 B）与 `86f8b4f`（64,999 B）之间，
  两者都是 2026-10-27；没有任何 commit 的 `channel.py` 正好等于 54,598 B。
- `turso_search.py` 首次出现于 `bbf7f28`（M13，2026-10-28 00:32 UTC）。
- ZIP 内条目时间戳是 2026-10-27 20:02–20:26（+0800），提交时间 20:39。
- 功能探针（在旧包内 grep）：

| 里程碑 | 标记 | 旧包 |
|---|---|---|
| M8 chats / prompts / skills | `get_prompts` | 有 |
| M9 推理档位 | `set_effort` | **无** |
| M12 导出 | `export_begin` | **无** |
| M13 归档搜索 | `search_results` | **无** |
| M15 每轮回执 | `last_turn` | **无** |
| M24 用量看板 | `get_stats` | **无** |
| M27 effort 404 | `E_EFFORT` | **无** |
| M28 缓存 token 统计 | `cache_observed` | **无** |
| M31 附件回取 | `att_get` | **无** |

即旧包停在 **M8**，比现行插件少了 8 个里程碑（M9/M12/M13/M15/M24/M27/M28/M31）的能力；从提交起就是旧包（同 commit
的 `channel.py` 53,219 B ≠ ZIP 内 54,598 B，`plugin.json` 738 B ≠ 758 B）。

---

## 3. A / B 方案对比与推荐

### 方案 A — 下架

**利**

- 直接消灭漂移源：仓库里不再有第二份插件二进制，plugin-dist 成为唯一分发点。
- 无新增构建/CI 复杂度；只需一次删除 + 文档更正 + 一条守卫。
- 符合事实：没有任何 UI、脚本或代码从 SPA 站下载它；已验证的安装 runbook
  （`plugin/README.md`）从头到尾只用 `dist/` → plugin-dist。
- SPA 构建产物少 45 KB，且不再出现「装到 3 天前旧包」的隐性故障。

**弊**

- SPA 站 `/webchannel.zip` 变成 404；若有仓库外的人保存过这个 URL，会失效。
- 需要对 `spa/tests/sw.test.ts` 做一处删减（本报告 §5 报数）。

### 方案 B — 同步化

**利**

- SPA 站仍提供一个可安装 URL，理论上方便「只记得站点地址」的人。

**弊**

- 需要新增构建步骤：从 `plugin/` 生成 ZIP 到 `spa/public/`（且 gitignore），或进 git
  但加 CI 漂移断言；两条都要维护第二份构建逻辑与 `public/` 的清理顺序。
- SPA 每次部署都会携带一份 ~84 KB 的插件包，与 plugin-dist 重复；两个 URL 的
  更新节奏、缓存头、回滚语义都要各自解释，等于**重新制造**一个事实上的第二分发渠道。
- 任务书明确指出 hosted 容器的 URL 安装历史上被代理 426 挡住，正式路线是
  「下载到容器 → 本地目录安装」；SPA 站这份副本没有提供任何 plugin-dist 没有的能力。

### 决策

**选 A。** 决策规则是「零引用且 plugin-dist 已是唯一正式渠道」——两条都成立。
B 的唯一收益是保留一个无人使用的 URL，却要永久维护第二条分发链；不划算。

保留的说明：已安装在容器里的插件不受影响；受影响的只有「未来从 SPA 站 URL 安装」
这一条从未被 runbook 采用过的路径。SPA 下一次部署后线上旧文件消失（Pages 的旧
deployment 仍可回滚访问，属于托管侧历史，不在仓库控制范围内）。

---

## 4. 实施内容

### 4.1 删除制品

```bash
git rm spa/public/webchannel.zip   # 45,546 B，已暂存删除，未提交
```

### 4.2 文档与站点配置

- `spa/README.md`：`public/` 清单不再声称提供 ZIP；新增一段说明插件包由
  `tools/package_plugin.sh` 构建、发布在 `qwenpaw-plugin-dist`，并链接
  `plugin/README.md`；缓存头表、SW 直通列表、源码结构表同步删掉 `/webchannel.zip`。
- `spa/public/_headers`：删除 `/webchannel.zip` 的 `no-cache` 规则（文件已不存在，
  留着会误导下一次维护）。
- 根 `README.md` 与 `plugin/README.md` 无需改动：它们本来就只写
  `dist/webchannel.zip` / plugin-dist URL，是本次要收敛到的目标状态。

### 4.3 Service Worker：删除直通而不是保留

`spa/public/sw.js` 的 `/webchannel.zip` 直通被**删除**，理由：

1. 该路径在跟踪构建里已经不可能存在，守卫（§4.4）会拦住任何重新提交的 ZIP；
   为不存在的路径保留特例，等于在代码里继续暗示「本站分发插件」。
2. 即使将来真的在站点根放一个无哈希下载物，`networkFirst` 只在 `response.ok` 时
   写缓存，404 会原样透传；而缓存名是 build 作用域的，下一次部署必然换桶清空。
   也就是说，删除直通不会引入「旧包被 SW 缓存住」的风险。
3. 若将来确实要恢复站内分发，正确做法是连同该特例一起加回来，并在同一提交里
   更新本报告与测试——而不是留一个无人验证的死分支。

`sw.test.ts` 的 `it.each` 相应从 3 个路径减到 2 个（`/version.json`、`/sw.js`）。

### 4.4 CI 守卫（只加 job，不动触发与 paths-filter）

在既有 `.github/workflows/ci.yml` 中新增独立 job `artifacts`（无 `needs`、无 `if`，
每次工作流触发都跑）：

```yaml
  artifacts:
    name: artifact hygiene (no tracked ZIPs)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - name: Fail on tracked ZIP artifacts
        run: |
          tracked=$(git ls-files -- '*.zip')
          if [ -n "$tracked" ]; then
            echo "::error::ZIP artifacts are build output and must not be tracked:"
            printf '%s\n' "$tracked"
            exit 1
          fi
          echo "ok: no tracked ZIP artifacts"
```

- 覆盖范围：任何被跟踪的 `.zip`，因此 `spa/public/` 与所有源码区都被覆盖（比只查
  `spa/public/` 更强）。
- `dist/` 在 `.gitignore` 第 2 行，`git ls-files` 永远不会列出它，本地
  `webchannel.zip` / `webchannel-prev-*.zip` 回滚包流程不受影响。
- 触发路径与 `paths-filter` 规则一行未改。已知边界：工作流本身只在
  `plugin/**`、`spa/**`、`relay-cf/**`、`relay-node/**`、`tests/**`、`tools/**`、`protocol/**` 与
  workflow 文件变化时触发（任务书禁止改触发规则）；本次风险点 `spa/public/` 属于
  `spa/**`，必定触发。若未来在 `mock/` 或仓库根提交 ZIP，不会触发 CI——这不在
  本任务的制品路径内，记录在此以免误以为覆盖全仓。

---

## 5. 验证

| 检查 | 命令 | 结果 |
|---|---|---|
| SPA 单测（改前基线） | `cd spa && npm test` | 15 文件 / **207** 通过 |
| SPA 单测（改后） | `cd spa && npm test` | 15 文件 / **206** 通过（`sw.test.ts` 13 → 12，唯一减少的是被删的 `/webchannel.zip` 用例） |
| SPA 构建 | `cd spa && npm run build` | 通过；`tsc --noEmit` 无错误；`dist/` 内**不再有** `webchannel.zip`，`dist/sw.js` 无该路径 |
| 插件套件（无改动，回归确认） | `plugin/tests/test_*.py`（venv python） | **20/20** 打印 `ALL PASS` |
| 守卫通过分支 | 当前仓库 `git ls-files -- '*.zip'` | 空 → `ok: no tracked ZIP artifacts` |
| 守卫失败分支 | 临时 git 仓库提交 `spa/public/webchannel.zip` | 输出 `::error::` 并列出文件，按脚本逻辑 exit 1 |
| YAML 语法 | `python3 -c "import yaml; yaml.safe_load(...)"` | `yaml ok` |

未跑 `tests/e2e_m19.mjs`：本次不涉及协议、UI 或 relay 行为，SW 改动只减少一个
不存在的路径分支，且 `sw.test.ts` 已在 VM 中执行真实 worker 覆盖直通列表。
