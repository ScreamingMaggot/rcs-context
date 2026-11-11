// IVR 口径回归：inBytes 必须是**本折**喂进压缩器的原料（单折量）。
// 旧实现用 `shadowedBytes − 上一轮累计转录`，单折量小于累计转录时被钳成 0，
// 面板于是出现大量「输入 0B、比值 0」，累计比值也被带偏（真机 0.59 而实际 3.45×）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ivrRecord, ivrLoad } from '../condense/ivr.mjs'

const dir = mkdtempSync(join(tmpdir(), 'rcs-ivr-'))
const sid = 'session-abc'

test('① 单折输入直接取本折原料，不再被累计转录钳成 0', () => {
  const a = ivrRecord(dir, sid, { n: 2, inBytes: 153611, transcriptBytes: 49704, shadowedBytes: 153611 })
  assert.equal(a.inBytes, 153611)
  assert.equal(a.outBytes, 49704)
  assert.equal(a.ratio, 3.0905)

  const b = ivrRecord(dir, sid, { n: 2, inBytes: 67087, transcriptBytes: 74290, shadowedBytes: 116791 })
  assert.equal(b.inBytes, 67087, '本折原料小于累计转录时不得归零')
  assert.equal(b.outBytes, 24586)
  assert.equal(b.ratio, 2.7287)

  // 真机故障点：shadowedBytes(38161) < 累计转录(74290) ⇒ 旧口径 inBytes=0
  const c = ivrRecord(dir, sid, { n: 4, inBytes: 38161, transcriptBytes: 92351, shadowedBytes: 38161 })
  assert.equal(c.inBytes, 38161)
  assert.equal(c.outBytes, 18061)
  assert.equal(c.ratio, +(38161 / 18061).toFixed(4))
  assert.ok(c.cumRatio > 1, '累计比值应为正收益（>1），不是 0.59 那种失真值')
})

test('② 旧口径文件迁移：先备份再重建，不混算', () => {
  const dir2 = mkdtempSync(join(tmpdir(), 'rcs-ivr-old-'))
  const sid2 = 'session-old'
  // 旧文件由 ivrRecord 首次写入后再改回 io 语义，模拟历史数据
  ivrRecord(dir2, sid2, { n: 1, inBytes: 1000, transcriptBytes: 500 })
  const fp = join(dir2, 'ivr', 'old.json')
  const st = JSON.parse(readFileSync(fp, 'utf8'))
  st.roundSemantics = 'io'
  st.rounds[0].inBytes = 0 // 旧口径的坏值
  writeFileSync(fp, JSON.stringify(st, null, 2))

  const r = ivrRecord(dir2, sid2, { n: 2, inBytes: 800, transcriptBytes: 1200 })
  assert.equal(r.inBytes, 800)
  const after = JSON.parse(readFileSync(fp, 'utf8'))
  assert.equal(after.roundSemantics, 'io2')
  assert.equal(after.rounds.length, 1, '旧行不参与新口径')
  const baks = readdirSync(join(dir2, 'ivr')).filter((f) => f.includes('.bak-'))
  assert.equal(baks.length, 1, '旧文件必须留有备份')
  assert.equal(ivrLoad(dir2, sid2).rounds[0].inBytes, 800)
})
