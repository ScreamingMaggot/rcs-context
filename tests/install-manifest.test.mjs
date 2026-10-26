// 安装清单一致性：memory.mjs 依赖 memory-janitor.mjs，安装器/卸载器必须同步带上。
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

let fails = 0
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + String(detail) : ''}`)
  if (!cond) fails++
}

check('① memory-janitor.mjs 存在', existsSync(join(ROOT, 'web', 'memory-janitor.mjs')))
const memorySrc = read('web/memory.mjs')
const memoryDeps = [...new Set([...memorySrc.matchAll(/from\s+['"]\.\/(memory-[\w-]+\.mjs)['"]/g)].map((m) => m[1]))]
check('② memory.mjs 引用它', memoryDeps.includes('memory-janitor.mjs'), memoryDeps.join(','))
check('②b memory.mjs 的本地依赖都存在', memoryDeps.every((f) => existsSync(join(ROOT, 'web', f))), memoryDeps.join(','))

const install = read('install.ps1')
for (const dep of memoryDeps) {
  const esc = dep.replace(/\./g, '\\.')
  check(`③ ${dep} 安装器声明`, new RegExp(`\\$plugin[\\w]+\\s*=\\s*Join-Path \\$src 'web\\\\${esc}'`).test(install))
  check(`④ ${dep} 安装器落位`, new RegExp(`Copy-Item -LiteralPath \\$plugin[\\w]+ -Destination \\(Join-Path \\$profDir '${esc}'\\)`).test(install))
  check(`⑤ ${dep} 安装器备份`, new RegExp(`'${esc}'\\)\\).*Join-Path \\$bk '${esc}'`).test(install))
  check(`⑥ ${dep} 安装器自校验`, new RegExp(`Join-Path \\$profDir '${esc}'`).test(install.split('# ---- 自校验')[1] ?? ''))
}

const uninstall = read('uninstall.ps1')
const lists = uninstall.match(/foreach \(\$name in @\([^)]*\)\)/g) ?? []
check('⑦ 卸载器三个清单都包含全部 memory 模块', lists.length === 3 && memoryDeps.every((f) => lists.every((l) => l.includes(f))), JSON.stringify({ lists: lists.length, deps: memoryDeps }))

const pkg = JSON.parse(read('package.json'))
check('⑧ 发布包 files 覆盖 web 目录', Array.isArray(pkg.files) && pkg.files.includes('web'))

// Cycle 2 is a separate module graph (blog entry ledger-online), so it has to be
// listed explicitly: memory.mjs does not import any of these files.
const cycle2 = [
  ['memory-durability.mjs', 'web/memory-durability.mjs'],
  ['memory-proposals.mjs', 'web/memory-proposals.mjs'],
  ['memory-proposal-store.mjs', 'web/memory-proposal-store.mjs'],
  ['memory-ledger-core.mjs', 'web/memory-ledger-core.mjs'],
  ['memory-ledger.mjs', 'web/memory-ledger.mjs'],
  ['memory-observations.mjs', 'web/memory-observations.mjs'],
  ['memory-online-bridge.mjs', 'web/memory-online-bridge.mjs'],
  ['ledger-online.mjs', 'web/ledger-online.mjs'],
]
const cycle2Backup = (install.match(/\$cycle2Names = @\([^)]*\)/) ?? [''])[0]
const selfCheckSection = install.split('# ---- 自校验')[1] ?? ''
for (const [name, rel] of cycle2) {
  const winRel = rel.replace(/\//g, '\\')
  check(`⑨ ${name} 源文件存在`, existsSync(join(ROOT, rel)))
  check(`⑩ ${name} 安装器声明`, install.includes(`Join-Path $src '${winRel}'`))
  check(`⑪ ${name} 安装器落位`, install.includes(`Destination (Join-Path $profDir '${name}')`))
  check(`⑫ ${name} 安装器备份`, cycle2Backup.includes(`'${name}'`))
  check(`⑬ ${name} 安装器自校验`, selfCheckSection.includes(`'${name}'`))
  check(`⑭ ${name} 卸载器清单`, lists.length === 3 && lists.every((l) => l.includes(name)))
}
check('⑮ ledger-online 补丁项已声明',
  install.includes("'ledger-online'") && install.includes('id: ledger-online'))

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
process.exit(fails ? 1 : 0)
