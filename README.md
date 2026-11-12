# RCS — 上下文折叠 · 外置推理 · 转录日志 · 外部记忆

[![dshfind](https://dshfind.com/api/badge/ScreamingMaggot/rcs-context?lang=zh)](https://dshfind.com/zh/plugins/ScreamingMaggot/rcs-context?ref=badge)

**给 DeepSeek Harness (DSH) 的插件包。** 长会话里工具输出和模型回复很快把上下文吃满，RCS 把它们压成可随时展开的一行摘要，把会话事实沉淀成带证据的外部记忆。

> 同样的窗口跑更多轮，同样的轮数花更少 token；折叠是**可逆**的——原文永远能展开，证据不丢。

## 它解决什么问题

一个真实的 DSH 长会话里，**工具输出 + 模型回复**往往比用户输入大两个数量级。几百步之后会出现三件事：

1. **窗口被吃满** —— 1M token 的窗口也会被工具日志填到 40% 以上；
2. **宿主原生压缩反复触发** —— 每次都要把整段对话交给主模型重新总结，**贵**，而且**不可逆**：细节一旦被总结就找不回来；
3. **记忆无处安放** —— 上个会话的结论、约束、文件位置，下个会话要从零再说一遍。

RCS 用三件事同时处理它们：**折叠**（省窗口）、**外置推理**（省主模型轮次）、**外部记忆**（跨会话）。四个插件可独立启停，互不依赖。

## 实测：折叠到底省了多少

本机真实会话档案，DSH 0.2.2-rc.1 + `deepseek-v4.1-flash`（1,048,576 token 窗口），折叠档位 = 单压缩，2026-11。

| 会话 | 步数 | 累计工具输出+回复 | 折叠后驻留 | 压缩比 | 上下文占用 中位 / P90 | 峰值 | 原生压缩 |
|---|---|---|---|---|---|---|---|
| `c76c469f` | 1,482 | 24.54 MB | 0.68 MB | **36×** | 15.0% / 18.5% | 59.6% | 22 次 |
| `6ff460cb` | 416 | 8.71 MB | 0.14 MB | **61×** | 15.1% / 18.2% | 39.8% | 9 次 |
| `fde06aba` | 333 | 8.36 MB | 0.03 MB | **263×** | 12.3% / 17.9% | 42.0% | 3 次 |
| `8f473b7d` | 346 | 4.86 MB | 0.08 MB | **63×** | 10.2% / 15.6% | 24.0% | 6 次 |

**合计 12 个有折叠记录的单压缩档会话、2,869 步**：累计 50.18 MB 的工具输出与模型回复，折叠后实际驻留 0.96 MB（**52×**）。按中英混排约 3.5 字节/token 折算，50 MB ≈ 1,500 万 token，是 1M 窗口的 **14.3 倍**——不折叠的话这段内容要反复触发原生压缩；折叠后只占 **0.28 个窗口**。

口径说明：
- **累计工具输出+回复** = 该会话全部 `tool/result` + `assistant/message` + `user/message` 的原始字节，取自已归档的 session 事件流；
- **折叠后驻留** = 插件最后一份 `last-fold` 记录的 `transcriptBytes`，即模型真正携带的折叠版 transcript；
- **上下文占用** = 每个模型步的 `inputTokens + cacheReadTokens` ÷ 1,048,576，取全部步的中位 / P90；**峰值**含原生压缩那次请求（它要读整段对话，所以偏高）。

可自行复算：`node tools/session-econ.mjs --dsh-home "$DSH_HOME" --mode single`（读本机会话档案，不上传任何数据）。

## 四个插件

| 插件 | 作用 | 默认 | 解决的问题 |
|---|---|---|---|
| **CONTEXTinjector** | 工具结果折叠、语义压缩、值保真提取 | 关（按会话启用） | 窗口被工具日志吃满 |
| **EXTREASON** | 只读子代理先核实（记忆/转录/文件/网页），主模型再动手 | 开 | 主模型空转、返工 |
| **LOGcompiler** | 转录日志，完整记录会话事件流 | 开 | 事后复盘与证据回溯 |
| **memory.mjs** | 外部记忆：SQLite + 中文检索 + 分层加载 + 生命周期 + 受控写入 | 关 | 跨会话失忆、重复交代 |

## 适用 / 不适用

**适合**
- 单会话几百步以上的长任务（重构、调研、排障、论文/工程迭代）；
- 工具输出重、日志多的场景（`pwsh`、编译、测试、爬取结果）；
- 需要跨会话延续的项目（约定、约束、文件位置、决策）。

**不太需要**
- 一问一答的短会话（折叠与记忆都有固定开销，收益抵不过）；
- 完全不让模型跑工具的纯对话；
- 对“每一字节原文都必须留在上下文里”的合规场景——折叠虽可展开，但驻留的是摘要。

**安全边界**：记忆写入受控（用户明说或事实有原话支撑才收）；注入内容一律标记为**不可信背景**，模型不得执行其中的指令；记忆文件只在本机 `$DSH_HOME` 下，不联网。

## 快速开始

**方式一：npm 包（推荐）**

已发布到 npm：[`rcs-context`](https://www.npmjs.com/package/rcs-context)。

```bash
dsh plugin --profile web add rcs-context
```

然后在 `<DSH_HOME>/profiles/web/package.json` 的 `dsh.profile.bundles` 里加入 `"rcs-context"`，重启 `dsh web`。

**方式二：GitHub 源安装**（要装尚未发版的提交时用）

```bash
dsh plugin --profile web add github:ScreamingMaggot/rcs-context#<commit>
```

pnpm ≥ 10 首次安装会拒绝运行 git 依赖的 `prepare` 脚本，需要在 profile 的 `pnpm-workspace.yaml` 里写 `allowBuilds` 授权——那等于允许该包代码在本机执行，所以优先用方式一，并尽量带 `#commit` 锁版本。

**方式三：脚本直装**（离线 / 无 pnpm 时）

```bash
git clone https://github.com/ScreamingMaggot/rcs-context.git
cd rcs-context
powershell -ExecutionPolicy Bypass -File ./install.ps1
```

脚本会备份现网、落位插件、追加补丁层并自校验；重复运行安全。

装完 **重启 `dsh web`**（客户端插件按名缓存，刷新页面不够），会话侧边栏会出现「注入」和「记忆」两个 tab。

## 折叠档位与成本

在会话输入框上方的 dock 或「注入」tab 里按会话选档：

| 档位 | 做什么 | 模型调用 | 适用 |
|---|---|---|---|
| **工具折叠**（无损） | 纯规则：`[T]` 工具结果压成一行，`[V]` 抽取值 | 0 次 | 默认，零成本零风险 |
| **单压缩** | 每轮把本轮的回复与工具输出交给轻模型压一遍 | 1 次/轮 | 绝大多数长会话（**推荐**） |
| **双压缩** | 两遍压缩，更短、更慢、更贵 | 2 次/轮 | 极长会话、窗口特别紧 |

压缩模型建议指向**廉价或本地**模型，别用主模型：

```json
// $DSH_HOME/state-compiler/control.json
{ "condenseProvider": "ollama", "condenseModel": "qwen3:4b-instruct-2507-q4_K_M" }
```

本机实测用的就是 `opencode-go / deepseek-v4.1-flash`（快而便宜）。弱模型压缩率略低、单次 7–15 s，**失败一律无损回退**，不影响档案完整性。

> 折叠在 `agent/pre-step` 阻塞 join（3 s 超时闸），保证每轮都吃到压缩收益；超时则放行、后台继续。

## 转录行与回取（`[T]` / `transcript_expand`）

折叠之后，模型看到的工具痕迹是**一行**一条：

```
[T] read | D:/proj/a.mjs | OK | raw=167
[T] memory_correct | - | FAIL(need-explicit-user-intent) | {"ok":false,"error":"need-explicit-user-intent"}
[T] transcript_expand | - | PENDING
```

- **判定列是业务语义，不是传输语义**：回执 `{"ok":false,"error":"x"}` 记 `FAIL(x)`（工具跑通了、业务拒绝了），传输层报错记 `ERR`，其余 `OK`。只看传输层会让"同一件事连错三次"在转录里全印成 OK——真机上就是这样连错三回合的。
- **指针有体积门槛（缺省 1024 B）**：正文够大才挂 `raw=<seq>`；小结果把有界预览（≤160 字）内联在同一行。回取是一次工具往返，为几百字节换一次调用不划算。`control.rawPtrMinBytes` 可热调，`0` 退回"永远挂指针"的旧行为。
- **未落盘 ≠ 失败**：raw 落盘是异步的，行渲染时该 seq 可能还没 flush，回执为 `seq-not-in-raw` 且带 `pending:true`；这类行记中性状态 `PENDING`，稍后重取即可，不该与业务失败同权重。
- **回取**：`transcript_expand(seq)` 从 `raw/<sid>.jsonl` 取回该 seq 的原文（只读、按 session 隔离）。工具注册走 generator 持有器——`ctx.effect(() => dispose())` 会**立即执行**并当成 disposer，等于"注册完立刻注销"，这是"register 不抛错、工具却始终不在模型可见表里"的真正原因。

`[T]` 行契约由 `tests/transcript-row-contract.test.mjs`、`tests/transcript-row-replay.test.mjs`（含"旧版 vs 新版"的同一份存证回放）、`tests/transcript-pending-row.test.mjs`、`tests/tool-registration-visible.test.mjs` 钉住。

## 外部记忆

开启：`control.json` 写 `"memoryEnabled": true`（可再开 `"memoryLlmEnabled": true` 让轻模型把事件编译成事实），重启后看「记忆」tab。

给模型的工具：`memory_catalog` / `memory_search` / `memory_get` / `memory_ls`（只读）、`memory_remember` / `memory_forget` / `memory_correct`（受控写入）。

亮点一句话版：

- **`rcs://` 寻址**：记忆像文件系统一样浏览，先看目录再取正文；
- **L0/L1/L2 分层**：目录只带 ≤50 字摘要，需要细节才升级读取，700 字预算能塞 8 条事实；
- **中文检索**：trigram 精确子串 + 2-gram bm25，自然问句也能命中（真实语料 recall@5 17/24 → 23/24）；
- **事实有生命周期**：`state / constraint / task / history`，冲突不露面，删除后不再复述被删内容；
- **证据链**：每条事实可回查来源会话、seq、原文。

完整机制（检索、分层、生命周期、整理、巡检、向量、轨迹、面板）见 [docs/MEMORY.md](docs/MEMORY.md)。

## 兼容性

| DSH 版本 | 状态 |
|---|---|
| 0.2.2-rc.2 | 🟡 静态差异比对通过（runtime 待验） |
| 0.2.2-rc.1 | ✅ 已验证（live 实例四插件装载、`turn/end` 折叠提交、转录写入、状态接口 200；`install.ps1` 已适配 npm 扁平布局） |
| 0.2.1-rc.5 | 🟡 静态差异比对通过（市场索引构建的钉定版本） |
| 0.2.1-rc.3 | ✅ 已验证（五插件 + ledger-online，隔离实例与 live 实测） |
| 0.2.1-rc.2 | ✅ 已验证 |
| 0.2.0-rc.2 | ✅ 已验证（14 个关键宿主包中 10 个逐字节相同，16 条接缝 0 消失 0 改名） |
| 0.1.7-rc.2 | ✅ 已验证（session-format v4 全链路） |
| 0.1.5-rc.2 | ✅ 兼容 |

`package.json` 的 `engines.dsh` / `peerDependencies` 用显式预发布分支覆盖上述全部版本：

```
>=0.1.5-rc.2 <0.1.6-0 || >=0.1.7-rc.2 <0.2.0-0 || >=0.2.0-rc.2 <0.2.1-0 || >=0.2.1-rc.2 <0.2.2-0 || >=0.2.2-rc.1 <0.3.0-0
```

⚠️ node-semver 只在范围里**某个比较符与该版本 `major.minor.patch` 元组完全一致、且自身带预发布标签**时才放行预发布版本。因此早先的 `>=0.1.5-rc.2` 看似宽松，实际只匹配 `0.1.5-rc.2` 与 `0.2.0`——`0.2.1-rc.5`、`0.2.2-rc.1` 等预发布宿主全被静默排除（插件市场会据此直接丢弃整个条目）。上面这种逐元组列出的写法才是对的。

同一份代码内含多代兼容层（0.2.2 / 0.2.1 / 0.2.0 / 0.1.7 / 0.1.5），无需按宿主版本换分支。

## 目录结构

```
web/                      插件本体（折叠 / 转录 / 外置推理 / 记忆）
condense/                 共享压缩器与分型
toolfold/                 结构化工具折叠（A 档）
contextinjector-webui/    WebUI 面板（注入 / 记忆两 tab）
tests/                    回归测试（76 套 / 2257 断言）
tools/                    辅助脚本（会话经济性复算 session-econ.mjs、成本标定、提示面测量）
docs/                     机制说明、性能基线、面板差距
install.ps1 uninstall.ps1 install.cmd   安装与卸载
cordis.patch.yml          bundle 补丁层
version.json              版本与构建信息
```

## 数据与卸载

- 运行时：`$DSH_HOME/state-compiler/`（`control.json`、`transcripts/`、`.ctxinjector/`）
- 记忆库：`$DSH_HOME/state-compiler/memory/memory.sqlite`（破坏性操作前自动备份，默认留 5 份）
- 安装备份：`$DSH_HOME/.statecompiler-backup-<时间戳>/`

卸载：`powershell -ExecutionPolicy Bypass -File ./uninstall.ps1`，回滚备份并移除补丁项，重启生效。

## 深入

| 文档 | 内容 |
|---|---|
| [docs/MEMORY.md](docs/MEMORY.md) | 记忆层全部机制：检索、URI、分层、生命周期、整理、巡检、向量、轨迹、面板 |
| [docs/PERFORMANCE-BASELINE.md](docs/PERFORMANCE-BASELINE.md) | 内存/折叠/检索性能基线 |
| [docs/MEMORY-UI-GAPS.md](docs/MEMORY-UI-GAPS.md) | 记忆面板与前沿产品的差距与验收口径 |
| [contextinjector-webui/README.md](contextinjector-webui/README.md) | 面板与插件侧的档位/同步约定 |

## 许可证

MIT
