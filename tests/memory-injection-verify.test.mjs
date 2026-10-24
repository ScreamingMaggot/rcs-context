// 注入时复验：state 事实里的具体路径必须仍然存在；缺失则不进目录/召回/增量注入。
// 运行：node tests/memory-injection-verify.test.mjs
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
process.env.DSH_CONTEXTINJECTOR_STATE_DIR = mkdtempSync(join(tmpdir(), 'rcs-inject-state-'))
const mem = await import(pathToFileURL(join(HERE, '..', 'web', 'memory.mjs')).href)
const { MemoryStore, catalogDigest, buildRecallHint, buildInsightDelta, contextDigest, summaryPathsCurrent } = mem

let fails = 0
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + String(detail) : ''}`)
  if (!cond) fails++
}

const root = mkdtempSync(join(tmpdir(), 'rcs-inject-db-'))
const WS = root.replace(/\\/g, '/').toLowerCase()
const good = join(root, 'exists.md')
const spacedDir = join(root, 'dir with space')
const spaced = join(spacedDir, 'spaced.md')
const missing = join(root, 'gone.md')
writeFileSync(good, 'x')
mkdirSync(spacedDir, { recursive: true })
writeFileSync(spaced, 'y')

const store = new MemoryStore(new DatabaseSync(join(root, 'm.sqlite')), { stateDir: root, rawDir: join(root, 'raw') })
store.ingest({
  sid: 's1', seq: 1, kind: 'insight', key: 'good-path', scope: 'ws:' + WS,
  value: { summary: `项目说明在 ${good}。`, confidence: 0.9 }, source: { sid: 's1', seq: 1 }, extractor: 'seed', ts: Date.now() - 3000,
})
store.ingest({
  sid: 's1', seq: 2, kind: 'insight', key: 'missing-path', scope: 'ws:' + WS,
  value: { summary: `旧项目说明在 ${missing}。`, confidence: 0.9 }, source: { sid: 's1', seq: 2 }, extractor: 'seed', ts: Date.now() - 2000,
})
store.ingest({
  sid: 's1', seq: 3, kind: 'insight', key: 'spaced-path', scope: 'ws:' + WS,
  value: { summary: `项目说明另见 \`${spaced}\`。`, confidence: 0.9 }, source: { sid: 's1', seq: 3 }, extractor: 'seed', ts: Date.now() - 1000,
})

check('① 存在路径通过', summaryPathsCurrent(`见 ${good}。`) === true)
check('① 缺失路径拒绝', summaryPathsCurrent(`见 ${missing}。`) === false)
check('① 带空格的可引用路径通过', summaryPathsCurrent(`见 \`${spaced}\`。`) === true)
check('① 未引用的空格路径不冒进', summaryPathsCurrent('见 C:\\NoSuchDir Eval\\missing.md 目录') === true)
check('① 引用后的缺失空格路径仍拒绝', summaryPathsCurrent('见 `C:\\NoSuchDir Eval\\missing.md`。') === false)
check('① 通配符/省略路径不误判', summaryPathsCurrent('见 C:\\foo\\*.md 与 C:\\foo\\...\\bar.md。') === true)
check('① 相对路径按 workspace 解析', summaryPathsCurrent('见 ./exists.md。', { workspace: root }) === true && summaryPathsCurrent('见 ./gone.md。', { workspace: root }) === false)

const verified = catalogDigest(store, { sid: 's1', workspace: WS, verifyPaths: true })
// Phase 1：自动注入只用 L0（≤50），长路径不保证出现在 L0；存在性复验仍按完整 summary 过滤。
check('② 目录注入保留存在的事实', verified.includes('项目说明在') && verified.includes('项目说明另见'), verified)
check('② 目录注入剔除缺失路径', !verified.includes('旧项目说明') && !verified.includes('gone.md'), verified)
const unverified = catalogDigest(store, { sid: 's1', workspace: WS })
check('② 默认不改变旧行为', unverified.includes('旧项目说明'), unverified)
const recGood = store.get({ sid: 's1', scope: 'ws:' + WS, workspace: WS, kind: 'insight', key: 'good-path' })
const goodL1 = mem.resolveLayer(recGood, 'l1')
check('② 长路径在 L1 完整可读', goodL1.text.includes('exists.md') && goodL1.chars <= 240, goodL1.text)
check('② L0 不输出半截路径', !verified.includes('exists.md') && !verified.includes('rcs-inject-db-'), verified)

const hint = buildRecallHint(store, { sid: 's1', workspace: WS, userText: '项目说明', verifyPaths: true })
check('③ 召回注入保留存在的事实', !!hint && hint.text.includes('项目说明在') && hint.text.includes('项目说明另见'), hint && hint.text)
check('③ 召回注入剔除缺失路径', !!hint && !hint.text.includes('旧项目说明') && !hint.text.includes('gone.md'), hint && hint.text)

const delta = buildInsightDelta(store, { sid: 's1', workspace: WS, since: 0, verifyPaths: true })
check('④ 同会话增量保留存在路径', delta.includes('项目说明另见') && delta.includes('项目说明在'), delta)
check('④ 同会话增量剔除缺失路径', !delta.includes('旧项目说明') && !delta.includes('gone.md'), delta)

// ⑤ 交接卡：目录为空时卡片会列出 Known facts，同样要在注入前复验路径
{
  const root2 = mkdtempSync(join(tmpdir(), 'rcs-inject-card-'))
  const WS2 = root2.replace(/\\/g, '/').toLowerCase()
  const good2 = join(root2, 'card-exists.md')
  const missing2 = join(root2, 'card-gone.md')
  writeFileSync(good2, 'x')
  const store2 = new MemoryStore(new DatabaseSync(join(root2, 'm.sqlite')), { stateDir: root2, rawDir: join(root2, 'raw') })
  const dir = join(root2, 'memory', 'handover')
  mkdirSync(dir, { recursive: true })
  const h = {
    sid: 's2', workspace: WS2, generatedAt: Date.now(), throughSeq: 1,
    stats: { total: 1, sessions: 1, docs: 0, insights: 2 },
    lastUser: { text: 'x', seq: 1 }, errors: [], files: [],
    insights: [
      { summary: `项目说明在 ${good2}。` },
      { summary: `旧项目说明在 ${missing2}。` },
    ],
  }
  writeFileSync(join(dir, 's2.json'), JSON.stringify(h), 'utf8')
  writeFileSync(join(dir, 'latest-' + createHash('sha1').update(WS2).digest('hex').slice(0, 12) + '.json'),
    JSON.stringify({ sid: 's2', workspace: WS2, generatedAt: h.generatedAt, file: 's2.json' }), 'utf8')
  const card = contextDigest(store2, { sid: 's3', workspace: WS2, verifyPaths: true })
  check('⑤ 交接卡保留存在路径', card.includes('项目说明在'), card)
  check('⑤ 交接卡剔除缺失路径', !card.includes('旧项目说明') && !card.includes('card-gone'), card)
  const oldCard = contextDigest(store2, { sid: 's3', workspace: WS2 })
  check('⑤ 默认不改变旧行为', oldCard.includes('旧项目说明'), oldCard)
  store2.close()
}

store.close()
console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
process.exit(fails ? 1 : 0)
