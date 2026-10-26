# 语义维护针对性优化：系统缺陷修复 + 确定性闸门

日期：2026-10-26  
范围：Cycle 2 语义提案层（`web/memory-proposals.mjs`、`web/memory-online-bridge.mjs`）  
方法：沿用 2026-10-26 的 864 次真实调用原始输出做零调用重放，另做 24 条真实消息的新提示词前向验证。

## 1. 归因对应的三个系统缺陷

| 缺陷 | 证据 | 修复 |
|---|---|---|
| 中文全角冒号不是句界 | Qwen 严格内容召回 64.3%，放宽冒号后 100%；48/288 样本属于“严格拒绝、放宽正确” | 句界改为有方向：全角冒号只作左边界；引号/括号左开右闭；引文自带句末标点时视为完整句 |
| 意图判断完全交给模型 | Qwen 对任务/问句的误报率 90%；任务指令保持空仅 12.5%、问句 0% | 模型调用前做确定性意图闸门：任务指令、问句、临时操作、计划、文件转述、注入、助手转述、代码块不进入提案 |
| 谓词 taxonomy 未定义 | “内容对、谓词错”：Qwen 12/168、Spark 33/336；`测试约定` 被判 preference/decision，命名类被判 constraint | 在提示词中给出三谓词定义与优先级；校验期用同一套规则归一，并保留 `modelPredicate/predicateRule` 审计字段 |

另外修复了一个由前向验证暴露的提示词缺陷：JSON 示例里的 `"op":"assert|correct|retract"` 会被 4B 原样抄成 op。示例已改为具体值，并显式禁止复制枚举占位串。

## 2. 864 次原始输出零调用重放

同一份原始输出、同一语料，仅替换生产校验策略；未调用任何模型，未写任何账本。

| 指标 | Qwen3 4B 修改前 | Qwen3 4B 修改后 | Spark X2.6 修改前 | Spark X2.6 修改后 |
|---|---:|---:|---:|---:|
| 负类样本被接受（误报） | 90.0% | **0 / 120 = 0%** | 5.4% | **0 / 240 = 0%** |
| 正类内容召回 | 64.3%（严格）/ 100%（放宽） | **168 / 168 = 100%** | 93.2% / 98.8% | **332 / 336 = 98.8%** |
| 正类谓词命中 | 12 个内容对谓词错 | **168 / 168 = 100%** | 33 个内容对谓词错 | **332 / 336 = 98.8%** |
| 谓词归一触发 | — | 12 次 | — | 33 次 |
| 负类拒绝原因 | — | 任务 72、临时 24、问句 24 | — | 任务 52 |

解读：Qwen 的假阴性已由句界修复消除，误报已由意图闸门消除；谓词错误全部由确定性规则纠正。Spark 的 4 个未命中全部集中在 P4（模型只引用了“不要猜”，没有引用“先提问”），属于模型抽取遗漏，不是闸门丢失。

## 3. 85 例基线重放（Qwen）

| 指标 | 结果 |
|---|---:|
| 标签总数 | 70 |
| 系统级命中（含非规范子跨度） | 64 |
| 负类误报 | **0** |
| 内容对但谓词错 | **0** |
| 残余 FP / FN | 2 / 6 |
| 谓词归一触发 | 3 |

残余 6 个 FN 的构成：2 个是模型把 correction 写成 assert（内容正确、操作错误，形成 2 FP + 2 FN），1 个是模型把 eventKey 拼错（`dec-0_8`），3 个是模型返回空提案。均非闸门或句界造成。

## 4. 新提示词前向验证（24 条真实消息）

闸门先在本地判断，负类不调用模型。

| 模型 | 负类 | 实际模型调用 | 正类内容 | 正类谓词 | 谓词归一 | 单次耗时 |
|---|---:|---:|---:|---:|---:|---:|
| Qwen3 4B | 10 条全部跳过 | 14 | 14 / 14 | 14 / 14 | 9 | 10.5–13.5 s |
| Spark X2.6 | 10 条全部跳过 | 14 | 14 / 14 | 14 / 14 | 1 | 2.5–3.4 s |

Qwen 的 9 次谓词归一说明确定性 taxonomy 不是空转；Spark 仅 1 次，说明强模型在新定义下基本自洽。

## 5. 回归

