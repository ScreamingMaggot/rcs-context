# 构造集规格（给第二条盲写线）

目的：为 held-out #2 提供“每谓词正例 + 最小对负例”，解决历史会话正例密度过低的问题。
作者不得读取 `web/`、`tests/`、`dev.jsonl`、`sample.jsonl`、任何 `labels-*.jsonl` 或闸门代码；
只读 `RUBRIC-v2.md`。这是构造集，不是历史样本的改写。

## 输出

写 `work/heldout-20261026/ref/construct-<author>.jsonl`，一行一个 JSON：

```json
{"id":"cc-001","kind":"positive","predicate":"project.constraint","text":"以后所有测试统一使用 node:test。","quote":"所有测试统一使用 node:test","negativeClass":null,"pairId":"p1","rationale":"判据1/2：跨请求且显式持久化"}
```

字段固定：
- `kind`: `positive|negative`
- `predicate`: positive 取三个谓词之一；negative 为 `null`
- `text`: 一条自然中文消息，1–3 句，像用户随手写的
- `quote`: `text` 的连续子串；multiple rules 时每条一个 item，拆成多行（同 id 加后缀）
- `negativeClass`: negative 取 `task|question|plan|transient|report|injection|ack|other`；positive 为 `null`
- `pairId`: 可选；7 组最小对共用同一 `pairId`，一条 positive + 一条 negative
- `rationale`: 一句话说明命中/未命中四条判据中的哪一条

## 数量

- **positive：每谓词 25 条，共 75 条**。这是边界开发量；不要用它宣称 0.95。
- **negative：60 条**，其中每谓词 20 条“近失负例”：与某个正例同形，只改一个维度。
- **最小对：20 组**。每组一条正例 + 一条负例，差异只能落在作用域、持续性、权威、形式之一。
- 若要按谓词认证 0.95：零错误时需要约 73 条/谓词；把 positive 扩到 73/谓词，或改为合并谓词验收。

## 覆盖面（每个谓词都要有）

- 形式：陈述句 / 祈使句 / 问句 / 条件句 / 混合“任务+规则”。
- 作用域：本轮 / 本工作区 / 用户级。
- 持续性：以后/每次/统一/一律 vs 这次/临时/先试。
- 权威：用户直述 vs README 转述 vs 助手复述 vs `SYSTEM:` 注入。
- 指针：金额、测试、依赖、接口、端口、路径、版本、格式、工具链、权限、命名。
- 负例必须包含：裸祈使、动作链、选择题、状态汇报、粘贴日志、文件转述、任务内“必须/不要”、条件性回退。

## 质量约束

1. `text` 必须自然，不能是 rubric 判例的原句复写；不得复制 dev/sample 的消息。
2. `quote` 用 `text.indexOf(quote) >= 0` 自检；不得跨两条独立规则。
3. 带例外/限定的规则（“除…外/但…/只在…时”）quote 必须包含限定；不能只写主句。
4. 同一正例的动作链变体（“把端口改成 8080，然后重新部署”）必须作为 negative 出现在该谓词下。
5. 不得为了凑数写同义重复；相同 `text` 只出现一次。

## 自检与交付

- 行数 = 75 + 60 = 135（扩到 73/谓词时另算）；id 唯一；kind/predicate/negativeClass 合法。
- 报告：每谓词正例数、每类负例数、最小对组数、quote 自检失败数、重复 text 数。
- 作者交付后，用户随机抽 20% 盲审；未通过项直接删除或重写，不静默修补。
- 构造集只用于 held-out #2 的“每谓词”报告；不得与 natural 流量样本合并成一个准确率。
