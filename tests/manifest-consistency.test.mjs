// 清单一致性：版本号、contents、以及"注释里引用的文件真的存在"
//
// 为什么需要（2026-11-04 复核发现的三处实证）：
//   ① `version.json.description` 曾以 `"undefined + "` 开头 —— 生成器拼接了一个未定义值。
//      这类缺陷不影响运行，但 version.json 是**对外**的构建凭证，一条自相矛盾的清单会让
//      所有"按清单核对"的动作失效。
//   ② `package.json` 0.1.39 与 `version.json` 0.1.74 不一致，且 version.json 已无 commit 字段；
//      旧纪律是"行为版本(PLUGIN_VERSION) ↔ 包版本 1:1"，现在只剩 version.json 里的
//      `pluginVersions` 承担这个映射 ⇒ 必须由测试钉住它。
//   ③ `web/contextinjector.mjs` 的注释引用 `tools/measure-prompt-surface.mjs`，
//      而该文件在 0.1.20 → rcs-context 搬迁中丢失 ⇒ "交叉校验"只剩一句引用。
//      本测试把"注释里出现的 tools/*.mjs 必须在场"变成机械判据。
// 运行：node tests/manifest-consistency.test.mjs
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
let fails = 0
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + String(detail) : ''}`)
  if (!cond) fails++
}
const SEMVER = /^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/

const manifestPath = join(ROOT, 'version.json')
const pkgPath = join(ROOT, 'package.json')
check('version.json 在场', existsSync(manifestPath))
check('package.json 在场', existsSync(pkgPath))
if (!existsSync(manifestPath) || !existsSync(pkgPath)) process.exit(1)

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))

check('version.json.version 是合法 semver', SEMVER.test(String(manifest.version)), manifest.version)
check('package.json.version 是合法 semver', SEMVER.test(String(pkg.version)), pkg.version)

// ① 任何字符串字段都不得以 undefined 开头（生成器拼接未定义值）
const bad = []
for (const [k, v] of Object.entries(manifest)) {
  if (typeof v === 'string' && /^undefined\b/.test(v)) bad.push(k)
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k2, v2] of Object.entries(v)) {
      if (typeof v2 === 'string' && /^undefined\b/.test(v2)) bad.push(k + '.' + k2)
    }
  }
}
check('version.json 无 "undefined" 开头的字段', bad.length === 0, bad.join(',') || 'ok')

// ② 行为版本 ↔ 清单 1:1：pluginVersions.contextinjector 的 vX.Y.Z 必须等于源码 PLUGIN_VERSION
const src = readFileSync(join(ROOT, 'web', 'contextinjector.mjs'), 'utf8')
const mSrc = /^const PLUGIN_VERSION = 'v(\d+\.\d+\.\d+)/m.exec(src)
check('源码里有 PLUGIN_VERSION', !!mSrc, mSrc ? 'v' + mSrc[1] : '未找到')
const declared = String(manifest.pluginVersions?.contextinjector ?? '')
const mMan = /^v(\d+\.\d+\.\d+)/.exec(declared)
check('pluginVersions.contextinjector 有版本号', !!mMan, declared.slice(0, 24) + '…')
if (mSrc && mMan) {
  check('行为版本 1:1（源码 vs 清单）', mSrc[1] === mMan[1], `源码 v${mSrc[1]} / 清单 v${mMan[1]}`)
}

// ③ contents 里的每一项都必须真实存在
const contents = Array.isArray(manifest.contents) ? manifest.contents : []
check('contents 非空', contents.length > 0, contents.length + ' 项')
const missingContents = contents.filter((c) => {
  const p = join(ROOT, String(c).replace(/\/+$/, ''))
  return !existsSync(p)
})
check('contents 全部存在', missingContents.length === 0, missingContents.join(', ') || 'ok')

// ④ 源码注释里引用的 tools/*.mjs 必须在场（防止"引用仍在、校验已无"）
const referenced = new Set()
for (const f of readdirSync(join(ROOT, 'web'))) {
  if (!f.endsWith('.mjs')) continue
  const t = readFileSync(join(ROOT, 'web', f), 'utf8')
  for (const m of t.matchAll(/tools\/([A-Za-z0-9._-]+\.mjs)/g)) referenced.add(m[1])
}
check('注释引用了至少一个 tools/*.mjs', referenced.size > 0, [...referenced].join(', ') || '（无）')
const missingTools = [...referenced].filter((n) => !existsSync(join(ROOT, 'tools', n)))
check('被引用的 tools/*.mjs 全部在场', missingTools.length === 0, missingTools.join(', ') || 'ok')

// ⑤ 记录两套版本号的关系（不一致不判失败，但必须可追溯）
if (String(pkg.version) !== String(manifest.version)) {
  console.log(`NOTE  package.json=${pkg.version}  version.json=${manifest.version}（npm 包版本与发布版本号不同轨；本条只记录，不判失败）`)
}

console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAIL'}`)
process.exit(fails === 0 ? 0 : 1)