- 全套 **60/60 套、1971/1971 断言**通过（26.9 s）；其中 2 条为 live 的 require-cwd 闸门（异工作区事件不归档、同工作区正常处理）。
- 提案契约升 **p2**：提示词、闸门与 taxonomy 都属于契约；证据集重放按 schema 查询，旧 p1 候选不会在新策略下被直接回放。p1 语料与基线工件保持冻结（原文件按冻结 diff 逐字节恢复，sha256 仍为 `d3fa86…`），新增 case 完全相同的 `proposal-corpus-p2.json` 供当前 evaluator 使用。
- 新增 `tests/memory-durability.test.mjs`：句界方向性、意图闸门、两套语料正负类、谓词规则、生产校验器接入、提示词/哈希版本、864 次零调用重放、85 例零调用重放。
- 更新 `memory-proposal-eval.test.mjs`：全角冒号后的完整子句现在是 noncanonical span，不再是伪造值；原“从句中间截断”安全用例改用真正的从句中间片段。

## 6. 残余与边界

1. **路由仍全关**。本次只证明候选质量与安全闸门成立，未写任何路由。启用前仍需一份 held-out 真实语料按新策略评分（≥20 个正标签/谓词、精确率 ≥0.95、召回 ≥0.5、零安全失败）。
2. **任务内规则的精度优先取舍**。任务消息里的“未知区域必须拒绝”如果没有显式标签（`业务规则：/项目约定：/约束：`）或未来标记（`以后/今后`），不会入库。这样做换来了 864 次样本的零误报；若后续需要保留这类规则，应先做任务/规则分句器，而不是放宽整条消息。
3. **命名与交互类归为 preference**。这是当前 taxonomy 的定义；“所有测试统一使用 node:test”因带规则标签归 constraint，“文件命名统一用 kebab-case”归 preference。定义已写入提示词与规则模块，避免同一句在不同轮次漂移。
4. **模型仍会犯操作/抽取错误**。85 例中 2 个 correction 被写成 assert、1 个 eventKey 拼写错误、3 个空输出；这些是模型能力问题，闸门只能拒绝，不能补全。
5. **测试实例已归档，live 已接管**。`TESTSPACE2` 与 `TESTworkspace` 已移动到 `Desktop/_ARCHIVE_20261026`，隔离进程已停止；live profile 已安装并运行 Cycle 2。live Cycle 1 memory DB 在用户测试期间由 Cycle 1 自身更新（哈希 `7d39bb12…` → `46543dcf…`），Cycle 2 ledger 使用独立的 `ledger.sqlite`，不写该库。

## 7. Live 部署与归档（2026-10-26）

- live web profile 已安装 `ledger-online.mjs` 与 7 个 Cycle 2 模块，`cordis.patch.yml` 新增 `ledger-online` 入口；备份在 `~/.dsh/.statecompiler-backup-20261026-before-ledger-live/`。
- 启动脚本 `D:\DSH\deepseek-harness\start_dsh_web.cmd` 增加：`LEDGER_ONLINE=1`、`LEDGER_ONLINE_STATE_DIR=%USERPROFILE%\.dsh\state-compiler\ledger-online-live`、`LEDGER_ONLINE_WORKSPACE=C:/Users/Administrator/Desktop/TESTspace3`、`LEDGER_ONLINE_REQUIRE_CWD=1`。
- live 已重启（PID 33936，8080），日志确认 `[LEDGER_ONLINE] armed ... workspaceRoot=C:/Users/Administrator/Desktop/TESTspace3 scope=ws:c:/users/administrator/desktop/testspace3 ... routes=closed (candidates only)`；新状态库表齐全。
- cwd 闸门：会话报告的 cwd 与 `TESTspace3` 不一致时，事件不归档、不提案、不注入；cwd 未报告时保持兼容。
- 人工测试请在 **cwd=C:\Users\Administrator\Desktop\TESTspace3 的主会话**中进行；旧消息不会补课，重启后只处理新消息。耐久规则（如“项目约定：所有测试统一使用 node:test。”）应产生候选，任务/问句应只增加 `qwen.skipped`。只读检查器：
  `node work/semantic-opt-20261026/live-status.mjs`（打印 status、最近 run、候选 quote/谓词/拒绝原因与最近观测）。状态目录 `~/.dsh/state-compiler/ledger-online-live/`。
