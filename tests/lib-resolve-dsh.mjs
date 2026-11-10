// 定位本机已安装的 DSH 包目录（@deepseek-ai/*），供需要宿主类型的测试用。
//
// 纪律：**不写死任何机器路径**。repository 里曾出现过 `D:/JDC/AGENT2/node_modules/...`
// 这类硬编码（commit 3e25a9a 已修过一次），换台机器就静默失效。这里按下面顺序探测，
// 全都不中就让调用方打 SKIP（宿主未装时这些测试没有意义，不该判失败）：
//   1. env DSH_PKG_DIR                —— 显式指定，最优先（CI/临时环境用）
//   2. env DSH_HOME / DSH_PROFILE_HOME 下的 node_modules/@deepseek-ai
//   3. 本仓库自己的 node_modules/@deepseek-ai（devDependency 安装）
//   4. 从 cwd 与 process.execPath 向上逐级找 node_modules/@deepseek-ai（最多 8 层）
//
// 返回绝对路径（.../node_modules/@deepseek-ai），未找到返回 null。
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const looksRight = (dir) =>
  existsSync(join(dir, 'dsh-tools', 'lib', 'index.js')) && existsSync(join(dir, 'cordis', 'lib', 'index.js'))

export function resolveDshPackages() {
  const cands = []
  if (process.env.DSH_PKG_DIR) cands.push(process.env.DSH_PKG_DIR)
  for (const key of ['DSH_HOME', 'DSH_PROFILE_HOME']) {
    const v = process.env[key]
    if (v) cands.push(join(v, 'node_modules', '@deepseek-ai'))
  }
  cands.push(join(ROOT, 'node_modules', '@deepseek-ai'))

  const walk = (start) => {
    let d = start
    for (let i = 0; i < 8 && d; i++) {
      cands.push(join(d, 'node_modules', '@deepseek-ai'))
      const up = dirname(d)
      if (up === d) break
      d = up
    }
  }
  walk(process.cwd())
  walk(dirname(process.execPath))

  for (const c of cands) {
    if (looksRight(c)) return c
  }
  return null
}

export { ROOT }
