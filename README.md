# StateCompiler — 直装包（EXTREASON 外置推理 + CONTEXTinjector + LOGcompiler + WebUI 面板）

把 **EXTREASON（reasoning 外置）+ CONTEXTinjector（注入折叠）+ LOGcompiler（转录日志）+
contextinjector-webui（「注入」面板）** 一起直装进 DeepSeek Harness（DSH）的 **web profile**。
装好后在会话侧边找到「注入」tab 使用。

> 本包版本 / 来源提交 / 构建时间见同目录 **`version.json`**；本版改动与保留项见
> **`RCS-0.1.11-改进与保留项.txt`**（同目录）。

> ⚠️ **DSH 版本绑定**：本包基于 `@deepseek-ai/dsh 0.1.1-rc.2` 验证
> （用到 `agent/pre-step`、`surfaceOp replace` 折叠、`ctx.llm` 浓缩、`conversation.view` 客户端注入面）。
> 装到其它 DSH 版本前请先核实；`install.ps1 -DshInstall <dsh安装根>` 可做版本探测（仅警告）。

## 目录
```
├── contextinjector.mjs         注入折叠插件（单文件）
├── logcompiler.mjs             转录日志插件（单文件）
├── extreason.mjs               外置推理插件（EXTREASON，单文件）
├── toolfold.mjs                工具结果折叠（被上面两个 import，须与 condense/ 同级）
├── condense/chunk.mjs,ivr.mjs  共享纯模块（转录分型 / 压缩器 IO 比）
├── contextinjector-webui/      WebUI 面板 npm 包（host /api + client 注入）
├── install.ps1 / install.cmd   直装（web profile）
├── uninstall.ps1               卸载/回滚
├── README.md                   本说明
├── LICENSE.txt                 MIT 开源许可证
├── version.json                产物来源/版本/提交/构建时间
└── RCS-0.1.11-改进与保留项.txt   本版改动、保留项、读数纪律
```

## 一键直装（Windows）
在**已运行/即将运行的 DSH 所在机器**上，双击 `install.cmd`，或：
```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
# 默认装到 %DSH_HOME% 或 ~\.dsh 的 web profile；可显式指定：
.\install.ps1 -DSH_HOME "D:\path\to\.dsh" -DshInstall "D:\path\to\dsh-runtime"
```
脚本会：备份现网 → 落位插件与 WebUI 包 → 幂等追加 `cordis.patch.yml` 四项 insert → 自校验。重复运行安全。

## 装完必做
1. **重启 dsh web**（client 装载器按名缓存，必须重启才生效；刷新页面不够）。
2. 打开一个会话 → **「注入」tab**：
   - **CONTEXTinjector（默认关）**：右栏「当前会话」卡为本会话选「工具折叠 / 单压缩 / 双压缩」即启用折叠；
     - 工具折叠=对每轮对话做工具转录折叠（保留原始信息）
     - 单压缩=对每轮AI输出进行语义压缩
     - 双压缩=单次压缩基础上进行关键值保真提取
   - **LOGcompiler（默认全会话记录）**：日志写到 `$DSH_HOME/state-compiler/transcripts/<sid>.log`；
     在「日志编译」区可改输出目录/停用/逐会话开关。
3. 无本地 Ollama 也能用 single/double（浓缩走 DSH 已注册模型，默认跟随会话模型）。
4. **EXTREASON（外置推理，默认开）**：主模型 `reasoningEffort: off`（或模型无思维链能力）时，
   每轮自动跑一个只读子代理（UI 里显示为「外部思考中」）并把它的 `[R] ` 行注入当轮请求。
   不需要时设环境变量 `EXTREASON=0`。详见 `EXTREASON/README.md`。

## 卸载
```powershell
.\uninstall.ps1                 # 还原安装前备份 / 移除补丁项与文件
```
删干净后再重启 web。

## A档实验：工具结果结构化折叠（0.2.0 起，默认关）
> 实验功能，默认 **OFF**，不影响既有行为。开启后，折叠历史里的工具结果会从 `[T] tool|path|OK`
> 升级为结构化短行 `[T] <域>|<action>|<target>|OK|P0–P3|<k=v>…` 并追加值保真链 `[V]`：
> read 保留 `size/sha8/lines`、edit/write 失败把 err 原文入 [V]、glob/grep 留 `pattern/count/matches≤K`、
> bash 留 `head/tail/tee`、**ask_user 答复 P3 逐字入 [V]**（不可重建）。
> 开启方法：装好后在会话「注入」tab → 右栏「当前会话」卡 → 先为本会话选一个压缩档
> （工具折叠/单压缩/双压缩，让它进入折叠），再打开下方 **「工具结果结构化折叠（实验）」** 开关。
> 纯规则、无 LLM；有 token 成本，仅在你开启的会话生效。若内测发现问题，把现象/转录反馈即可。

## 说明 / 数据位置
- 运行时配置与控制：`$DSH_HOME/state-compiler/`（`control.json`、`logcompiler.control.json`、`last-fold.json`、`transcripts/`、`.ctxinjector/raw/`）。
- 安装备份：`$DSH_HOME/.statecompiler-backup-<时间戳>/`（uninstall 用它回滚）。
- 源码与重建：见 StateCompiler 仓库 `build-dist.ps1`（从 git HEAD 可复现本目录；该脚本自带
  pre/post-flight：校验发布脚本 BOM、校验 `version.json` 版本号、对每个 `.mjs` 跑 `node --check`）。

