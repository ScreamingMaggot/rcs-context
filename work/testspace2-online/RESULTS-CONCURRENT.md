# TESTSPACE2 同工作区并发会话测试

日期：2026-10-26  
实例：`<TESTSPACE2>\online-20261026`  
工作区：`<TESTworkspace>`  
项目：`TESTworkspace/commerce-core`  
主模型：Spark X2.6  
处理模型：Qwen3 4B Instruct  
DSH：0.2.1-rc.3，隔离端口 18083。

## 场景

`commerce-core` 是一个多模块小项目：

- `src/money.js`：整数分与 bps 舍入工具；
- `src/pricing.js`：批量折扣；
- `src/tax.js`：区域税率；
- `src/order.js`：组合总价；
- 项目级测试包含各模块和集成用例。

初始实现缺少批量折扣和区域税额，多个测试失败。两个并发会话同时在同一工作区工作：

- 会话 A：只负责 pricing，实现 10 件 5%、20 件 10% 的批量折扣；
- 会话 B：只负责 tax，实现 CN/US/DE 区域税率、错误输入校验；
- 两边都被禁止改对方模块和集成测试；
- 完成后由同一项目级测试套件合并验收。

## 结果：通过

两个会话确实并发执行：

| 会话 | 事件区间（ms） | 工具/读取事件 |
|---|---:|---:|
| pricing | 1792984047616 – 1792984252435 | 17 |
| tax | 1792984048824 – 1792984128087 | 20 |

区间重叠，墙钟总耗时约 **231 秒**。

代码结果：

- pricing 与 tax 均独立完成；
- 合并运行 `node --test --experimental-test-isolation=none`：**27/27 通过**；
- 集成测试同时验证折扣和区域税组合结果；
- 无审批、无权限放宽、无跨模块误改。

共享账本结果：

- 最终 40 条活跃文件事实；
- 两个模块的 `src/pricing.js`、`src/tax.js` 以及各自测试文件均有大小和 SHA-256；
- 3 次 Qwen 提案调用全部成功、0 模型错误；
- Qwen 调用按 workspace 串行，避免并发会话争抢 CPU；
- candidate 3、accepted 0、routes 0；
- 新会话获得了已验证文件事实注入（7 次注入，8 次去重跳过）。

## 语义层仍然失败

Qwen 没有从两个真实开发提示词中提取出任何正确业务约束。3 个 candidate 分别是：

1. 把 pricing 任务说明提成 `project.decision`；
2. 把 tax 任务说明提成 `project.decision`；
3. 把最终跨会话问句提成 `project.preference`。

没有正确 candidate，也没有事实被接受或注入。由于所有路由仍未启用，这些错误候选没有污染主模型。

这说明：

- 并发会话、文件对账、文件哈希和跨会话注入是可靠的；
- 小模型在真实长指令和并发工作流中仍不能承担语义事实提取；
- 开启语义路由前必须继续做模型/提示词/证据边界评测，不能因为文件层通过而放行。

## 证据

- `concurrent-result.json`：并发区间、候选、文件事实、代码测试结果。
- `concurrent-logs/pricing.png`、`concurrent-logs/tax.png`、`concurrent-logs/recall.png`。
- 账本：`<TESTSPACE2>\online-20261026\home\state-compiler\ledger-online\ledger.sqlite`。
- 状态：`status.json`，最终 pending 0、routes 0、Qwen 3/3 成功。

## 回归与边界

- 全套：**59/59 套、1915/1915 断言**。
- 在线桥：46/46。
- live 记忆库 SHA-256 仍为 `7d39bb12…7894a`。
- 没有提交、推送、live profile 修改或 live 读取路径切换。
- 测试实例仍运行在 `127.0.0.1:18083`。
