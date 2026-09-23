# =============================================================================
# StateCompiler 直装安装器（EXTREASON 外置推理 + CONTEXTinjector + LOGcompiler + WebUI 面板）
# 目标：把 EXTREASON 外置推理插件（extreason.mjs）、CONTEXTinjector 注入插件、LOGcompiler 转录插件、
#       与 contextinjector-webui 面板一并直装进任意 DSH_HOME 的 web profile（web 是唯一支持目标）。
#
# 用法：
#   .\install.ps1 [-DSH_HOME <dir>] [-DshInstall <dsh安装根>] [-Force]
#   -DSH_HOME    目标 DSH 配置家目录（缺省 %DSH_HOME% 或 ~/.dsh）
#   -DshInstall  可选：DSH 运行时安装根，用于探测 @deepseek-ai/dsh 版本（不符给黄字警告，不阻断）
#   -Force       覆盖已存在的同名备份
#
# 幂等：重复运行不重复插 insert、不重复复制（有变化才覆盖，先备份）。
# 回滚：见同目录 uninstall.ps1。
# =============================================================================
param(
  [string]$DSH_HOME = $env:DSH_HOME,
  [string]$DshInstall = '',
  [switch]$Force
)
$ErrorActionPreference = 'Stop'

# ---- 源（本发布目录自身）----------------------------------------------------
$src = $PSScriptRoot
$pluginCtx = Join-Path $src 'contextinjector.mjs'
$pluginLg  = Join-Path $src 'logcompiler.mjs'
# EXTREASON 外置推理插件（发布包顶层 extreason.mjs → 落位 profiles/web/extreason.mjs）
$pluginEx  = Join-Path $src 'extreason.mjs'
$pluginCond= Join-Path $src 'condense\chunk.mjs'
$pluginIvr = Join-Path $src 'condense\ivr.mjs'
$webuiDir  = Join-Path $src 'contextinjector-webui'

# ---- 目标 -------------------------------------------------------------------
if ([string]::IsNullOrWhiteSpace($DSH_HOME)) {
  $DSH_HOME = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.dsh'
}
$DSH_HOME = [IO.Path]::GetFullPath($DSH_HOME)
$prof = 'web'
$profDir = Join-Path $DSH_HOME (Join-Path 'profiles' $prof)
$patch   = Join-Path $profDir 'cordis.patch.yml'
$nmPkg   = Join-Path $DSH_HOME 'profiles\node_modules\contextinjector-webui'

function Col($c,$m){ Write-Host $m -ForegroundColor $c }
function U8($p){ return [IO.File]::ReadAllText($p, [Text.Encoding]::UTF8) }
function U8W($p,$s){ [IO.File]::WriteAllText($p, $s, (New-Object Text.UTF8Encoding($false))) }

# ---- 源完整校验 -------------------------------------------------------------
foreach ($f in @($pluginCtx,$pluginLg,$pluginEx,$pluginCond,$pluginIvr)) {
  if (-not (Test-Path -LiteralPath $f)) { Col Red "缺少发布文件: $f"; exit 1 }
}
if (-not (Test-Path -LiteralPath (Join-Path $webuiDir 'package.json'))) { Col Red "缺少 webui 包: $webuiDir"; exit 1 }

# ---- 目标目录校验 -----------------------------------------------------------
if (-not (Test-Path -LiteralPath $DSH_HOME)) { Col Red "DSH_HOME 不存在: $DSH_HOME"; exit 1 }
if (-not (Test-Path -LiteralPath $profDir)) {
  Col Red "web profile 目录不存在: $profDir`n请确认这是 DSH 的 DSH_HOME（应含 profiles\$prof\）。需要先初始化该 profile。"; exit 1
}

