// transcript_expand 的注册存活与工具定义（v1.10.67 – v1.10.71）
//
// 真机故障（2026-11-10）：插件的 armed 日志一直正常、register 从不抛错，但模型的工具目录里
// 始终没有 transcript_expand（探针 visible=NO，补挂 21 次全无效）。
//
// 根因不是时机、也不是 tools.restrict 白名单，而是每处注册后紧跟的
//
//     ctx.effect(() => { dispose?.() })
//
// cordis 的 effect(execute) 会**立即执行** execute，并把返回值当 disposer —— 于是"持有注册"
// 变成了"注册完立刻注销"，工具连一次都活不到模型请求那一刻。修法是 generator 持有器
// （holdToolRegistration：yield 出真正的 disposer，effect 只在卸载时调用）。
//
// 本测试三段：
//   A. 源码段（总是跑）：插件里有持有器、且不再有立即释放写法；三处注册路径都用它。
//   B. 语义段（有宿主才跑）：在真实 cordis + ToolsService 上复现两种写法的生死差异。
//   C. 定义段（有宿主才跑）：register 的两道校验 + 目录投影不吞 description。
//
// 没有可用的 DSH 安装时，B/C 打 SKIP 并返回 0 —— 宿主未装不是插件的失败。
// 运行：node tests/tool-registration-visible.test.mjs
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveDshPackages, ROOT } from './lib-resolve-dsh.mjs'

const PLUGIN = join(ROOT, 'web', 'contextinjector.mjs')
let fails = 0
const ok = (cond, label, extra = '') => {
  if (cond) console.log(`PASS  ${label}${extra ? '  ' + extra : ''}`)
  else { fails += 1; console.log(`FAIL  ${label}${extra ? '  ' + extra : ''}`) }
}
const skip = (label, why) => console.log(`SKIP  ${label}  (${why})`)

// ---------- A. 源码段 ----------
const src = readFileSync(PLUGIN, 'utf8')
// 只看代码：去掉整行注释与那条把故障写法写进说明的版本串（它们是解释，不是实现）
const code = src
  .split('\n')
  .filter((line) => !/^\s*(\/\/|\*)/.test(line) && !/^const PLUGIN_VERSION/.test(line))
  .join('\n')

ok(/function holdToolRegistration\(/.test(src), '插件提供 holdToolRegistration 持有器')
const naive = [...code.matchAll(/\.effect\(\s*\(\s*\)\s*=>\s*\{[^}]*dispose\?\.\(\)/g)]
ok(naive.length === 0, '插件里不再有 ctx.effect(() => dispose()) 这类立即释放写法', naive.length ? `命中 ${naive.length} 处` : '')
const armed = (src.match(/holdToolRegistration\(/g) || []).length
ok(armed >= 4, '各注册路径都走持有器（定义 + ctx.tools + 补挂 + inject 回退）', `出现 ${armed} 次`)

const mod = await import(pathToFileURL(PLUGIN).href)
const tool = mod.makeTranscriptExpandTool()
ok(tool?.name === 'transcript_expand', 'makeTranscriptExpandTool 导出可取')
ok(typeof mod.readRawEntry === 'function', 'readRawEntry 导出可取（工具实现依赖）')

// ---------- B/C. 宿主相关 ----------
const PKG = resolveDshPackages()
if (!PKG) {
  skip('cordis 注册存活语义', '未找到 DSH 安装；可设 DSH_PKG_DIR=<...>/node_modules/@deepseek-ai')
  skip('register 校验与目录投影', '同上')
} else {
  console.log(`  使用宿主包：${PKG}`)
  let cordisOk = true
  let Context, ToolsService, SystemPromptService, tw
  try {
    ;({ Context } = await import(pathToFileURL(join(PKG, 'cordis', 'lib', 'index.js')).href))
    ToolsService = (await import(pathToFileURL(join(PKG, 'dsh-tools', 'lib', 'index.js')).href)).default
    SystemPromptService = (await import(pathToFileURL(join(PKG, 'dsh-system-prompt', 'lib', 'index.js')).href)).default
    tw = await import(pathToFileURL(join(PKG, 'dsh-tools', 'lib', 'index.js')).href)
  } catch (err) {
    cordisOk = false
    skip('cordis 注册存活语义', '宿主模块导入失败：' + (err?.message ?? err))
    skip('register 校验与目录投影', '同上')
  }

  if (cordisOk) {
    const mk = (name) => ({
      name,
      description: 'probe tool for registration lifetime',
      parameters: { type: 'object', properties: { seq: { type: 'integer' } }, required: ['seq'], additionalProperties: false },
      output: { schema: { type: 'object', properties: { ok: { type: 'boolean' } }, additionalProperties: true }, render: () => [{ type: 'text', text: 'x' }] },
      execute: async () => ({ ok: true }),
    })
    try {
      const ctx = new Context()
      ctx.plugin(SystemPromptService)
      ctx.plugin(ToolsService)
      await new Promise((r) => setTimeout(r, 50))
      const tools = ctx.get('tools')
      ok(typeof tools?.register === 'function', 'ToolsService 可用')

      const dNaive = tools.register(mk('probe_naive'))
      ctx.effect(() => { dNaive?.() }) // ← 就是真机里那行
      ok(tools.layers?.global?.tools?.has('probe_naive') === false, 'naive 写法：注册后立即被注销（复现真机故障）')

      const dGen = tools.register(mk('probe_generator'))
      ctx.effect(function* () { yield () => { try { dGen?.() } catch { /* ignore */ } } })
      const defs = typeof tools.definitions === 'function' ? tools.definitions() : []
      ok(tools.layers?.global?.tools?.has('probe_generator') === true, 'generator 写法：注册存活')
      ok(Array.isArray(defs) && defs.some((d) => d.name === 'probe_generator'), 'generator 写法：进入 definitions() 可见表')

      // register() 实际做的两道校验
      ok(typeof tw.assertSupportedJsonSchema === 'function' && (() => { try { tw.assertSupportedJsonSchema(tool.output.schema); return true } catch { return false } })(),
        'assertSupportedJsonSchema(tool.output.schema) 通过')
      const proj = typeof tw.projectToolSchema === 'function' ? tw.projectToolSchema(tool, true) : null
      ok(!!proj && typeof proj.description === 'string' && proj.description.length >= 20 && proj.parameters?.type === 'object',
        'projectToolSchema 保住 description 且不改写 parameters 形状',
        proj ? `description ${proj.description.length} 字` : '')
      // 反面留证（只记录、不判失败）：register() 吃的是**原生 JSON Schema**，而 defineTool 那条
      //   属性映射 DSL 的 mapper 会拒它（JsonSchemaError: parameters.type must be a value
      //   schema object）。宿主版本若把两者统一，这一行会变成 NOTE 里的另一句话，不影响结论。
      if (typeof tw.parameterSchemaSpecToJsonSchema === 'function') {
        let dslError = null
        try { tw.parameterSchemaSpecToJsonSchema(tool.parameters) } catch (err) { dslError = err?.message ?? String(err) }
        console.log(`NOTE  defineTool 的 DSL mapper ${dslError ? '拒绝' : '接受'}原生 JSON Schema${dslError ? '：' + dslError : ''}`)
      }
    } catch (err) {
      fails += 1
      console.log(`FAIL  宿主语义段抛出：${err?.name}: ${err?.message ?? err}`)
    }
  }
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
process.exit(fails === 0 ? 0 : 1)
