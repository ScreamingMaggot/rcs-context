// 工作区作用域规范化：同一目录的 Windows 原始路径（反斜杠/大小写/尾斜杠）必须命中同一份记忆。
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { MemoryStore } from '../web/memory.mjs'

let fails = 0
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + String(detail) : ''}`)
  if (!cond) fails++
}
const root = mkdtempSync(join(tmpdir(), 'rcs-ws-'))
const s = new MemoryStore(new DatabaseSync(join(root, 'ws.sqlite')), { stateDir: root, rawDir: join(root, 'raw') })
s.ingest({
  sid: 'seed', seq: 1, kind: 'insight', key: 'k1', scope: 'ws:D:\\Proj\\X\\',
  value: { summary: '接口端口固定为 8848。', confidence: 0.9 }, source: { sid: 'seed', seq: 1 },
})
const cat = s.catalog({ sid: 's1', scope: 'project', workspace: 'd:/proj/x' }, 10)
check('① catalog 用规范化 workspace 看得到', cat.total === 1, cat.total)
const r = s.search({ sid: 's1', scope: 'project', workspace: 'd:/proj/x', query: '端口' })
check('② search 用规范化 workspace 命中', r.results.some((x) => x.key === 'k1'), r.mode + ':' + r.results.length)
const raw = s.db.prepare('SELECT scope FROM records WHERE key=?').get('k1')
check('③ 写入时 scope 已规范化', raw?.scope === 'ws:d:/proj/x', raw?.scope)
console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
process.exit(fails ? 1 : 0)
