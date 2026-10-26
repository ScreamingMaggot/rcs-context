# TESTSPACE2 真实实例在线测试结果

日期：2026-10-26  
实例：`<TESTSPACE2>\online-20261026`  
会话工作区：`<TESTworkspace>`  
DSH：0.2.1-rc.3，隔离端口 18083，独立 `DSH_HOME`  
主模型：`spark / spark-x2.6`  
处理模型：`ollama-local / qwen3:4b-instruct-2507-q4_K_M`  
模型摘要：`0edcdef34593eac1aa2be9c7d06c432dcf81945adca5eca2f27662c18f168ba0`

## 结论

最终一轮在线测试通过。真实 Spark 会话产生了文件工具事件，Qwen 提案调用 4/4 成功、0 模型错误；账本记录 4 条真人消息、4 条工具观测、8 条 Observation。只有 1 条已验证文件事实进入注入，所有 LLM 提案均为 candidate/rejected，`ledger_proposal_routes = 0`。

跨会话回答验证了边界：
- 新会话正确回答 `c:/users/administrator/desktop/testworkspace/alpha.txt` 当前存在；
- 未把候选中的端口 18888 注入，因此新会话明确回答端口和环境标识“未知”。

这说明当前实现满足“确定性事实可跨会话，未验收语义候选不可注入”。

## 最终在线会话

1. 第一会话创建 `alpha.txt`（alpha-7），读取确认。
2. 同一会话覆盖为 `alpha-8`，读取确认。
3. 同一会话追加单一长期约束：“在线测试端口固定为 18888”。
4. 新建同工作区会话，不调用工具询问文件与约束。

结果文件：

- `online-result.json`：逐轮完成标记、回答尾部、每阶段 status、候选列表与检查项。
- `logs/turn1.png` … `logs/turn4.png`：四轮完成后的页面截图。
- `<TESTSPACE2>\online-20261026\home\state-compiler\ledger-online\ledger.sqlite`：真实隔离账本。
- `status.json`：最终 pending 0、注入 2、候选 3、拒绝 1、路由 0。
- `<TESTSPACE2>\online-20261026\logs\web.out`：运行 URL 与桥接日志（token 不写入本报告）。

通过的检查：

| 检查 | 结果 |
|---|---|
| 真人消息归档 | 4 条 |
| 文件事实存在 | 1 条 `file.exists` |
| LLM 候选隔离 | accepted=0, candidate=3, rejected=1 |
| 单一约束句抽取 | 通过（精确 quote：`请记住这条长期约束：在线测试端口固定为 18888。`） |
| 注入发生 | 2 个会话、2 次 |
| Qwen 调用 | 4/4 成功，0 错误 |
| pending | 0 |
| 路由 | 0 行 |

## 语义候选质量

在线消息本身包含大量操作指令，Qwen 把其中两条指令/问题误分类为 `project.preference` 候选；另一条首个双约束句因 quote 边界规则被拒绝。专用单句约束被正确抽取为 `project.constraint` 候选。

因此：
- 候选隔离机制有效；
- 在线小模型的候选精确率仍明显不足，不能据此打开路由；
- 这是“模型语义质量”问题，而非账本正确性问题。所有误候选都不会进入当前事实或注入。

## 确定性事实的当前粒度

DSH 的 `write`/`read` 工具结果以文本返回，桥接层没有从文本臆造 size/hash/mtime，因此当前在线账本只有 `file.exists=true`。文件内容已由 Spark 读取确认，但没有进入确定性文件元数据。下一步若要让跨会话记忆包含大小/哈希，应在工具结果后对已跟踪路径执行一次真实文件探针，而不是猜测文本。

## 失败迭代（未计入最终 PASS）

前四次尝试分别暴露并修复：

1. 插件安装后相对导入仍指向源码目录 → 改成安装目录/源码目录双形态解析。
2. 新实例默认会话 cwd 是 `Documents\deepseek-harness\default-workspace` → 将隔离 workspace 存储改为 `TESTworkspace`。
3. DSH 本地 Qwen 的 compaction stream 不结束 → 处理模型改为直接调用已验证的 localhost Ollama `/api/chat`。
4. 提案完成后没有刷新 `status.json` → 任务落定后自动写状态；补单测锁定。
5. UI 测试器把用户 prompt 中的标记误认为助手完成 → 改为同时等待新的 DSH “已完成，用时”节点。

原始失败证据保存在 `<TESTSPACE2>\online-20261026\logs\attempt2…attempt4`，未被覆盖或静默删除。

## 边界与回归

- 回归：`59/59` 套，`1914/1914` 计数断言；`memory-online-bridge` 45/45。
- live 记忆库 SHA-256 仍为 `7d39bb12…7894a`，未写入。
- 没有修改 live profile，没有提交或推送。
- 实例当前监听 `127.0.0.1:18083`；运行 PID 以启动日志和 `Get-NetTCPConnection` 为准。
- 语义路由仍全部关闭；本轮没有为了演示而绕过任何门槛。
