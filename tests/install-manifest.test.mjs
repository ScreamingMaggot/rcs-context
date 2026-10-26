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

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
process.exit(fails ? 1 : 0)