# ---- DSH 版本探测（可选，警告不阻断）-----------------------------------------
$probeNote = ''
if (-not [string]::IsNullOrWhiteSpace($DshInstall)) {
  $pkg = Join-Path $DshInstall 'node_modules\@deepseek-ai\dsh\package.json'
  if (Test-Path -LiteralPath $pkg) {
    try {
      $v = (Get-Content -LiteralPath $pkg -Raw | ConvertFrom-Json).version
      if ($v -ne '0.1.1-rc.2') {
        Col Yellow ("警告：DSH 版本 {0}，本插件基于 0.1.1-rc.2 验证（agent/pre-step、surfaceOp replace、ctx.llm、client 注入面）。若遇异常请先核对该版本。" -f $v)
      } else { Col Green "DSH 版本 ${v} 匹配验证基线。" }
    } catch { Col Yellow '无法读取 dsh package.json 做版本探测，跳过（请自行核对外部，本安装仍继续）。' }
  } else { Col Yellow '未在指定 DshInstall 找到 @deepseek-ai/dsh，跳过版本探测。' }
} else {
  Col Yellow '未提供 -DshInstall，跳过 DSH 版本探测。本插件基于 @deepseek-ai/dsh 0.1.1-rc.2 验证，装到其它版本前请先核实。'
}

# ---- 备份（到 <DSH_HOME>/.statecompiler-backup-<stamp>）-----------------------
$stamp = Get-Date -Format 'yyyyMMddHHmmssfff'
$bk = Join-Path $DSH_HOME ('.statecompiler-backup-' + $stamp)
New-Item -ItemType Directory -Path $bk -Force | Out-Null
$hadAny = $false
if (Test-Path -LiteralPath (Join-Path $profDir 'contextinjector.mjs')) { Copy-Item -LiteralPath (Join-Path $profDir 'contextinjector.mjs') -Destination (Join-Path $bk 'contextinjector.mjs') -Force; $hadAny = $true }
if (Test-Path -LiteralPath (Join-Path $profDir 'logcompiler.mjs'))    { Copy-Item -LiteralPath (Join-Path $profDir 'logcompiler.mjs')    -Destination (Join-Path $bk 'logcompiler.mjs') -Force; $hadAny = $true }
if (Test-Path -LiteralPath (Join-Path $profDir 'extreason.mjs'))      { Copy-Item -LiteralPath (Join-Path $profDir 'extreason.mjs')      -Destination (Join-Path $bk 'extreason.mjs') -Force; $hadAny = $true }
if (Test-Path -LiteralPath $patch)                                     { Copy-Item -LiteralPath $patch -Destination (Join-Path $bk 'cordis.patch.yml') -Force; $hadAny = $true }
$tfFile = Join-Path $DSH_HOME 'profiles\toolfold\toolfold.mjs'
if (Test-Path -LiteralPath $tfFile) { Copy-Item -LiteralPath $tfFile -Destination (Join-Path $bk 'toolfold.mjs') -Force; $hadAny = $true }
# v2 §13 condense 共享纯模块（profiles/condense/chunk.mjs；logcompiler import ../condense/chunk.mjs）
$condFile = Join-Path $DSH_HOME 'profiles\condense\chunk.mjs'
if (Test-Path -LiteralPath $condFile) { Copy-Item -LiteralPath $condFile -Destination (Join-Path $bk 'condense-chunk.mjs') -Force; $hadAny = $true }
# #5 IVR 簿记模块（contextinjector import ../condense/ivr.mjs）
$ivrFile = Join-Path $DSH_HOME 'profiles\condense\ivr.mjs'
if (Test-Path -LiteralPath $ivrFile) { Copy-Item -LiteralPath $ivrFile -Destination (Join-Path $bk 'condense-ivr.mjs') -Force; $hadAny = $true }
if (Test-Path -LiteralPath $nmPkg) {
  $bkWebui = Join-Path $bk 'contextinjector-webui'
  New-Item -ItemType Directory -Path $bkWebui -Force | Out-Null
  Copy-Item -LiteralPath $nmPkg -Destination $bkWebui -Recurse -Force; $hadAny = $true
}
Col Green "备份目录: $bk"

