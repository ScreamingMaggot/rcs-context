// 可观测性指标测试（0.1.56）
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { recordCompile, recordRetrieval, recordInjection, getMetrics } from '../web/memory.mjs'

describe('memory metrics', () => {
  test('recordCompile tracks success and failure', () => {
    recordCompile(true)
    recordCompile(true)
    recordCompile(false)
    
    const metrics = getMetrics()
    assert.ok(metrics.compile.total >= 3)
    assert.ok(metrics.compile.success >= 2)
    assert.ok(metrics.compile.failure >= 1)
    assert.ok(metrics.compile.successRate)
  })

  test('recordRetrieval tracks success and failure', () => {
    recordRetrieval(true)
    recordRetrieval(false)
    
    const metrics = getMetrics()
    assert.ok(metrics.retrieval.total >= 2)
    assert.ok(metrics.retrieval.success >= 1)
    assert.ok(metrics.retrieval.failure >= 1)
    assert.ok(metrics.retrieval.successRate)
  })

  test('recordInjection tracks hit and miss', () => {
    recordInjection(true)
    recordInjection(true)
    recordInjection(false)
    
    const metrics = getMetrics()
    assert.ok(metrics.injection.total >= 3)
    assert.ok(metrics.injection.hit >= 2)
    assert.ok(metrics.injection.miss >= 1)
    assert.ok(metrics.injection.hitRate)
  })

  test('getMetrics returns formatted rates', () => {
    const metrics = getMetrics()
    assert.ok(typeof metrics.compile.successRate === 'string')
    assert.ok(typeof metrics.retrieval.successRate === 'string')
    assert.ok(typeof metrics.injection.hitRate === 'string')
    assert.ok(metrics.lastUpdated)
  })

  test('metrics persist to file', () => {
    // Metrics are stored in the actual DSH_HOME, not a temp directory
    const metricsFile = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'state-compiler', '.memory', 'metrics.json')
    recordCompile(true)
    
    // File should exist after recording
    assert.ok(existsSync(metricsFile), 'metrics file should exist at ' + metricsFile)
    const data = JSON.parse(readFileSync(metricsFile, 'utf8'))
    assert.ok(data.compile.total > 0)
  })
})
