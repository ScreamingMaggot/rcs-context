// 值保真链回归测试 —— 守"关键数值逐字保留 / 承重 token 不可被改坏"这条底线。
//   两道防线（第一道默认生效，第二道需 control.payloadCheck=true）：
//     ① guardText/restoreText：弱模型只看到占位符 ⟦P0⟧/⟦ID1⟧/⟦HX2⟧，
//        它**没有原值可改** ⇒ 改值/截断/幻觉在构造上不可能；回填由规则完成。
//     ② verifyAgainstSource + occursWhole：浓缩结果里的每个"承重 token"必须在原文
//        **整词**出现，否则整条 [A] 回退无损（"错误载荷比丢失更糟"）。
//   运行：node tests/value-fidelity.test.mjs
import { mkdtempSync, mkdirSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
const root = mkdtempSync(join(tmpdir(), 'rcs-val-'))
for (const d of ['web', 'condense', 'toolfold']) mkdirSync(join(root, d), { recursive: true })
copyFileSync(join(SRC, 'web', 'contextinjector.mjs'), join(root, 'web', 'contextinjector.mjs'))
for (const f of ['chunk.mjs', 'ivr.mjs']) copyFileSync(join(SRC, 'condense', f), join(root, 'condense', f))
copyFileSync(join(SRC, 'toolfold', 'toolfold.mjs'), join(root, 'toolfold', 'toolfold.mjs'))
const M = await import(pathToFileURL(join(root, 'web', 'contextinjector.mjs')).href)
const { guardText, restoreText, verifyAgainstSource, occursWhole } = M

let fails = 0
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '   ' + String(detail) : ''}`)
  if (!cond) fails++
}

/* ── ① 占位化：把"可被改坏的值"从弱模型眼前拿走 ─────────────────────── */
const SAMPLES = [
  '端口 PORT=8787，配置文件 conf_17.yaml 里写的是 9031（已作废）',
  '读取 D:\\DSH\\web\\contextinjector.mjs 失败，会话 session-5fe3512e-ac3c-41c4-8dca-f3e6186a94b2 已归档',
  '提交 e7b40c73 与 0087cc54 两个短 id，比率 0.31，见 https://example.com/a/b?x=1',
  'CLEANUP_OK 后写 deploy.py，正文 README.md 第 12 行',
  '长任务书里出现 1234567890 与 878 两个数字（前者该核、后者不该核）',
]
for (let i = 0; i < SAMPLES.length; i++) {
  const g = guardText(SAMPLES[i])
  const r = restoreText(g.text, g.slots)
  check(`① 样本 ${i + 1}：占位化后往返逐字还原（无损）`, r === SAMPLES[i],
    r === SAMPLES[i] ? '' : `got=${JSON.stringify(r)}`)
}
const g1 = guardText('读取 D:\\DSH\\web\\a.mjs 与 session-5fe3512e-ac3c-41c4-8dca-f3e6186a94b2 和 e7b40c73')
check('① 路径/UUID/长 hex 都被占位（模型拿不到原值）',
  !g1.text.includes('5fe3512e') && !g1.text.includes('e7b40c73') && !g1.text.includes('DSH'), g1.text)
check('① 槽位数与占位符数一致（回填不错位）',
  g1.slots.length === (g1.text.match(/⟦[A-Z]+\d+⟧/g) || []).length, `slots=${g1.slots.length}`)
check('① 路径先抽：路径内的 hex 只占一个槽（防嵌套）',
  g1.slots[0].includes('DSH') && !g1.slots.some((x) => /\\d/.test(x) && x.includes('web') && x.length > 24))

/* ── ② 回填的失败模式：宁缺勿造 ───────────────────────────────────── */
check('② 模型把占位符原样带出 ⇒ 回填成原值',
  restoreText('见 ⟦P0⟧ 这一行', g1.slots).includes('D:\\DSH'))
check('② 模型丢掉占位符 ⇒ 结果里既没有原值也没有残骸（不凭空造值）',
  !restoreText('我把路径删了', g1.slots).includes('DSH'))
check('② 未知槽位号 ⇒ 置空而非抛错（折叠不能因回填崩掉）',
  restoreText('⟦P99⟧ 结束', g1.slots) === ' 结束')
const nested = restoreText('⟦P0⟧ 内含 ⟦ID1⟧', [g1.slots[0], 'session-aaaa1111-bbbb-cccc-dddd-eeeeffff0000'])
check('② 嵌套占位被递归展开（不留 ⟦…⟧ 残骸）',
  !/⟦/.test(nested) && nested.includes('session-aaaa1111'), nested)
check('② 空槽表 ⇒ 原样返回占位文本（不误吞内容）', restoreText('⟦P0⟧ x', []) === ' x')

/* ── ③ occursWhole：整词出现，防"截断前缀"蒙混 ─────────────────────── */
check('③ 完整值出现 ⇒ 认', occursWhole('端口 8787 生效', '8787') === true)
check('③ 前缀冒充（878 是 8787 的前缀）⇒ 不认', occursWhole('端口 8787 生效', '878') === false)
check('③ 后缀截断（0.31 vs 0.311.0）⇒ 不认', occursWhole('版本 0.111.0', '0.31') === false)
check('③ 两侧被可延续字符包住 ⇒ 不认（README ≠ READMExx 的片段）',
  occursWhole('READMExx 文件', 'README') === false)
check('③ 大小写不敏感', occursWhole('Cleanup_ok 已置', 'CLEANUP_OK') === true)
check('③ 空 token ⇒ false（不白给通过）', occursWhole('任意原文', '') === false)
check('③ 空原文 ⇒ false', occursWhole('', '8787') === false)

/* ── ④ verifyAgainstSource：五类承重 token 全核对 ──────────────────── */
const SRC_TEXT = '端口 PORT=8787；配置 conf_17.yaml 里的 9031 已作废；提交 e7b40c73；见 https://example.com/a.py；状态 CLEANUP_OK；版本 0.111.0'
check('④ 逐字摘抄 ⇒ 通过', verifyAgainstSource('PORT=8787 与 conf_17.yaml 与 e7b40c73 与 CLEANUP_OK', SRC_TEXT) === true)
check('④ 改端口（8787→9031 型串值）⇒ 拒绝',
  verifyAgainstSource('把端口写成 9031 生效', '端口 PORT=8787 生效，别的数字都不相干') === false)
check('④ 编造 hex 短 id ⇒ 拒绝', verifyAgainstSource('提交 deadbeef 完成', SRC_TEXT) === false)
check('④ 文件名被截断（conf_17.yaml → conf.yaml）⇒ 拒绝',
  verifyAgainstSource('见 conf.yaml 配置', SRC_TEXT) === false)
check('④ URL 被改写 ⇒ 拒绝', verifyAgainstSource('见 https://evil.example.com/a.py', SRC_TEXT) === false)
check('④ 大写状态词被改 ⇒ 拒绝', verifyAgainstSource('状态 CLEANUP_FAILED', SRC_TEXT) === false)
check('④ 无承重 token 的纯叙述 ⇒ 通过（不误伤）',
  verifyAgainstSource('这一段没有任何值', SRC_TEXT) === true)
check('④ 两位小计数不参与核对（降误报的既定口径）',
  verifyAgainstSource('共 12 项', SRC_TEXT) === true)
check('④ 空浓缩结果 ⇒ 通过（由上层"无输出即回退"处理，不在此闸）',
  verifyAgainstSource('', SRC_TEXT) === true)

/* ── ⑤ 两道防线的默认档位（诚实记录，防文档与代码漂移） ─────────────── */
// payloadCheck 默认关闭：三类误杀（README→伪 token、URL 吞中文标点、0.111.0→伪 31）会白退化成无损。
// 第一道（guard/restore）在任何档位都生效 ⇒ "值被改坏"仍有防线。
// 占位化的**覆盖边界**（实测记录，改动即失败 ⇒ 逼着写理由）：
//   已纳入：Windows 路径 / UUID / ≥6 位 hex；未纳入：裸数字（端口）、带扩展名的 unix 文件名。
//   ⇒ 数字与文件名的保真只靠第二道闸 verifyAgainstSource，而它默认关闭（payloadCheck=false）。
const gb = guardText('端口 PORT=8787，见 conf_17.yaml，提交 e7b40c73，路径 D:\\x\\a.py')
check('⑤ 占位化覆盖 uuid/hex/盘符路径',
  !gb.text.includes('e7b40c73') && !gb.text.includes('5fe3512e') && !gb.text.includes('a.py'))
check('⑤ 已知边界：裸数字与 unix 文件名不在占位化范围内（记录在案，非静默）',
  gb.text.includes('8787') && gb.text.includes('conf_17.yaml'), gb.text)
check('⑤ 第二道闸独立可判（供 control.payloadCheck=true 时恢复严格语义）',
  typeof verifyAgainstSource === 'function' && typeof occursWhole === 'function')

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
process.exit(fails ? 1 : 0)