- 归档：`C:\Users\Administrator\Desktop\TESTworkspace`（14 文件/10.7KB）与 `TESTSPACE2`（124 文件/9.38MB）已移动到 `C:\Users\Administrator\Desktop\_ARCHIVE_20261026\`，含 `ARCHIVE-MANIFEST.txt`；源路径已不存在，内容未删除。

### 7.1 TESTspace3 日志对照

- 首轮同一工作区共 6 个会话、16 条真人消息；3 个主会话被 live 记录为 `cwd-mismatch`，3 个子会话按设计跳过。切换工作区后又新增 4 个会话、4 条真人消息。
- 第一次 live 测试实际结果：**0 条归档、0 个 proposal run、0 次 Qwen 调用**；`cwdMismatches=370`、`injection.skipped=35`。根因是固定的 `D:/RCS/src` 与测试会话 `C:\Users\Administrator\Desktop\TESTspace3` 不一致，属于部署配置问题，不是语义策略失败。
- 当前闸门对 16 条消息的判定：3 条可入库（均为显式 `node:test` 约定），其余问句/任务/计划/无信号消息跳过。
- 日志暴露并修复了一个误报：“简单些好吗不要雷霆大思考”原本因“不要”被判为可入库；新增 `好吗/行吗/可以吗/行不行` 请求标记，归为 question。
- 用日志中的 3 条可入库消息离线回放 Qwen：2 条唯一规则均得到 `project.constraint` 候选，quote 为 `项目约定：所有测试统一使用 node:test` / `项目约定所有测试统一使用 node:test`；模型原判 `project.decision`，被确定性 taxonomy 纠正（`explicit-rule-noun`）。
- 旧会话消息不会自动回填。切换工作区后的实测：4 个新会话的 4 条真人消息已归档（`archived.userMessages=4`、`cwdMismatches=0`），内容为 `hi` / 工作区询问，全部 `no-durable-signal`，`qwenCalls=0`；切换后尚未发送耐久规则，因此还没有候选。
- live 进程在测试后收到 `^C` 停止；Spark `off: none` 配置已保存，下次用快捷方式启动即生效，无需再改。
- 残余：路由仍全关；子会话按设计不归档；live 主模型启动器仍提示 `.env` 无 `DEEPSEEK_API_KEY`，但 `deepseek-account` 模型列表加载正常；语义维护走本地 Ollama Qwen，不依赖该 key。

### 7.2 Spark off-mode CoT（2026-10-26）

- 用 Spark x2.6 直连探测同一提示的四种请求：`reasoning_effort:"none"` → `reasoning_content` 长度 0、12 completion tokens；**省略 reasoning 字段** → `reasoning_content` 461 字并被 `max_tokens` 截断（对照组，说明 Spark 默认思考）；`thinking:{type:"disabled"}` 与 `enable_thinking:false` 也都为 0。
- 根因在 live provider 配置：DSH 的 `reasoningEfforts.off: null` 表示“省略该字段”，这只在“不思考=参数缺省”的 provider 上成立；Spark 缺省时会思考。已把 live Spark 的 `off` 改为 `none`（`cordis.patch.yml`），`dsh --profile web --dump-config` 显示 `'off': none`，并重启 live 生效。
- 语义提案的 Spark 直连调用本来就显式发送 `reasoning_effort:"none"`，因此 `fresh-spark` 与 864 次重放不受影响；本次修的是 live UI 选择“off”时的 provider 映射。
- live 进程在测试后已停止（日志末尾 `^C`）；provider 配置保留，下次启动生效。

## 8. 文件

- 新增：`web/memory-durability.mjs`、`tests/memory-durability.test.mjs`
- 修改：`web/memory-proposals.mjs`、`web/memory-online-bridge.mjs`、`tests/memory-proposals.test.mjs`、`tests/memory-proposal-eval.test.mjs`、`tests/memory-online-bridge.test.mjs`、`work/testspace2-online/README.md`
- 证据：`work/semantic-opt-20261026/{analysis.json,replay-production.json,fresh-qwen.json,fresh-spark.json}`
- 已提交并推送 `c7e801c`（61 files, 77509 insertions）到 `origin/master`；本次文档订正为后续提交。TESTspace3 的原始会话 zstd/重放 JSON 仅本地保留，未随仓库发布。
