# contextinjector-webui — 「注入」面板（仓库权威副本）

> 与 `../contextinjector.mjs`（折叠插件，Host 单文件）配对。本目录是 **npm 包形态** 的 WebUI 面板
> （conversation.view「注入」tab + 自注册 `/api/context-inject/{status,config}`）。

## 结构
```
webui/
├── package.json        # main=host(lib/index.mjs)；exports["./client"] + dsh.client{platform:'web'}
├── lib/index.mjs       # Host 半：ctx.webServer.register exact /api/context-inject/{status,config,session}
│                       #   读 state-compiler/{control,runtime,last-fold}.json；本机 origin 校验写
└── lib/client.js       # Client 半：lazy-CJS（__ModuleLoader__），两处注入
                        #   ① conversation.view「注入」tab：启用开关 + workspace 分组白名单(标题/归档过滤)
                        #      + 全局默认压缩档 + 折叠时间线(ErrorBoundary)
                        #   ② conversation.input.dock（v1.7）：composer 上方「本会话压缩模式」四态选择器
                        #      —— 空白会话(hero)同样渲染，首轮发送前即可定档
```

## 装载（正式区）
1. 把本目录内容同步到 `$DSH_HOME/profiles/node_modules/contextinjector-webui/`（目录须在 node_modules，
   包名 include 才被 client 收集——路径型 insert 不收集 client half）；
2. web profile 的 `cordis.patch.yml` insert：`name: 'contextinjector-webui'`（包名，非路径）。
折叠插件本尊：`contextinjector.mjs`（路径型 insert，Host 单文件）。

## 端点与数据
- `GET  /api/context-inject/status` → control/runtime/lastFold/会话索引（title 来自 projcache，同左侧栏）
- `POST /api/context-inject/config` → `{enabled, sessions[], condense}`（白名单=session id 数组；condense=**全局默认档**）
- `POST /api/context-inject/session`（v1.7）→ `{sessionId, mode}`，mode=`off|single|double|none`
  → 一次动作 = 启用 + 该会话入白名单 + 写 `sessionModes[<sid>]`（none=移出白名单）。
  原子读改写（展开 cur 保留未知字段，防 keepInject 被剥）；会话 id 前缀归一，键形式沿用既有记录。
- 状态目录：`$DSH_HOME/state-compiler/`（CONTEXTinjector 插件写入；webui 只读+改 control）
- 档位优先级（插件侧，v1.9）：env `DSH_CONTEXTINJECTOR_LOSSY` > `sessionModes[本会话]`
  > （test/env 直通: off 兜底 | control 门控无档: **不折叠**）。**全局默认档已移除**——
  顶部「注入」tab 无「AI 输出压缩档」chips；composer dock 是唯一选档入口，tab 勾选会话即写无损 off（取消= none）。

## 同步约定
- **本目录 = 源**；正式 `D:\JDC\AGENT\.dsh\...` 中的是装载副本；
- 改 host 端点（index.mjs）或面板（client.js）后：同步副本 + **重启 web**（client bundle sha1 rev 变化；
  装载器元数据按名缓存，重启前不失效）；
- 回滚：删 cordis.patch 中 insert 与 node_modules 包目录即可。

## 历史残留说明
早期误置的 `profiles/web/contextinjector-webui/`（harness 版实验目录）已不被引用，若在可手动删除。
