# RCS — DSH 插件包

[![dshfind](https://dshfind.com/api/badge/ScreamingMaggot/rcs-context?lang=zh)](https://dshfind.com/zh/plugins/ScreamingMaggot/rcs-context?ref=badge)

**上下文折叠 + 外置推理 + 转录日志 + 外部记忆**，为 DeepSeek Harness (DSH) 的 web profile 设计。

装好后在会话侧边栏找到「注入」和「记忆」tab 使用。

## 功能

| 插件 | 作用 | 默认 |
|---|---|---|
| **CONTEXTinjector** | 工具结果折叠、语义压缩、值保真提取 | 关（按会话启用） |
| **EXTREASON** | 外置推理：只读子代理先核实，主模型后动手 | 开 |
| **LOGcompiler** | 转录日志，完整记录会话事件流 | 开 |
| **memory.mjs** | 外部记忆：SQLite 存储 + 轻 LLM 编译 | 关 |

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

**只读工具**：
- `memory_catalog` — 查看记录种类/键
- `memory_search` — 按文本/键/种类检索
- `memory_get` — 取单条记录（`includeRaw=true` 回解原文）

**轻 LLM 编译**（可选）：`"memoryLlmEnabled": true`，每轮结束把新事件编译为 insight 记录。可在「记忆」面板选择编译模型（如本地 qwen3:4b），留空则跟随会话模型。

**目录注入**（默认开）：会话首次 pre-step 注入 insight 摘要（最多 8 条），模型无需调用工具即可感知记忆内容。

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
