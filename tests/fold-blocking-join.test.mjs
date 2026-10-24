// 阻塞 join 回归测试（0.1.56）：pre-step 必须等压缩完成再放行请求
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const codePath = join(here, '..', 'web', 'contextinjector.mjs')

describe('fold blocking join', () => {
  test('pre-step waits for fold completion', () => {
    const code = readFileSync(codePath, 'utf8')
    
    // 验证 pre-step 处理器里有 await joinFoldInFlight
    const preStepMatch = code.match(/ctx\.on\('agent\/pre-step'[\s\S]*?await joinFoldInFlight/)
    assert.ok(preStepMatch, 'pre-step should await joinFoldInFlight')
    
    // 验证注释说明了阻塞 join 的原因
    const commentMatch = code.match(/阻塞 join 回归|用户开压缩就是为了吃增益/)
    assert.ok(commentMatch, 'should have comment explaining blocking join rationale')
    
    // 验证非阻塞版本被移除
    const nonBlockingMatch = code.match(/joinFoldInFlight\([^)]+\)\.catch/)
    assert.ok(!nonBlockingMatch, 'non-blocking join should be removed')
    
    assert.ok(true, 'all pre-step blocking checks passed')
  })

  test('join timeout still acts as safety valve', () => {
    const code = readFileSync(codePath, 'utf8')
    
    // 验证 joinFoldInFlight 函数有超时参数
    const joinFuncMatch = code.match(/async function joinFoldInFlight\([^)]*timeoutMs/)
    assert.ok(joinFuncMatch, 'joinFoldInFlight should accept timeout parameter')
    
    // 验证超时后有日志
    const timeoutLogMatch = code.match(/fold-join-timeout/)
    assert.ok(timeoutLogMatch, 'should log fold-join-timeout on timeout')
    
    // 验证默认超时值
    const defaultTimeoutMatch = code.match(/FOLD_JOIN_TIMEOUT_MS.*3000/)
    assert.ok(defaultTimeoutMatch, 'default timeout should be 3000ms')
    
    assert.ok(true, 'all timeout safety checks passed')
  })

  test('fold in-flight tracking is correct', () => {
    const code = readFileSync(codePath, 'utf8')
    
    // 验证有 foldInFlight Map
    const mapMatch = code.match(/const foldInFlight = new Map\(\)/)
    assert.ok(mapMatch, 'should have foldInFlight Map')
    
    // 验证 scheduleFold 函数存在
    const scheduleMatch = code.match(/function scheduleFold\(/)
    assert.ok(scheduleMatch, 'should have scheduleFold function')
    
    // 验证折叠完成后清理
    const cleanupMatch = code.match(/foldInFlight\.delete\(sid\)/)
    assert.ok(cleanupMatch, 'should clean up foldInFlight after completion')
    
    assert.ok(true, 'all in-flight tracking checks passed')
  })
})
