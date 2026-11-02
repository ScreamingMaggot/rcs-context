// 上游瞬时故障不得让一次记忆编译白跑。真机事故（11-02 11:18 / 11:22）：opencode-go 返回
// 400 {"type":"server_error","message":"Upstream request failed: Model is unavailable."}，
// llmLast 直接记 llm-failed —— 而这类请求没有产出、重试不计费，退避两轮常能赶上可用窗口。
// 同时钉住反面：鉴权/参数错、以及"被拒档位"不重试，避免白烧钱。
import test from 'node:test'
import assert from 'node:assert/strict'
import { retryTransient, isTransientAuxError } from '../web/memory.mjs'

const UPSTREAM = { text: null, error: 'INVALID_REQUEST:400: {"type":"server_error","message":"Upstream request failed: Model is unavailable."}', effortRejected: false }

test('① 上游不可用：按退避重试，成功后返回正文并记 attempts', async () => {
  const seen = []
  const r = await retryTransient(async (i) => { seen.push(i); return i < 2 ? UPSTREAM : { text: 'ok', error: null, effortRejected: false } }, [0, 0])
  assert.equal(r.text, 'ok')
  assert.equal(r.attempts, 3)
  assert.deepEqual(seen, [0, 1, 2])
})

test('② 重试额度用完仍是失败：如实返回 attempts=3，不伪装成功', async () => {
  const r = await retryTransient(async () => UPSTREAM, [0, 0])
  assert.equal(r.text, null)
  assert.equal(r.attempts, 3)
  assert.match(r.error, /Model is unavailable/)
})

test('③ 鉴权/参数类错误一次就停：重试只会白花钱', async () => {
  let calls = 0
  const r = await retryTransient(async () => { calls += 1; return { text: null, error: 'INVALID_REQUEST:401: invalid api key', effortRejected: false } }, [0, 0])
  assert.equal(calls, 1)
  assert.equal(r.attempts, 1)
})

test('④ 档位被拒不归瞬时重试管，交给阶梯', async () => {
  let calls = 0
  const rej = { text: null, error: 'UNSUPPORTED_REASONING_EFFORT: does not support reasoning effort "off"', effortRejected: true }
  await retryTransient(async () => { calls += 1; return rej }, [0, 0])
  assert.equal(calls, 1)
  assert.equal(isTransientAuxError(rej), false)
})

test('⑤ 分类器覆盖常见瞬时形态、不误吞其它错误', () => {
  for (const e of ['429 Too Many Requests', '503 Service Unavailable', 'request timeout', 'fetch failed', 'socket hang up', '{"type":"server_error"}']) {
    assert.equal(isTransientAuxError({ text: null, error: e }), true, e)
  }
  for (const e of ['empty output', 'no finish chunk', 'insufficient balance']) {
    assert.equal(isTransientAuxError({ text: null, error: e }), false, e)
  }
})