# ---- 落位 -------------------------------------------------------------------
# 插件单文件 -> profiles/<prof>/（CONTEXTinjector import ../toolfold/toolfold.mjs → profiles/toolfold/）
Copy-Item -LiteralPath $pluginCtx -Destination (Join-Path $profDir 'contextinjector.mjs') -Force
Copy-Item -LiteralPath $pluginLg  -Destination (Join-Path $profDir 'logcompiler.mjs') -Force
Copy-Item -LiteralPath $pluginEx  -Destination (Join-Path $profDir 'extreason.mjs') -Force
$tfDir = Join-Path $DSH_HOME 'profiles\toolfold'
if (-not (Test-Path -LiteralPath $tfDir)) { New-Item -ItemType Directory -Path $tfDir -Force | Out-Null }
Copy-Item -LiteralPath (Join-Path $src 'toolfold.mjs') -Destination (Join-Path $tfDir 'toolfold.mjs') -Force
# v2 §13 condense 纯模块 -> profiles/condense/（logcompiler import ../condense/chunk.mjs）
$condDir = Join-Path $DSH_HOME 'profiles\condense'
if (-not (Test-Path -LiteralPath $condDir)) { New-Item -ItemType Directory -Path $condDir -Force | Out-Null }
Copy-Item -LiteralPath (Join-Path $src 'condense\chunk.mjs') -Destination (Join-Path $condDir 'chunk.mjs') -Force
Copy-Item -LiteralPath (Join-Path $src 'condense\ivr.mjs') -Destination (Join-Path $condDir 'ivr.mjs') -Force
# webui 包 -> profiles/node_modules/contextinjector-webui/
$nmParent = Join-Path $DSH_HOME 'profiles\node_modules'
if (-not (Test-Path -LiteralPath $nmParent)) { New-Item -ItemType Directory -Path $nmParent -Force | Out-Null }
if (Test-Path -LiteralPath $nmPkg) { Remove-Item -LiteralPath $nmPkg -Recurse -Force }
Copy-Item -LiteralPath $webuiDir -Destination $nmPkg -Recurse -Force

