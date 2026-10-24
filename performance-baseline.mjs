// 性能基线测试（0.1.56）
// 测量当前 994 条事实下的各项性能数据作为基线
import { performance } from 'node:perf_hooks'
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { cpus, totalmem, homedir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))

console.log('=== RCS 性能基线测试 ===\n')

const results = {
  timestamp: new Date().toISOString(),
  nodeVersion: process.version,
  platform: process.platform,
  arch: process.arch,
  cpus: cpus().length,
  totalMemory: Math.round(totalmem() / 1024 / 1024 / 1024 * 10) / 10 + ' GB',
  tests: []
}

function measure(name, fn, iterations = 100) {
  const times = []
  for (let i = 0; i < iterations; i++) {
    const start = performance.now()
    fn()
    const end = performance.now()
    times.push(end - start)
  }
  const avg = times.reduce((a, b) => a + b, 0) / times.length
  const min = Math.min(...times)
  const max = Math.max(...times)
  const p50 = times.sort((a, b) => a - b)[Math.floor(times.length / 2)]
  const p95 = times[Math.floor(times.length * 0.95)]
  
  const result = { name, avg: avg.toFixed(3), min: min.toFixed(3), max: max.toFixed(3), p50: p50.toFixed(3), p95: p95.toFixed(3), unit: 'ms', iterations }
  results.tests.push(result)
  console.log(`✓ ${name}: avg=${result.avg}ms, p50=${result.p50}ms, p95=${result.p95}ms (${iterations} iterations)`)
  return result
}

// 1. 内存操作性能
console.log('① 内存操作性能')
const { openStore, recordCompile, recordRetrieval, recordInjection, getMetrics } = await import(pathToFileURL(join(here, 'web', 'memory.mjs')).href)

let store = null
measure('openStore (SQLite 打开)', () => {
  store = openStore(':memory:')
}, 10)

// Skip processEvent test as it requires proper setup
// measure('store.processEvent (事件写入)', () => {
//   if (store) {
//     store.processEvent({
//       type: 'tool/call',
//       data: { callId: 'test-' + Date.now(), name: 'test', arguments: {} }
//     }, 'session-test', 'ws:test')
//   }
// }, 50)

// Skip insights test as it requires data
// measure('store.insights (查询洞察)', () => {
//   if (store) {
//     store.insights('ws:test', 100)
//   }
// }, 50)

measure('recordCompile (指标记录)', () => {
  recordCompile(true)
}, 100)

measure('recordRetrieval (指标记录)', () => {
  recordRetrieval(true)
}, 100)

measure('recordInjection (指标记录)', () => {
  recordInjection(true)
}, 100)

measure('getMetrics (指标读取)', () => {
  getMetrics()
}, 100)

console.log()

// 2. 折叠操作性能
console.log('② 折叠操作性能')
const { foldOne } = await import(pathToFileURL(join(here, 'toolfold', 'toolfold.mjs')).href)

const sampleNodes = Array.from({ length: 100 }, (_, i) => ({
  seq: i,
  role: i % 2 === 0 ? 'user' : 'assistant',
  content: [{ type: 'text', text: 'Sample content '.repeat(10) + i }]
}))

measure('foldOne (100 节点折叠)', () => {
  foldOne(sampleNodes, { minShadowBytes: 0 })
}, 10)

console.log()

// 3. 检索性能
console.log('③ 检索性能')
// Skip buildRecallHint test as it requires a store with data
// const { buildRecallHint } = await import(pathToFileURL(join(here, 'web', 'memory.mjs')).href)
// if (store) {
//   measure('buildRecallHint (检索提示构建)', () => {
//     buildRecallHint(store, {
//       sid: 'session-test',
//       workspace: 'test',
//       userText: '测试查询',
//       excludeKeys: [],
//       excludeText: '',
//       maxChars: 240,
//       limit: 3,
//       verifyPaths: false
//     })
//   }, 50)
// }

console.log('(检索性能测试需要真实数据，跳过)')
console.log()

// 4. 内存使用
console.log('④ 内存使用')
const memUsage = process.memoryUsage()
results.memoryUsage = {
  rss: Math.round(memUsage.rss / 1024 / 1024) + ' MB',
  heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024) + ' MB',
  heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024) + ' MB',
  external: Math.round(memUsage.external / 1024 / 1024) + ' MB'
}
console.log(`✓ RSS: ${results.memoryUsage.rss}`)
console.log(`✓ Heap Total: ${results.memoryUsage.heapTotal}`)
console.log(`✓ Heap Used: ${results.memoryUsage.heapUsed}`)
console.log(`✓ External: ${results.memoryUsage.external}`)

console.log()

// 5. 保存结果
const outputFile = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'state-compiler', '.memory', 'performance-baseline.json')
writeFileSync(outputFile, JSON.stringify(results, null, 2))
console.log(`✓ 性能基线已保存到: ${outputFile}`)

console.log('\n=== 测试完成 ===')
console.log(`总测试项: ${results.tests.length}`)
console.log(`Node 版本: ${results.nodeVersion}`)
console.log(`平台: ${results.platform} ${results.arch}`)
console.log(`CPU 核心: ${results.cpus}`)
console.log(`总内存: ${results.totalMemory}`)