## 发布前自检（仓库侧，可随时复跑）
```powershell
powershell -ExecutionPolicy Bypass -File StateCompiler\packaging\smoke-install.ps1
```
它在 `%TEMP%` 造一个假 DSH_HOME 真跑一遍 **安装 → 重复安装（幂等）→ 半装升级 → 卸载回滚**，
并核对本目录自洽（清单齐全、`version.json` 可解析且版本一致、`.ps1` 带 BOM、`.mjs` 不带 BOM、
发布说明是合法 UTF-8 中文、装出来的插件与 `dist` 逐字节一致）。全绿才发。

## 运行参数（`control.json`，多数热读、免重启）
| 键 | 缺省 | 作用 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `sessions` / `sessionModes` | `[]` / `{}` | 白名单会话及其压缩档（`off`/`single`/`double`/工具折叠）。**未列出的会话不折叠**（无全局默认档） |
| `keepInject` | **ON** | DSH 注入节点（runtime/policy 快照、skill 目录）永不被遮蔽 ⇒ 快照零补发 |
| `toolfoldStructured` | `true` | 工具结果结构化 `[T]`/`[V]` |
| `condenseProvider` / `condenseModel` | 跟随会话 | 指定浓缩模型（如本地 `ollama`） |
| `condenseMinBytes` | 240 | 单条 `[A]` 低于此字节不送浓缩（0 = 全送，注意小值会让折叠变慢：实测 15 曾导致 243s 一次折叠） |
| `condenseMaxTokens` | 700 | 单条浓缩输出上限 |
| `condenseBudgetMs` / `condenseMaxCallsPerFold` | 15000 / 12 | 一次折叠的硬预算（时间长/调用多即止损回退） |
| `foldJoinTimeoutMs` | 3000 | 下一轮发请求前等待后台折叠的上限；超时就先发请求，绝不拖住对话 |
| `segments` | **OFF** | 多段转录（head 独立成段零重复 + 各段独立留面）。真机已验证，默认关；开启前建议按 NOTES 的样本门槛评估 |
| `standalone` | **OFF** | 遗留开关（新段不带旧前缀）。其目的已被多段转录覆盖，暂不推荐单开 |

## 装好后怎么自查（不看日志也能判）
- **面板**：会话「注入」tab 显示最近一次折叠（模式/触发/字节/压缩比/`monotonic`）、面板「压缩中」在飞标记。
- **端点**：`GET /api/context-inject/status`（含 `lastFold`、`foldInflight`、`control`、`sessions`）。
- **文件**（都在 `$DSH_HOME/state-compiler/`）：
  - `.ctxinjector/fold-index/<sid>.jsonl` —— 每次折叠一行：`cumLines.before/after` 应相邻承接、`after` 等于转录行数；
  - `.ctxinjector/fold-errors/<sid>.jsonl` —— 拒折/异常账本（**空 = 健康**）；出现持续 `foldtext-drift` 表示表面转录与状态脱节、折叠会停摆；
  - `last-fold.json` —— 最近一次折叠详情（含 `full` 转录全文、`segments`、`afterNodes`）。
- **一键体检**（仓库侧，任意机器只读运行）：
  ```powershell
  node StateCompiler\CONTEXTinjector\tools\verify-fold-integrity.mjs --state <DSH_HOME>\state-compiler --all
  ```
  逐会话输出 PASS/WARN/FAIL：索引承接、`full` 段头链、拒折账本；可选 `--replay` 追加"表面段拼接 == full"校验。

## 什么时候开 single / double（实证口径，2026-09-12）

用 12 个真实工作场景 × 4 档（`bare` 基线 / `off` 无损工具折叠 / `single` / `double`）实测的结果：

| 档 | 机制级压缩率（字节加权） | 峰值上下文比（中位） | 峰值 ≥18K 时 |
|---|---|---|---|
| `off`（工具折叠） | **0.227**（压到约 1/4） | **0.931×** | **0.717×** |
| `single` | 0.209 | 1.049× | 0.843× |
| `double` | 0.210 | 0.991× | 0.742× |

- **无损工具折叠（`off`）在任何规模都稳赚**，且不调用任何模型（零 token、零延迟），是默认推荐档。
- **LLM 浓缩（`single`/`double`）只在长会话转正**：峰值 ≥18–20K token 才有净收益（0.72–0.84×）；
  10–25K 的常见中短任务上是 1.0–1.4×，即**净开销**（压缩省下的上下文盖不过调用与延迟）。
  ⇒ 建议：**日常用「工具折叠」；确认会长跑（峰值 ≥20K）的会话再选「单压缩/双压缩」**。
- 压缩收益**主要来自三者共有的无损工具折叠**；`[A]` 段浓缩是增益项而非主力。
- 判据看 `last-fold`：`aCount/aFolded`（命中率）、`fallbackReasons`（回退原因分型：`truncated`/`empty`/
  `noShrink`/`llmErr`/`payloadGate`/`maxCalls`/`budgetMs`/`keysErr`）、`keys`、`shrink`。
  注意 `ms` 会被机器休眠放大，不能当算力时间读。

## 已知取舍（如实说明）
1. **默认行为**：多段转录与 standalone 默认关闭 ⇒ 本包默认行为与 0.1.8 逐字一致。
2. **本地小模型慢**：4B 级浓缩一次 `[A]` 约 7~15s；一次折叠超预算就无损回退（转录照旧完整，只是没压缩）。
   判"有没有压缩"看 `calls`/`aFolded`；`ms` 可为 0，也会被机器休眠放大（实测有 4.7h 的读数）。
3. **无 `[R]` 的两种正常情形**：主模型 reasoning 未关（不做外置推理）；或该 preset 裁剪了工具集
   （此时账本记 `skip-no-readonly-tools`，不再报错）。
4. **装完必须重启 dsh web**：客户端插件按名缓存，刷新页面不够。
5. **本包基于 `@deepseek-ai/dsh 0.1.1-rc.2` 验证**；换 DSH 版本前请先核实。
