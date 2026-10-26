# live 审计：折叠配置与记忆约束（2026-10-26）

本文件不含原始会话正文、密码或临时 key；原文只在本地 session/DB。
测试工作区：`<TESTspace3>`。

## 1. 折叠配置

- `~/.dsh/state-compiler/control.json` 的 `foldAtTurnEnd`：`false → true`，时间 23:27。
- 备份：`control.json.bak-20261026-before-foldunguard-lift`；只改这一个键，其它字段逐值未变；热读，不重启。
- 根因：turn/end 是唯一生产折叠触发点，pre-step 只 join；该开关为 false 时所有 turn-end 在候选检查前返回 `switch-off`。live 日志对 7 个 sid 均有 `turn-end-skip reason=switch-off`。
- 验证（session-62833568，标题“PPT 转防篡改 PDF 可行吗”）：
  - 首折 23:29：`foldRatio 0.2335`、`cumRatio 0.2081`，head 38226B。首折 live 变大是 head 记账，不是压缩失败。
  - 二折 23:33：`41053 → 15300 B`（2.68x），`foldRatio 0.3727`、`cumRatio 0.2346`。
  - 三折当时在飞；UI status `lastFoldPerSession=true`；`last-fold` 已更新。
- 微折：同一时间 `session-d10d1746` 的 1477B 轮走 `below-min-shadow`（<2048），按设计等后续轮累积。
- 残留：`condenseBudgetMs=15000`，实际 24.0–24.4s 命中；首折 2/4、二折 2/3 条 assistant 折叠，1–2 条 fallback；4B 把 90–98B 的小 `[A]` 扩到约 1.6KB。未调预算/模型。

## 2. 记忆约束审计

约束原文（本地，按 sid/seq 引用；此处只写中性描述）：
- `session-3845e5a1` seq 11：以后开新项目先建独立项目文件夹。
- `session-3845e5a1` seq 291：这个约定不必落实到文档；删除两个根目录文件。
- `session-118b990e` seq 68、157：TESTspace3 下项目做最小验收 MVP，尽量略去测试和校验。

### legacy memory（`memory.sqlite`）

| 约束 | insight | fact_type | 注入面 |
|---|---|---|---|
| 独立子文件夹 | `user-intent-create-project-folder` | `task` | 排除 |
| 不落实到文档 | `project-folder-creation-rule` | `constraint` | **已注入** |
| 最小 MVP | `user-intent-mvp-validation` | `task` | 排除 |

- `session-62833568` 的 memory status：`injected=true`、944 字符；catalog 里明确有“先建项目文件夹的约定无需落实到文档中，该规则仍生效…”。
- 同一段 catalog 没有 MVP、没有独立子文件夹。两条在 legacy 记忆里被 4B 编译成 `task`，而注入面只给 `state/constraint`。

### Cycle 2（`ledger.sqlite`）

- 8 runs、6 candidates、2 rejected、**0 accepted/promoted**；当前 facts 只有 `file.exists/mtime/sha256/size`；routes closed。
- `session-118b990e:157` 的 MVP 约束被 Qwen 找到，但 quote 以 ASCII 引号+路径开头，validator 返回 `quote-boundary`。
- `118b:68`、`3845:11`、`3845:291` 均为 route-disabled candidate；谓词分别是 decision/decision/constraint。
- 假阳性 candidate：PPT 首条消息→preference；HTML 抱怨→constraint；游戏讨论→decision。

### 行为层

- 根目录：`disk-analyzer`、`memory-prison`、`yinliang-zhushui-research`、`深蓝铸剑_授权PDF` 四个独立子文件夹；根目录无文件。
- 全仓 grep 未发现把“先建项目文件夹”等通用约束写进文档的文件。
- 规模：disk-analyzer 3 文件/64KB；memory-prison 13/92KB（仅 1 个 smoke_test）；research 8/4.5MB；PDF 12/227MB；无完整测试套件。
- 结论：行为符合；但只有“不落实到文档”有跨会话注入证据。MVP/子文件夹与同会话上下文、既有工作区结构可解释，不能归因记忆独立驱动。

### 质量与安全

- 注入 catalog 含互相矛盾的记忆：工具权限限制被写成“memory_remember 被禁止”，另有“写入项目记忆被推荐”；还有把玩笑编译成偏好。未清理。
- ledger 原始 `user_message` 归档含明文临时 key/密码；trace 已做 `<blob:…>` 脱敏，归档未脱敏。值不在此复述；建议轮换并加 secret 脱敏。
- live gate 仍是 `durable-v1`；源码冻结的是 `durable-v2`。dev 的 90%/69% 不是 live 结果。

## 3. 后续

- 先运行一段时间，不再改 gate/配置；已知问题（fact_type、quote-boundary、legacy/Cycle 2 统一、catalog 矛盾、secret 脱敏）留待恢复改进时处理。
- held-out #2 的 natural 臂排除本轮审计过的会话（见 `GATE-FREEZE.md`）；构造集保持冻结、未跑闸门。
