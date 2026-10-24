# RCS — DSH 插件包

[![dshfind](https://dshfind.com/api/badge/ScreamingMaggot/rcs-context?lang=zh)](https://dshfind.com/zh/plugins/ScreamingMaggot/rcs-context?ref=badge)

**上下文折叠 + 外置推理 + 转录日志 + 外部记忆**，为 DeepSeek Harness (DSH) 的 web profile 设计。

装好后在会话侧边栏找到「注入」和「记忆」tab 使用。

## 功能

| 插件 | 作用 | 默认 |
|---|---|---|
| **CONTEXTinjector** | 工具结果折叠、语义压缩、值保真提取 | 关（按会话启用） |
| **EXTREASON** | 外置推理：只读子代理先核实（可查记忆/转录/文件/网页），主模型后动手 | 开 |
| **LOGcompiler** | 转录日志，完整记录会话事件流 | 开 |
| **memory.mjs** | 外部记忆：SQLite + trigram/2-gram 中文检索 + 索引头 + 会话交接卡 + 查询条件化召回 + 轻 LLM 编译 + 事实生命周期/工作区重置 + 闲时 LLM 整理 + 受控写入 | 关 |

## 安装

**方式一：插件包安装（推荐）**

```bash
dsh plugin --profile web add github:ScreamingMaggot/rcs-context
```

然后在 `<DSH_HOME>/profiles/web/package.json` 的 `dsh.profile.bundles` 中加入 `"rcs-context"`，重启 `dsh web`。

**方式二：脚本直装**

```bash
git clone https://github.com/ScreamingMaggot/rcs-context.git
cd rcs-context
powershell -ExecutionPolicy Bypass -File ./install.ps1
```

安装脚本会备份现网、落位插件、追加补丁层、自校验。重复运行安全。

## 装后配置

1. **重启 dsh web**（客户端插件按名缓存，刷新页面不够）
2. 打开会话 → 「注入」tab → 为本会话选择折叠档位（工具折叠/单压缩/双压缩）
3. **压缩模型**：建议指向本地 Ollama 或廉价模型，避免按主模型价格计费。在「注入」面板或 `control.json` 中配置 `condenseProvider` / `condenseModel`
4. **外部记忆**（可选）：`control.json` 写 `"memoryEnabled": true`，重启后在「记忆」tab 查看

## 压缩模型配置

把压缩通道指向本地 Ollama（以 qwen3:4b 为例）：

```yaml
# ~/.dsh/settings.yaml
llm-pi-ai:
  providers:
    ollama:
      displayName: Ollama (本地)
      api: openai-completions
      baseURL: http://127.0.0.1:11434/v1
      apiKeyEnv: OLLAMA_API_KEY
      compat:
        maxTokensField: max_tokens
      streamIdleTimeoutMs: 30000
      models:
        - id: qwen3:4b-instruct-2507-q4_K_M
          name: Qwen3 4B
          reasoningEfforts:
            off: null
            medium: medium
```

然后在「注入」面板选择该模型，或在 `control.json` 写：
```json
{ "condenseProvider": "ollama", "condenseModel": "qwen3:4b-instruct-2507-q4_K_M" }
```

弱模型压缩率略低、单次 7–15s，但失败时无损回退，不影响档案完整性。

## 外部记忆

订阅 `session/event`，抽取工具结果、用户轮、任务锚点存入 SQLite。

**启用**：`control.json` 写 `"memoryEnabled": true`，重启。

**工具**（前四个只读，后三个受控写入）：
- `memory_catalog` — 查看记录种类/键
- `memory_search` — 按文本/键/种类检索；可传 `uri` 把检索限定在一个 `rcs://` 目录（rootdir/kinddir/record），kind 目录为空时默认扩大到同一 root 一次并回传 `widenedFrom/scopeFallback/attempts`，`fallback=false` 则严格留在目录内；中文双索引：≥3 字先走 trigram 精确子串，自然问句与两字词走 2-gram + bm25（摘要/标题列权重 30×，正文 1×，完整 value 去重后只进正文列）；多词先 AND，唯一命中直接返回，多条命中用 bigram 分数重排；功能 bigram（能用/用来/什么/怎么等）不计入证据，最强候选只命中 1 个词元时不硬凑，查询点名了索引里不存在的 ASCII 标识符（代号/版本/函数名）时返回空；候选在可见性/状态过滤后再截断，结果按“已编译 insight 优先、再相关度、再时间”排序；insight 结果带 L0 `abstract` 与 `layers:{l0,l1,l2}` 元数据，内部 overview/layer_of/layer_ver 不外泄；`scope=session` 查空时按 `project` 重查一次并返回 `widenedScope:true`
- `memory_get` — 取单条记录：`kind+key`、`rowid` 或 `uri`；`layer=auto|l0|l1|l2` 分层读取（l0/l1 只回 `view` + 定位元数据，不带 `value`；`includeRaw=true` 自动升级到 l2 并回解原文）
- `memory_ls` — 以 `rcs://` URI 浏览记忆：默认直达当前工作区，支持 kind 目录分页、tree、字节预算与信任标记；叶子与目录条目带 L0 摘要和 `layers` 元数据，见下节
- `memory_remember` — 仅在用户最后一条原话明确要求“记住/写入记忆”时可用；文本须逐字出自原话（4–500 字），注入型内容拒收、凭据脱敏
- `memory_forget` — 仅在用户明确要求忘记时可用；逻辑弃用（`resolved`），不物理删除
- `memory_correct` — 仅在用户明确更正时可用；新条目带 `supersedes`，旧条目标 `superseded`

每次写入追加 `audit` 记录；没有明确指令一律拒绝，并返回原因。

**URI 寻址（Phase 0）**：每条记录都有确定性的 `rcs://` 地址，把 `(scope, kind, key)` 直接映射为虚拟文件系统路径，模型可以先“看目录”再取正文：

```
rcs://                                   根（ws / sess 两棵树）
rcs://ws/                                可见工作区
rcs://ws/<wsid>/                         记录种类（带 active/total 计数）
rcs://ws/<wsid>/<kind>/                  记录键（目录视图只给一行摘要）
rcs://ws/<wsid>/<kind>/<key>             单条记录
rcs://sess/<sid>/...                     会话私有记录，结构相同
```

`wsid` 是 `<目录名>-<规范化路径 sha1 前 8 位>`（如 `rcs-windows-3f2a1b4c`），由库内 `uri_roots` 表反查（ingest 时维护，旧库首次打开回填），跨库备份后可复现；key 里的 `/` 与 `:` 保持字面量（`file:c:/proj/src/a.mjs` 仍可读），尾斜杠编码为 `%2F` 以保证地址闭合，`?`/`#` 显式转义。路径形态的 ws 根（如 `rcs://ws/d:/p/`）返回 `bad-root`，不会静默漂移成 kind/key。

**默认与导航**：`memory_ls` 默认直达当前工作区根（kind 目录与 active/total 计数），无 cwd 时退到当前会话根，显式 `uri:"rcs://"` 才看两棵树；根/错误回执带 `hint.workspace/session/default`。目录默认只列 `active`，`status=all/resolved` 可看历史。

**分页与预算**：kind 目录返回 `nextCursor/hasMore`（live `command` 239 条分页无重叠）；`limit` 默认 50（上限 200），`maxBytes` 默认 24KB；`tree` 默认 28 个节点，先删叶子摘要再删叶子，目录骨架（全部 kind）永不被预算裁掉，live 为 6.8KB/8 种。

**成本与可见性**：根反查走 `uri_roots` 主键，不再每次扫全库；100k 合成库上 `getByUri` 277ms→0.05ms、`tree` 2.39s→4.7ms，事件循环停摆消失。URI 读取沿用现有可见性（当前工作区 + 当前会话），越界 `not-visible`，不存在 `not-found`。

**浏览元数据与信任边界**：条目带 `rowid/scope/source/confidence/usage/bytes`；叶子与 `memory_get` 一样计 usage、对 `file_state` 做 freshness。所有浏览内容标 `contentTrust:"untrusted"`；预览经 `redactSecrets` 与 quarantine 判据，命中注入时替换为 `[quarantined]`，原值仍可按 URI 显式读取（审计用）。`memory_catalog`/`memory_search`/`memory_get` 的结果与 `catalog.recent` 都回传 `uri`（resolved 记录附 `readableByDefault:false`）。

**分层加载（Phase 1）**：每条 insight 同时保存三层只读投影——`L0 ≤50 字`（发现/目录）、`L1 ≤240 字`（概览）、`L2`（完整 `value` 与证据）。L0/L1 都是从 `summary` 派生的连续子串，按整子句取窗口，绝不切开路径、标识符、≥3 位数字或端口；放不下的长路径宁可不出现，也不输出半截。自动注入（索引头、目录、同会话增量、交接卡）默认只用 L0，700 字预算可容纳约 8 条事实；召回注入在“单条命中 + 预算 ≥306（建议 360）+ 用户问细节或 L0 未覆盖查询”时升到 L1，多条命中一律 L0；L2 只在显式 `memory_get(layer:"l2")` 或 `includeRaw=true` 时读取。`memory_get(layer:"l0"|"l1")` 返回 `view {text,chars,source,fallback,empty}` 与精简 `record`（无 `value`），`memory_ls` 叶子与目录条目带 `layers` 元数据。

存储上 `records` 新增 `abstract/overview/layer_src/layer_of/layer_ver` 五列；旧库打开时自动 `ALTER` 并按 `layer_of=sha1(summary)` 一次性回填，meta `layerBackfill=v1` 保证幂等（第二次 0 更新；改一条 summary 只刷一条）。回填不改 `value`/`source`/FTS，因此回滚只需回代码。人工/模型提供的层（`layer_src=llm`）在 summary 未变时保留，summary 变化后自动覆盖为规则派生。

**目录感知检索（Phase 2）**：`memory_search({uri})` 接受工作区/会话根、kind 目录或 record URI。`rcs://` 与 `rcs://ws/` 只能用于导航，检索会返回 `not-a-search-uri`，调用方先 `memory_ls` 拿到根地址。作用域谓词在 `LIMIT` 之前下推到 FTS/bigram/LIKE，因此目录内不会“先取全局前 N 条再过滤”；跨工作区/跨会话仍是 `not-visible`，不会退化成 0 条。

`kinddir` 为空时默认只扩大到同一 root 的 `rootdir` 一次，回执带 `widenedFrom / scopeFallback / attempts / fallbackUsed / exhausted`；`fallback=false` 时只尝试一次。`rootdir + kind` 等价于虚拟 kinddir，空结果按 `scopeFallback:"kind-filter"` 丢掉 kind、仍留在同一 root。`record` URI 与 `memory_get` 同值，缺失返回 `missing:true` 且不扩大；`kind`/`key` 与 URI 冲突分别返回 `kind-mismatch` / `key-with-uri`。每次 URI 检索带 `trace`（`visited`、`fallback`、`candidates[].mode`，不含正文），供后续检索轨迹使用。注意：工作区 rootdir 只覆盖 `ws:` 事实，对话轮次属于 `sess:`；问“我刚才说”请用会话 URI 或不传 `uri`。`DSH_MEMORY_DIR_SEARCH=0` 可整体关闭。

URI 路径的 LIKE 候选按“事实种类优先、再时间”取窗口（全局路径保持原行为），修复了 10k 同 kind 下旧 insight 被挤出窗口的问题；目录计数（`GROUP BY scope/kind`）走进程内缓存（2s TTL + `PRAGMA data_version` 500ms 检查 + 写代际），写后立即失效。

Phase 0 完成寻址与目录浏览；Phase 2 完成目录内检索。Phase 3–5 的向量基底、检索轨迹与存储优化见下两节。

**语义检索基底（Phase 3，默认关）**：`records` 的派生向量存在普通表 `record_vectors(record_id, model, dim, src_hash, vec BLOB)`，检索用 60 行 JS 余弦，不引入 sqlite-vec/扩展。默认 `off`：没有 embedder 时不发起任何网络请求。启用方式：`DSH_MEMORY_VEC=on|auto` + `DSH_MEMORY_EMBED_MODEL=bge-m3`（或 `meta.vec:model`）；embedding 端点默认 `http://127.0.0.1:11434`，只允许回环地址（远程需显式 `DSH_MEMORY_EMBED_ALLOW_REMOTE=1`），单次预算 300ms。查询向量可用 `store.searchAsync()` 自动计算；`store.search({embedding})` 供外部编排与测试。融合用加权 RRF（k=60、`wLex=1.0`、`wVec=0.8`、insight 先验 1.15），词法 `mode` 不变；`key` 精确查询、唯一 FTS 命中、代号硬拦（`missing-identifier`）、超短查询直接跳过语义臂。语义候选必须 `cos ≥ 0.35`，两臂都无候选时返回空并标 `vec.reason="no-answer"`。任何扩展/模型/维度/超时/坏 BLOB 失败都退回纯词法（`vec.state=off|degraded`），`record_vectors` 缺表或旧库无向量不影响检索。`DSH_MEMORY_VEC=off` 一键回滚；写入队列 `vec_queue` 只在启用时入队，重复 ingest 不重复排队，文本 hash 未变不重嵌。

**检索轨迹（Phase 4，默认开）**：`retrieval_traces` 单表记录每次检索决策（`tool/ls/recall/inject/handover`），包含作用域、阶段耗时/候选数、候选 Top≤40、选中≤20、放宽原因与错误；**不存记忆正文、摘要、prompt 或向量**。查询文本落库前统一脱敏（Bearer/sk-/password/token、URL userinfo、Windows/POSIX 路径、邮箱、长 blob → `[REDACTED]` 或 `<path:#hash8>`），导出再次脱敏并把 sid/workspace/URI key 哈希化。单行硬上限 16KB（候选 40/8KB、选中 20/4KB、步骤 16/4KB），超限置 `truncated` 位并在详情里保留计数。写入走独立连接 + 进程内队列（250ms/32 条 flush，`DSH_MEMORY_TRACE_SYNC=1` 可同步），失败重试 3 次后丢弃，**绝不阻塞工具或注入**；轨迹是直接 SQL，不产生 `events/records/FTS`。默认保留 5000 条 / 30 天（`DSH_MEMORY_TRACE_ROWS/DAYS` 可调）。API：`GET /api/memory/traces?sessionId=…`（游标分页、trigger/since/until 过滤）、`GET /api/memory/traces/:id`、`GET /api/memory/traces/export?format=jsonl|json`、`POST /api/memory/traces/clear`；全部要求本机来源（非本机 403）。关闭：`DSH_MEMORY_TRACE=0` 或 `control.json {"memoryTrace": false}`。

**存储同步优化（Phase 5.0）**：每个连接显式 `synchronous=NORMAL`、`cache_size=-65536`、`busy_timeout=5000`（`SCHEMA` 里的 PRAGMA 只在建库那次生效，重开必须重设）。`ingest` 在没有外层事务时自己包一层（一次事件 = 一次提交，重复事件不写；中途失败整条回滚）。补课 `ingestSession` 每 50 条一个事务，插件钩子用 `ingestSessionAsync` 每 25 条 `setImmediate` 让出事件循环，补课期间到达的事件先缓冲、完成后按序处理。状态轮询把 5 条 `COUNT(*)` 合成一次 `GROUP BY kind,status`，并新增 `records(status,updated_ts)` 与 `(kind,status,updated_ts)` 覆盖索引（`meta.schemaIndexV=1` 幂等建一次）。本地演练：单条 ingest p50 9.3→5.4ms、p95 6.8ms；10k 状态聚合 28.4→1.4ms；200 事件补课 95.6→31.3ms，异步分片最大 tick 间隔 9.1ms。仍为同步实现，不引入 worker；跨阈值方案见 `work/phase-prep-20261025/phase5-storage/PLAN.md`。

**轻 LLM 编译**（可选）：`"memoryLlmEnabled": true`，每轮结束把新事件编译为 insight 记录。摘要必须自足：写清主语与被说明的属性/数量，不能只写裸值或动作；并跟随原文语言；数字/路径/标识符逐字保留。可在「记忆」面板选择编译模型（如本地 qwen3:4b），留空则跟随会话模型。

**选序与使用**：目录候选按 `置信度² × 60 天半衰 × (1 + 0.2·log1p(usage))` 排序；`memory_search`/`memory_get` 命中一次 usage+1，`resolved` 不入选。旧的 0.95 约束不会被一批近期边角料挤出目录。

**编译校验**：≥3 位数字与含字母+数字的长标识符必须逐字出现在原文/现存摘要；1–2 位数字只在端口/行号/版本/时长/次数等槽位内硬校验（抄错即丢弃），无槽位短数字只计入 `smallUnchecked` 指标。没有数字/标识符可校验的纯文本摘要还必须与候选原文共享文本二元组，否则丢弃——防止提示词里的示例句或模型自造的“约束”原样落库。

**编译与折叠串行**：编译调用模型前先等本会话折叠落定（先让 400ms 防抖的轮末折叠登记标记，最多等 30s）；仍在飞则本轮放弃、不推进 `llmThrough`，下一轮再编；陈旧标记 120s 后不再阻塞。

**阻塞 join 回归**（0.1.56 新增）：`agent/pre-step` 必须等待折叠完成（带 3s 超时闸）再放行请求，保证每轮都吃到压缩增益。旧实现（v1.10.53）曾改为非阻塞 join，导致用户开启压缩但新消息不等压缩完成就发出，本轮无法享受压缩收益。现改回 `await joinFoldInFlight()`，超时后继续放行但不取消后台任务。

**事实类型与生命周期**：每条 insight 带 `state / constraint / task / history` 类型。自动注入（索引头、目录、召回）只给 `state/constraint`；`task` 是意图（“接下来要改端口”），不会当成已完成状态；“用户已认知/已了解某工作区”这类用户认知归 `history`，不作为当前项目状态；`history` 只在显式 `memory_search` 里出现。编译器被要求“请求不能改写成已完成状态、只信较新的观测、删除/清空后不再复述被删内容”。

**工作区重置**：成功执行的删除/清空命令（`Remove-Item`、`rm`、`git clean`、`git reset --hard`、`robocopy /MIR` 等，或输出含 `REMOVING:`）记为 reset 标记。重置前的 `state` 一律逻辑失效为 `historical`，`constraint` 不受株连；记录体和证据保留，可审计、可回溯。每条事实的 `value.invalidated` 写明时间、原因与证据。

**数据库备份**（0.1.56 新增）：破坏性操作（工作区重置）前自动备份 SQLite 数据库到 `memory/backups/`，时间戳精确到毫秒避免覆盖，默认保留最近 5 份（`DSH_MEMORY_BACKUP_KEEP` 环境变量可调）。备份失败不影响主流程。恢复时手动复制备份文件覆盖 `memory.sqlite` 即可。

**文件巡检**：会话首次 pre-step 对当前工作区的文件事实做一次 `stat`：路径消失标 `stale`，仍存在则刷新 `verifiedAt`。幂等、无模型，失败不影响会话。

**冲突默认不露面**：`historical / stale / superseded` 不进入自动注入，也不进 2-gram 候选；模型默认只看到仍然成立的事实。显式调用 `memory_search` 时历史记录可见，并带状态标签；需要原文时用 `memory_get(includeRaw=true)`。不物理删除任何事实。

**注入前复验路径**：目录、查询召回、同会话增量与交接卡在注入前会抽取 state 事实里的具体路径并 `stat`（30 秒缓存）；文件/目录已不存在的事实本次不注入（不删库、不改状态）。通配符、`...` 省略路径、未加引号且后面仍跟非标点 token 的空格路径和无法解析的相对路径不做误判（避免把 `C:\Program Files` 截成 `C:\Program` 后误藏事实）。

**LLM 整理**（`memoryLlmEnabled` 开启时）：空闲 15 分钟后自动检查（默认；`control.json` 的 `memoryConsolidateIdleMs` 可调 1 分钟–24 小时，`memoryConsolidateAuto=false` 或 `DSH_MEMORY_CONSOLIDATE=0` 关闭自动）；「记忆」面板也有「立即整理」。模型只输出操作：`mark_stale / supersede / merge / new`，不能删除。整理在写入前做确定性闸门：证据必须来自本轮事件、reset 或文件探针；重置前的旧事件不得用于新增/刷新事实（防 4B 把已删内容“复活”）；`mark_stale` 只用于“没有替代值的失效”：reset 晚于该事实，或探针说路径不存在；有更晚的矛盾必须走 `supersede`，且必须同时给出**同 key 的 `new`** 承载新值（只有墓碑没有新值的 `supersede` 在解析期即被拒）；替换值的证据必须晚于该事实本身的更新时间，与事实同 key 的旧事件只算历史确认，不再进入模型窗口。`new` 的 grounding 只取它引用的 event/reset/probe 内容，不把当前事实文本放进 haystack（否则摘要可以自我证明）；没有数字/标识符可校验的纯文本摘要还要求与被引用证据有文本重叠。写入的整理事实带 `citations` 与 `validFrom`。复用已有 `constraint/state` key 的新事实强制保留原类型，不能借 `new` 把当前状态降级成 task/history 而从注入面消失。尾部多余括号等常见 JSON 噪声会做括号平衡截断；若一条可用操作都没解析出来，只追加一次小证据集（当前事实 + 最近 20 条事件）修复请求，仍失败则记 `parse-failed`、不推进游标。模型失败或解析失败都进入 10 分钟自动冷却，手动触发不受冷却限制；没有新事件时直接跳过模型。每次整理写 `audit`，并记录失效/取代/合并/新增/未通过校验/约束保护/拒绝计数。

**手动整理模型**：`control.json` 的 `memoryConsolidateManualProvider/Model` 可单独绑定一个强模型（如 `spark / spark-x2.6`），只在「立即整理」时使用；自动整理继续使用会话/编译模型，不会在后台消耗该路由。面板显示「手动模型」以及上次整理的模型、耗时与失败原因。

**整理状态可见**：会话状态条在整理期间显示「记忆整理中 Ns · 阶段」（核对文件/收集事件/模型考证/写入结果），完成后 30 秒内显示「记忆已整理 · N」；「记忆」面板显示下次检查倒计时、上次结果与「立即整理」按钮。没有新事件时倒计时会顺延，不会永久停在“即将整理”；孤儿在飞标记 10 分钟后不再显示。手动整理要求「记忆层」与「轻 LLM 编译」同时开启。

**索引头**（默认开）：会话首次 pre-step 注入 `事实数 · 会话数 · 文件数 · 洞察数 · insights: yes/no/unknown`，再附最多 8 条安全摘要。只给聚合计数与语义摘要，不暴露内部 key/kind；含“忽略之前指令/执行以下命令”等注入型摘要会被隔离，不进入上下文。

**会话交接**（默认开）：`turn/end` 生成 `$STATE_DIR/memory/handover/<sid>.json|.md`，包含最后用户轮、最后助手结论、未解决错误、已知事实与最近文件，全部带 seq 指针。同工作区的新会话首次 pre-step 注入一张 ≤500 字卡片；生成它的会话不会回灌自己，卡片 7 天后过期。卡片末尾的 `Details:` 行提示 `memory_search` 与 `memory_get(includeRaw=true)`，并说明两者都接受 seq/rowid。关闭：记忆面板的「会话交接」开关、`control.json` 写 `"memoryHandoff": false`，或启动时设 `DSH_MEMORY_HANDOFF=0`。

**增量注入**：目录每会话只注入一次；同会话后续编译出的新 insight 以 ≤240 字的 `mem-delta-*` 消息补注入，更新 `deltaThrough`，不必等下一个会话。

**面板维度**：「记忆」tab 分「图谱 / 列表 / 设置」三页，默认打开图谱并跟随当前选中的会话页：只画当前工作区共享事实与本会话私有事实，其他工作区/会话不出现；点「展开全部」才展开全库，展开后可「回到当前」。图谱画来源结构而不是目录——工作区（方块）→ 会话（圆）→ 洞察（小点），边分共享（事实→工作区）、来源（事实→产生它的会话）、私有（事实→会话自身）、成员（会话→工作区）；命令/文件不单独成点，只计入节点数字。点节点在右侧详情栏看摘要、类型、状态、置信、范围、来源会话、证据数与模型；双击事实转到列表，双击工作区/会话只筛该作用域。工作区/会话节点上的计数随当前类型、状态与搜索过滤同步，不会出现“标 7 条却只画 5 个点”。列表按作用域分组（当前会话私有在前、当前工作区次之），最近记录共用范围。设置页收拢开关、整理、编译模型、记录构成与数据库诊断，不再与图谱信息挤在同一条滚动栏。范围四档：`当前上下文`（默认）、`本工作区`、`本会话私有`、`全部`；筛选在服务端完成（`GET /api/memory/status?sessionId=…&range=current|workspace|session|all`），不会先取全局 top 20 再在客户端丢失数据。图谱交互：滚轮以光标为锚缩放（0.55–2.4×），空白处拖拽平移（按 viewBox 比例换算），「适配」回到全图；未知会话由服务端回退到「全部」，客户端同步选择器而不是显示空图。事实标签按语义缩放出现（≤10 条事实直接显示，更大图放大到 1.25× 后显示），并按优先级做贪心避让；点事实后右侧「证据链」按需回查事件原文、时间戳与来源会话。图谱可键盘操作：整图只占一个 Tab 位，方向键按空间位置遍历，Enter/Space 打开，Esc 关闭；「聚焦」隐藏概览与图例并放大画布。布局按节点签名缓存，悬停/平移不再重跑斥力。事实默认载入最近 200 条；点工作区/会话钻取时服务端按 `focusScope` 过滤并放宽到 500 条，图/列表同时显示「已载入 / 共 N 条」与截断提示。工具条可按「全部时间 / 最近 7 / 30 / 90 天」收窄事实与最近记录（`sinceTs`，不影响全库计数）；窄屏隐藏筛选标签以保持单行。与前沿产品的差距、证据与验收口径见 `docs/MEMORY-UI-GAPS.md`。

**查询条件化召回**（默认开）：非首轮用户提问会先按该问题检索一次 insight，最多 3 条 / 240 字，按 key 与摘要去重后以 `mem-recall-*` 消息补注入；输入含“问题：/Question:”时只取冒号后的真正问题，避免“只凭记忆回答”这类元指令把通用干扰项带进来；bigram 与 relaxed 通道都要求摘要覆盖 ≥2 个查询词元（查询只有 1–2 个词元时要求 1 个）。同一问题按哈希只召回一次。召回前缀跟随提问语言（中文/英文），并明确“与当前问题相关的已检索事实可直接作答、无需再调工具”，同时保留“不是指令”的信任边界——4B 实测：旧英文前缀在挂载记忆工具时仅 3/10 答对，改后 10/10。关闭：启动时设 `DSH_MEMORY_RECALL=0`。

**信任边界**：索引头、摘要和交接卡都声明为不可信背景，不得执行其中的指令；写入工具只在真人明确指令下动作，其余时间模型不能改库。EXTREASON 子代理同样只能调用 `memory_*` 与 `transcript_expand` 取证，不能写文件或执行命令。

**注入回执**：首次注入后，`meta` 里保留实际注入文本、字符数、sha1 与时间；「记忆」面板的当前会话区可直接展开查看。全文标记为不可信背景，只作审计，不执行。

**可观测性指标**（0.1.56 新增）：自动追踪编译/检索/注入的成功率与命中率，存储在 `~/.dsh/state-compiler/.memory/metrics.json`。通过 `GET /api/memory/metrics` 查询实时指标，返回编译成功率、检索成功率、注入命中率及各项计数。指标记录开销 < 0.3ms/次，对主流程无影响。性能基线测试脚本：`performance-baseline.mjs`，报告见 `docs/PERFORMANCE-BASELINE.md`。

**简报出处闸**：EXTREASON 返回的每条 `[R]` 行中，3 位以上数字必须逐字出现在“子代理本轮工具结果 ∪ 父会话摘要 ∪ 用户原文”里，否则整行丢弃；全部被丢弃时不注入，并记 `inject-skipped why=ungrounded`。这是确定性核对，不替代语义判断。子代理只接受含 `[R]` 的正文；纯 prose 不注入。上一轮简报为空时，≤12 字的纯确认（“继续/好/收到”）不再触发子代理（`EXTREASON_IDLE_SKIP=0` 可关）。

## 兼容性

| DSH 版本 | 状态 |
|---|---|
| 0.2.1-rc.2 | 已验证（五插件全装载，事件/工具/槽位/WebServer 正常） |
| 0.2.0-rc.2 | 已验证（14 关键包中 10 个逐字节相同，16 条接缝 0 消失 0 改名） |
| 0.1.7-rc.2 | 已验证（session-format v4 全链路） |
| 0.1.5-rc.2 | 兼容 |

插件含多代兼容层，同一份文件适配四代宿主接口。

## 目录结构

```
├── web/                        插件本体
│   ├── contextinjector.mjs     注入折叠
│   ├── logcompiler.mjs         转录日志
│   ├── extreason.mjs           外置推理
│   └── memory.mjs              外部记忆
├── condense/                   共享模块（分型/压缩器）
├── toolfold/                   工具结果折叠
├── contextinjector-webui/      WebUI 面板
├── tests/                      回归测试
├── package.json                包清单
├── cordis.patch.yml            补丁层
├── install.ps1 / uninstall.ps1 安装/卸载
└── version.json                版本/构建信息
```

## 卸载

```powershell
.\uninstall.ps1
```

回滚备份、移除补丁项与文件。重启 dsh web 生效。

## 数据位置

- 运行时：`$DSH_HOME/state-compiler/`（control、transcripts、raw、fold-index）
- 安装备份：`$DSH_HOME/.statecompiler-backup-<时间戳>/`

## 许可证

MIT
