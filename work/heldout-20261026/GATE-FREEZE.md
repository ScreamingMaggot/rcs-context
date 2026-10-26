# held-out #2 闸门冻结

冻结时间：2026-10-26 22:30（本地）
策略版本：`durable-v2`

## 冻结文件（SHA-256）

| 文件 | SHA-256 |
|---|---|
| `web/memory-durability.mjs` | `24fb1b1441cc8054f37b0d7fce03c09ff9ee7ca53893a791446383cd8dfe4e76` |
| `web/memory-proposals.mjs` | `9e39ebc94311772fdd790541f6d9920574463f6dc4573be6bc475ebde5a396ae` |
| `web/memory-observations.mjs` | `7c7e504c56a87a4613a20e5255c79512acac93141fd0e33b557a1d7255747a8d` |
| `web/memory-online-bridge.mjs` | `0201ebf21b12539d4fc1f1a1efd6c34493a5e16d38f72a54d467b75cec10532f` |
| `tests/memory-durability.test.mjs` | `01c07c64b515f1d05ce918d822202b72b632ae6f9cf5a36b2eade444d39c8475` |

冻结时全套：**60/60 套、2069/2069 断言**。

## 构造集

| 文件 | 行 | 正 | 负 | 最小对 | SHA-256 |
|---|---:|---:|---:|---:|---|
| `ref/construct-constraint.jsonl` | 45 | 25 | 20 | 7 | `cb22d6ca081a3d99b1491fa0be3f5c6ad7da094d119e68749a130196b5295c86` |
| `ref/construct-decision.jsonl` | 45 | 25 | 20 | 7 | `419cb1c7d7c4c05e034e561ba516f2d12c83b173ec670a979a536c295cf39825` |
| `ref/construct-preference.jsonl` | 45 | 25 | 20 | 7 | `760b4edbb148de6022844b4e5d56811b4eaefa2fafb06b8ebdce1baa38c7d166` |

- 合计 135 行：75 正 + 60 负；21 组最小对；quote 自检 0 失败；无正负标签矛盾。
- 三条作者线均只读 `RUBRIC-v2.md` 与 `CONSTRUCT-SPEC.md`，未读闸门/提案代码、dev、sample、A/B 标签。
- **构造集尚未跑过闸门**；本轮只做结构审计。

## 冻结规则

1. 从本文件写入起，不再修改 `memory-durability.mjs` / `memory-proposals.mjs` 的判定与引用边界。
2. held-out #2 只跑一次；natural 与 constructed 分开报，不合并成一个准确率。
3. natural 用冻结之后的新会话；与 dev、held-out #1 的会话/工作区不相交；两路盲标，A/B 原始标签保留。
4. 计分直接用生产 `validateProposal`；按谓词报 TP/FP/FN、precision/recall 与 Wilson 95%。gate-only 只报通过率与召回上界，不报 precision。
5. 若必须改闸门：held-out #2 作废，另建 held-out #3；不能在同一份上复跑。

## 待办

- natural 新会话样本 + A/B 标签（冻结后产生）。
- Qwen 提案输出：每个 case 一次，温度 0/固定种子；记录模型 digest。
- `eval2`：natural / constructed / cost（通过率、输入 token）三段；脚本与指标在跑之前冻结。

## Live 状态与排除名单（2026-10-26 补记）

- live 仍是 `durable-v1`、`routes=closed`；本文件冻结的是源码 `durable-v2`。dev 的 90%/69% 不是 live 结果。
- live `control.json.foldAtTurnEnd` 已在 23:27 从 `false` 改为 `true`（备份 `control.json.bak-20261026-before-foldunguard-lift`，热读）。验证与残留见 `LIVE-AUDIT-20261026.md`。
- **natural 臂排除**：本轮用于折叠/记忆审计的会话 `session-62833568-9cd4-48d2-bdf5-709cb1895f97`、`33e1ff76-f53f-4876-81ca-2c09711cb9ac`、`session-d10d1746-df18-424d-bda0-52fd9877d329`、`session-118b990e-3e8e-4011-b435-cf436418e06d`、`2acdb977-6a46-4011-8671-b57efe034e8a`、`e09bc02e-f2d9-44b6-a891-b14214d55820`、`session-3845e5a1-5243-40ac-94f0-2a481082873d`、`b02b1b47-1aa8-4d14-90e1-e2926996e25d` 已被查看/调过，不能再当 natural 样本；natural 只用之后全新的会话。
- 构造集三文件仍冻结、未跑过闸门；排除名单不影响 constructed 臂。
