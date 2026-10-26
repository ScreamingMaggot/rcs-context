# TESTSPACE2 真实开发场景在线测试

日期：2026-10-26  
实例：`<TESTSPACE2>\online-20261026`  
工作区：`<TESTworkspace>`  
项目：`TESTworkspace/inventory-service`  
主模型：`spark / spark-x2.6`  
处理模型：`ollama-local / qwen3:4b-instruct-2507-q4_K_M`  
DSH：0.2.1-rc.3，隔离端口 18083。

## 测试问题

初始仓库是一个真实可运行的小型定价模块：

- 7 个 `node:test` 用例；
- 初始 6 个失败，覆盖整数分、基点折扣、四舍五入、折扣/优惠券顺序、非负下限；
- 第一轮要求 Spark 读取 README、实现和测试，定位并修复；
- 第二轮在同一会话增加优惠券 50% 上限，要求修改实现并补测试；
- 新会话不调用工具，检验账本中可用的跨会话事实。

会话中自然给出了多项业务规则，用于观察 Qwen 能否抽取：

- 金额一律整数分；
- 折扣用基点，10000=100%；
- 四舍五入到分；
- 先折扣后优惠券；
- 总价不为负；
- 无第三方依赖、保持 node:test；
- 优惠券最多抵扣折扣后金额的 50%。

## 开发任务结果：通过

Spark 真实完成了修复与扩展：

- 原 7 个测试从 6 失败变为 7/7 通过；
- 新增 4 个优惠券测试：正好 50%、超过 50% 封顶、按折扣后金额计算上限、100% 折扣时优惠券为 0；
- 最终 `node --test`：**11/11 通过**；
- 修改仅涉及 `src/pricing.js` 和 `tests/pricing.test.js`；
- 会话中途发生一次上下文压缩（约 11.5K tokens），Spark 恢复后继续完成第二轮；
- DSH 沙箱不允许 `node --test` 的命名管道子进程，Spark 自行改用
  `node --test --experimental-test-isolation=none` 完成验证，未使用危险权限。

最终代码：

- `lineTotalCents` 使用 `quantity`；
- 折扣按 bps/10000 并用整数 half-up 舍入；
- 先扣折扣、再扣优惠券；
- 优惠券上限为折扣后金额的 50%；
- 总价非负。

## 跨会话文件事实：通过

第一次运行发现并修复了桥接 bug：探针使用了工具事件的旧时间戳，被同一次写入的“内容失效”覆盖，导致被修改文件只剩 `exists`。

修复为“探针使用实际探测时刻”后，新增只读会话读取四个文件，再新建会话要求仅凭记忆回答大小和 SHA-256。结果四项全部精确匹配：

| 文件 | 大小 | SHA-256 |
|---|---:|---|
| README.md | 103 | `bb8720f8…` |
| package.json | 141 | `6ab839b4…` |
| src/pricing.js | 1813 | `38cba84a…` |
| tests/pricing.test.js | 2188 | `a46bdb4d…` |

证据：

- `probe-result.json`
- `<TESTSPACE2>\online-20261026\home\state-compiler\ledger-online\ledger.sqlite`

## 语义候选：明确不达标

真实多约束提示词下，Qwen 3 次运行均完成、0 模型错误，但提案质量不合格：

- 第一条完整约束被 `quote-boundary` 拒绝；
- 第二轮的 50% 优惠券约束也被 `quote-boundary` 拒绝；
- 新会话中的问句反而被提议为 `project.constraint` candidate；
- 没有任何正确 candidate，没有被接受或注入。

两条真实约束都从中文全角冒号 `：` 后开始引用；当前边界规则不把 `：` 当作安全分句边界，这是已记录的召回限制。为了不重新引入“截取否定片段”的风险，本轮没有为了演示而放宽边界。

主开发场景结束时账本：真人消息 3、工具观测 24、活跃文件事实 10；proposal runs 3/3 成功，candidate 1、rejected 2、accepted 0。

随后执行“四文件读取 + 新会话复述哈希”探针复核，再增加 2 条真人消息和 2 次 proposal run。最终账本：

- 真人消息 5；
- 工具观测 32；
- 活跃文件事实 16（4 个文件 × exists/size/sha256/mtime）；
- proposal runs 5/5 成功；
- candidate 3、rejected 2、accepted 0；
- `ledger_proposal_routes = 0`。

跨会话回答正确：四个文件的大小与哈希全部已知；金额/折扣/优惠券规则全部回答“未知”，因为语义候选未通过门禁且未注入。

## 结论

这轮比玩具文件测试更接近真实开发：

1. **确定性账本有效**：真实代码修改、跨会话文件大小/哈希可验证；
2. **候选隔离有效**：错误 Qwen 提议没有污染主模型；
3. **小模型语义维护仍不可用**：真实约束未被正确抽取，中文冒号和长多约束文本是当前明确短板；
4. **不能打开路由**：应继续 held-out 评测并改进模型/查询边界，而不是用单个成功案例放行。

## 证据与回归

- `realistic-result.json`：开发任务、逐轮完成、proposal、facts、代码测试结果。
- `realistic-logs/work-a.png` … `work-c.png`：完成后的真实 UI 截图。
- `probe-result.json`：四文件跨会话大小/哈希复述验证。
- 全套回归：**59/59 套、1915/1915 断言**（在线桥 46/46）。
- live 记忆库 SHA-256 仍为 `7d39bb12…7894a`，未写入。
- 无 live profile 修改，无提交/推送。
