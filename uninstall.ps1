# =============================================================================
# StateCompiler 卸载器：移除 EXTREASON + CONTEXTinjector + LOGcompiler + WebUI 面板
# 优先用 <DSH_HOME>/.statecompiler-backup-<stamp> 还原安装前现场；无备份则删除
# 四项 insert 与已落位文件。
# 用法：.\uninstall.ps1 [-DSH_HOME <dir>] [-BackupDir <dir>] [-Force]
# =============================================================================
param(
  [string]$DSH_HOME = $env:DSH_HOME,
  [string]$BackupDir = '',
  [switch]$Force
)
$ErrorActionPreference = 'Stop'
function Col($c,$m){ Write-Host $m -ForegroundColor $c }
function U8($p){ return [IO.File]::ReadAllText($p, [Text.Encoding]::UTF8) }
function U8W($p,$s){ [IO.File]::WriteAllText($p, $s, (New-Object Text.UTF8Encoding($false))) }

if ([string]::IsNullOrWhiteSpace($DSH_HOME)) { $DSH_HOME = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.dsh' }
$DSH_HOME = [IO.Path]::GetFullPath($DSH_HOME)
$profDir = Join-Path $DSH_HOME 'profiles\web'
$patch   = Join-Path $profDir 'cordis.patch.yml'
$nmPkg   = Join-Path $DSH_HOME 'profiles\node_modules\contextinjector-webui'

# ---- 定位备份 --------------------------------------------------------------
# 优先选"首装前原貌"：备份里若存有 cordis.patch.yml 且不含 StateCompiler 四项 → 用它还原最干净。
# 否则退到 Strip-StateCompiler 直接删补丁项。
$hasBk = $false
if ([string]::IsNullOrWhiteSpace($BackupDir)) {
  $cands = @(Get-ChildItem -LiteralPath $DSH_HOME -Directory -Filter '.statecompiler-backup-*' -ErrorAction SilentlyContinue | Sort-Object Name)  # 升序（旧→新）
  foreach ($c in $cands) {
    $bp = Join-Path $c.FullName 'cordis.patch.yml'
    if (Test-Path -LiteralPath $bp) {
      $t = [IO.File]::ReadAllText($bp, [Text.Encoding]::UTF8)
      if (-not ($t.Contains('id: contextinjector-webui') -or $t.Contains('id: logcompiler') -or $t.Contains('id: extreason'))) {
        $BackupDir = $c.FullName; $hasBk = $true; break   # 找到原貌备份
      }
    }
  }
  # 没有原貌补丁备份但存在其它备份 → 用最早的一份（仍有还原文件的价值）
  if (-not $hasBk -and $cands.Count -gt 0) { $BackupDir = $cands[0].FullName; $hasBk = $true }
} elseif (Test-Path -LiteralPath $BackupDir) { $hasBk = $true }

# ---- 从补丁移除四项 insert（整块删除）--------------------------------------
function Strip-StateCompiler($txt) {
  $lines = $txt -split "`n"
  $out = New-Object System.Collections.Generic.List[string]
  $i = 0
  while ($i -lt $lines.Length) {
    $ln = $lines[$i]
    if ($ln.Trim() -eq '- insert:') {
      # 收集本块（直到下一个非缩进行）
      $j = $i + 1
      $block = New-Object System.Collections.Generic.List[string]
      while ($j -lt $lines.Length) {
        $b = $lines[$j]
        if ([string]::IsNullOrWhiteSpace($b)) { $block.Add($b); $j++; continue }
        if ($b -match '^\S' -and $b.Trim() -ne '') { break }  # 下一个顶层
        $block.Add($b); $j++
      }
      $joined = ($block -join "`n")
      if ($joined -match 'id:\s*contextinjector' -or $joined -match 'id:\s*logcompiler' -or $joined -match 'id:\s*extreason') {
        # 命中目标 → 跳过整块（含开头的 '- insert:')
        $i = $j; continue
      }
      $out.Add($ln)
      foreach ($bl in $block) { $out.Add($bl) }
      $i = $j
    } else {
      $out.Add($ln); $i++
    }
  }
  return (($out -join "`n") -replace '(\n\s*){3,}', "`n`n")
}

# ---- 执行 -------------------------------------------------------------------
if ($hasBk) {
  Col Yellow "使用备份还原: $BackupDir"
  foreach ($name in @('contextinjector.mjs','logcompiler.mjs','extreason.mjs','cordis.patch.yml')) {
    $b = Join-Path $BackupDir $name
    $t = Join-Path $profDir $name
    if (Test-Path -LiteralPath $b) { Copy-Item -LiteralPath $b -Destination $t -Force; Col Green "还原 $name" }
  }
  $bw = Join-Path $BackupDir 'contextinjector-webui'
  if (Test-Path -LiteralPath $bw) {
    if (Test-Path -LiteralPath $nmPkg) { Remove-Item -LiteralPath $nmPkg -Recurse -Force }
    Copy-Item -LiteralPath $bw -Destination $nmPkg -Recurse -Force
    Col Green '还原 contextinjector-webui'
  } elseif (Test-Path -LiteralPath $nmPkg) {
    Remove-Item -LiteralPath $nmPkg -Recurse -Force
    Col Green '删除新增 contextinjector-webui（原貌无此包）'
  }
  # 备份里没有而仍在的（本次安装新增、安装前不存在）→ 删除
  foreach ($name in @('contextinjector.mjs','logcompiler.mjs','extreason.mjs')) {
    $b = Join-Path $BackupDir $name
    $t = Join-Path $profDir $name
    if (-not (Test-Path -LiteralPath $b) -and (Test-Path -LiteralPath $t)) { Remove-Item -LiteralPath $t -Force; Col Green "删除新增 $name" }
  }
  if (-not (Test-Path -LiteralPath (Join-Path $BackupDir 'cordis.patch.yml'))) {
    if (Test-Path -LiteralPath $patch) { $t = U8 $patch; $s = Strip-StateCompiler $t; U8W $patch $s; Col Green '已从 cordis.patch.yml 移除 StateCompiler 项（无备份补丁）' }
  }
} else {
  Col Yellow '未找到备份，直接按现状移除。'
  foreach ($name in @('contextinjector.mjs','logcompiler.mjs','extreason.mjs')) {
    $t = Join-Path $profDir $name
    if (Test-Path -LiteralPath $t) { Remove-Item -LiteralPath $t -Force; Col Green "删除 $name" }
  }
  if (Test-Path -LiteralPath $nmPkg) { Remove-Item -LiteralPath $nmPkg -Recurse -Force; Col Green '删除 contextinjector-webui' }
  if (Test-Path -LiteralPath $patch) { $s = Strip-StateCompiler (U8 $patch); U8W $patch $s; Col Green '已移除补丁项' }
}
# toolfold.mjs（profiles/toolfold/）：有备份还原，否则删除
$tfFile = Join-Path $DSH_HOME 'profiles\toolfold\toolfold.mjs'
if ($hasBk -and (Test-Path -LiteralPath (Join-Path $BackupDir 'toolfold.mjs'))) {
  Copy-Item -LiteralPath (Join-Path $BackupDir 'toolfold.mjs') -Destination $tfFile -Force; Col Green '还原 toolfold.mjs'
} elseif (Test-Path -LiteralPath $tfFile) {
  Remove-Item -LiteralPath $tfFile -Force; Col Green '删除 toolfold.mjs'
}
# v2 §13 condense/chunk.mjs（profiles/condense/）：有备份还原，否则删除
$condFile = Join-Path $DSH_HOME 'profiles\condense\chunk.mjs'
if ($hasBk -and (Test-Path -LiteralPath (Join-Path $BackupDir 'condense-chunk.mjs'))) {
  Copy-Item -LiteralPath (Join-Path $BackupDir 'condense-chunk.mjs') -Destination $condFile -Force; Col Green '还原 condense/chunk.mjs'
} elseif (Test-Path -LiteralPath $condFile) {
  Remove-Item -LiteralPath $condFile -Force; Col Green '删除 condense/chunk.mjs'
}
# #5 IVR 簿记模块（profiles/condense/ivr.mjs）
$ivrFile = Join-Path $DSH_HOME 'profiles\condense\ivr.mjs'
if ($hasBk -and (Test-Path -LiteralPath (Join-Path $BackupDir 'condense-ivr.mjs'))) {
  Copy-Item -LiteralPath (Join-Path $BackupDir 'condense-ivr.mjs') -Destination $ivrFile -Force; Col Green '还原 condense/ivr.mjs'
} elseif (Test-Path -LiteralPath $ivrFile) {
  Remove-Item -LiteralPath $ivrFile -Force; Col Green '删除 condense/ivr.mjs'
}
Col Green '卸载完成。请重启 dsh web 使生效。'