# ---- cordis.patch.yml 幂等插 insert -------------------------------------------
# 四条 insert（contextinjector / logcompiler / contextinjector-webui / extreason）**逐条判定**：
#   · 判定用行锚定的 `- id: <id>` 正则，而不是 `$txt.Contains('id: ...')`——后者有子串陷阱
#     （`id: contextinjector-webui` 也包含 `id: contextinjector`）；
#   · 非空 patch 层只追加**缺的那几条**，否则从"已有前三条"的旧安装升级时会重复插入前三条
#     （同 id 插入两次 ⇒ 插件被装载两遍）。
$hdrLine = "`n# ---- StateCompiler: EXTREASON + CONTEXTinjector + LOGcompiler + WebUI (installed) ----`n"
$entryYaml = [ordered]@{
  'contextinjector'       = "- insert:`n    - id: contextinjector`n      name: './contextinjector.mjs'`n"
  'logcompiler'           = "- insert:`n    - id: logcompiler`n      name: './logcompiler.mjs'`n"
  'contextinjector-webui' = "- insert:`n    - id: contextinjector-webui`n      name: 'contextinjector-webui'`n"
  'extreason'             = "- insert:`n    - id: extreason`n      name: './extreason.mjs'`n"
}
$block = $hdrLine + (-join @($entryYaml.Values))
function Has-InsertYaml($t, $id) { return ($t -match ("(?m)^\s*-\s*id:\s*" + [regex]::Escape($id) + '\s*$')) }
if (-not (Test-Path -LiteralPath $patch)) {
  U8W $patch ("# StateCompiler plugin patch layer (created by install.ps1)" + $block)
} else {
  $txt = U8 $patch
  $missing = @($entryYaml.Keys | Where-Object { -not (Has-InsertYaml $txt $_) })
  if ($missing.Count -gt 0) {
    # 空 patch 层占位（注释 + `[]`）：patch 层必须是**单个顶层数组**，在 `[]` 之后追加条目会得到
    # "文档分隔符后又有内容" ⇒ JSON/YAML 解析报错：
    #   failed to parse overlay cordis.patch.yml: end of the stream or a document separator is expected
    # （2026-09-10 实测事故：测试分支被复位成注释+[]，安装器追加三项后实例无法启动）
    # ⇒ 占位时**替换**该行，其余情况才追加。
    $lines = @($txt -split "`r?`n")
    $body = @($lines | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' -and -not $_.StartsWith('#') })
    $isEmptyPlaceholder = ($body.Count -le 1) -and (($body.Count -eq 0) -or ($body[0] -eq '[]'))
    if ($isEmptyPlaceholder) {
      $kept = @($lines | Where-Object { $_.Trim() -ne '[]' })
      $newTxt = ($kept -join "`n")
      if (-not $newTxt.EndsWith("`n")) { $newTxt += "`n" }
      U8W $patch ($newTxt + $block.TrimStart("`n"))
      Col Green '空 patch 层（注释 + []）→ 已用四项 insert 替换占位（避免在 [] 之后追加导致 YAML 解析失败）。'
    } else {
      if (-not $txt.EndsWith("`n")) { $txt += "`n" }
      $add = $hdrLine + (-join @($missing | ForEach-Object { $entryYaml[$_] }))
      U8W $patch ($txt + $add)
      Col Green ("已追加缺的 {0} 条 insert（{1}）。" -f $missing.Count, ($missing -join ', '))
    }
  } else {
    Col Yellow 'cordis.patch.yml 已含四项 insert，跳过（幂等）。'
  }
}

# ---- 自校验 ----------------------------------------------------------------
$ok = $true
foreach ($need in @((Join-Path $profDir 'contextinjector.mjs'), (Join-Path $profDir 'logcompiler.mjs'), (Join-Path $profDir 'extreason.mjs'), (Join-Path $DSH_HOME 'profiles\condense\chunk.mjs'), (Join-Path $DSH_HOME 'profiles\condense\ivr.mjs'), (Join-Path $nmPkg 'package.json'), (Join-Path $nmPkg 'lib\index.mjs'), (Join-Path $nmPkg 'lib\client.js'))) {
  if (-not (Test-Path -LiteralPath $need)) { Col Red "校验失败: $need"; $ok = $false }
}
$patchTxt = if (Test-Path -LiteralPath $patch) { U8 $patch } else { '' }
foreach ($id in $entryYaml.Keys) { if (-not (Has-InsertYaml $patchTxt $id)) { Col Red "补丁校验失败：缺 insert id: $id"; $ok = $false } }

if ($ok) {
  Col Green "`n安装完成（web profile）。"
  Col Green ("  插件: $profDir\contextinjector.mjs / logcompiler.mjs / extreason.mjs")
  Col Green ("  WebUI: $nmPkg")
  Col Yellow '下一步（重要）：'
  Col Yellow '  1) 重启 dsh web（client 装载器按名缓存，重启才生效；F5 不够）。'
  Col Yellow '  2) 打开会话「注入」tab：默认 CONTEXTinjector 关闭；LOGcompiler 默认全会话记录。'
  Col Yellow '     · 注入：在「当前会话」卡为会话选「工具折叠/单压缩/双压缩」即启用折叠；'
  Col Yellow '     · 日志：`logcompiler` 默认写 DSH_HOME/state-compiler/transcripts/<sid>.log，可在面板改目录/停用。'
  Col Yellow '     · 外置推理：EXTREASON 在主模型 reasoningEffort=off 时每轮自动跑只读子代理并注入 [R] 简报；关掉用 EXTREASON=0。'
  Col Yellow '  3) 本插件基于 @deepseek-ai/dsh 0.1.1-rc.2 验证。'
  Col Yellow ("  备份: $bk（uninstall.ps1 会用它回滚）")
} else {
  Col Red '安装校验未全通过，请检查上方输出；原文件已备份，可运行 uninstall.ps1 或从备份还原。'
  exit 1
}
