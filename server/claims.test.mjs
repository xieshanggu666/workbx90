// 临时集成测试：灾害损失申报与协作复核（申报/重复约束/补证/复核/赔付联动）
// 用临时工作目录复制 server 模块，db.js 会在该目录创建独立 farm.db
import { mkdirSync, cpSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const tmp = path.join(root, '.tmp-claims-test')
rmSync(tmp, { recursive: true, force: true })
mkdirSync(tmp, { recursive: true })
for (const f of ['db.js', 'claims.js']) cpSync(path.join(root, f), path.join(tmp, f))

const { db } = await import(pathToFileURL(path.join(tmp, 'db.js')).href)
const C = await import(pathToFileURL(path.join(tmp, 'claims.js')).href)

let failures = 0
const assert = (cond, msg) => {
  if (!cond) { failures++; console.error('❌', msg) }
  else console.log('✅', msg)
}
const run = (sql, ...p) => db.prepare(sql).run(...p)
const q1 = (sql, ...p) => db.prepare(sql).get(...p)

// ===== 准备农场 8：场主(1) + 成员(2/3)，一场持续 2 天的暴雨灾害 =====
const FID = 8
const now = Date.now()
run(`INSERT INTO farms (id,name,owner_id,version,created_at) VALUES (?,?,?,0,?)`, FID, '灾损测试农场', 1, now)
for (const [id, role] of [[1, 'owner'], [2, 'member'], [3, 'member']]) {
  run(`INSERT INTO farm_members (farm_id,user_id,role,status,joined_at) VALUES (?,?,?,'active',?)`, FID, id, role, now)
}
run(`INSERT INTO player (farm_id,name,gold,season,day,abs_day) VALUES (8,'p',100,0,1,1)`)
run(`INSERT INTO weather_events (farm_id,season,day,abs_day,type,name,icon,duration,severity)
     VALUES (8,1,3,3,'storm','暴雨','⛈️',2,2)`)
const evId = q1(`SELECT id FROM weather_events WHERE farm_id=8`).id

// 迁移校验：新表与部分唯一索引存在
assert(!!q1(`SELECT name FROM sqlite_master WHERE type='table' AND name='disaster_claims'`), 'disaster_claims 表已建')
assert(!!q1(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_claims_active'`), '重复申报部分唯一索引已建')

// ===== 1) 可申报事件只含灾害天气 =====
run(`INSERT INTO weather_events (farm_id,season,day,abs_day,type,name,icon,duration,severity)
     VALUES (8,1,1,1,'sunny','晴天','☀️',1,0)`)
assert(C.claimableEvents(FID).length === 1 && C.claimableEvents(FID)[0].type === 'storm', '可申报事件仅含灾害天气')

// ===== 2) 成员提交申报：作物损失 🪙120 + 物资×3 =====
const c1 = C.submitClaim({ farmId: FID, userId: 2, userName: '阿强', eventId: evId, category: 'crop', gold: 120, mat: 3, note: '暴雨冲毁三畦番茄' })
assert(c1.id > 0, '成员提交作物损失申报成功')
const row1 = q1('SELECT * FROM disaster_claims WHERE id=?', c1.id)
assert(row1.status === 'pending' && row1.amount_gold === 120 && row1.amount_mat === 3, '申报落库为待审核')

// 校验：非灾害/金额全 0/缺说明/类别非法
for (const [bad, msg] of [
  [{ gold: 0, mat: 0, note: 'x' }, '金额全 0 被拒'],
  [{ gold: 10, mat: 0, note: '' }, '缺损失说明被拒'],
  [{ gold: 10, mat: 0, note: 'x', category: 'house' }, '非法类别被拒']
]) {
  let e = null
  try { C.submitClaim({ farmId: FID, userId: 2, userName: '阿强', eventId: evId, category: 'crop', ...bad }) } catch (err) { e = err }
  assert(e?.status === 400, msg)
}
// 晴天事件不能申报
let sunnyErr = null
try { C.submitClaim({ farmId: FID, userId: 2, userName: '阿强', eventId: q1(`SELECT id FROM weather_events WHERE type='sunny'`).id, category: 'crop', gold: 10, mat: 0, note: 'x' }) } catch (e) { sunnyErr = e }
assert(sunnyErr?.status === 400, '非灾害天气不能申报')

// ===== 3) 重复申报约束：同人同事同类被拒；不同类别/不同人可申报 =====
let dupErr = null
try { C.submitClaim({ farmId: FID, userId: 2, userName: '阿强', eventId: evId, category: 'crop', gold: 50, mat: 0, note: '再报一次' }) } catch (e) { dupErr = e }
assert(dupErr?.status === 400 && /重复|请勿/.test(dupErr.message), '同一成员对同事件同类损失重复申报被拒')
const c2 = C.submitClaim({ farmId: FID, userId: 2, userName: '阿强', eventId: evId, category: 'animal', gold: 60, mat: 0, note: '鸡舍进水' })
assert(c2.id > 0, '同一事件不同类别可另行申报')
const c3 = C.submitClaim({ farmId: FID, userId: 3, userName: '阿珍', eventId: evId, category: 'crop', gold: 80, mat: 2, note: '我的也被冲了' })
assert(c3.id > 0, '不同成员对同事件同类损失可各自申报')

// ===== 4) 补证：仅本人可补；待补证补证后回到待审核 =====
let notMine = null
try { C.addEvidence({ farmId: FID, userId: 3, userName: '阿珍', id: c1.id, text: '替他补' }) } catch (e) { notMine = e }
assert(notMine?.status === 403, '不能给他人的申报单补证')
// 管理员要求补证 → 状态 moreinfo
const mi = C.reviewClaim({ farmId: FID, userId: 1, userName: '场主', id: c1.id, action: 'moreinfo', note: '请补充受灾地块照片' })
assert(mi.status === 'moreinfo', '管理员要求补证后状态为待补证')
const ev1 = C.addEvidence({ farmId: FID, userId: 2, userName: '阿强', id: c1.id, text: '已补三张照片与地块编号' })
assert(ev1.status === 'pending' && ev1.evidence.length === 1, '补证后回到待审核且补证留痕')
// 要求补证必须填意见
let noNote = null
try { C.reviewClaim({ farmId: FID, userId: 1, userName: '场主', id: c1.id, action: 'moreinfo', note: '' }) } catch (e) { noNote = e }
assert(noNote?.status === 400, '要求补证必须填写说明')

// ===== 5) 批准赔付：核定金额可调整，联动金币与防灾物资 =====
const goldBefore = q1('SELECT gold FROM player WHERE farm_id=8').gold
const ap = C.reviewClaim({ farmId: FID, userId: 1, userName: '场主', id: c1.id, action: 'approve', note: '情况属实', gold: 100, mat: 2 })
assert(ap.status === 'approved' && ap.payoutGold === 100 && ap.payoutMat === 2, '批准按核定金额赔付（🪙100+物资×2）')
assert(q1('SELECT gold FROM player WHERE farm_id=8').gold === goldBefore + 100, '赔付金币已入农场金库')
assert(q1(`SELECT qty FROM inventory WHERE farm_id=8 AND item_id='disaster-kit'`).qty === 2, '赔付防灾物资已入背包')
assert(q1('SELECT amount_gold, amount_mat FROM disaster_claims WHERE id=?', c1.id).amount_gold === 100, '申报单金额已更新为核定赔付额')
// 已结案不能复核/补证
let again = null
try { C.reviewClaim({ farmId: FID, userId: 1, userName: '场主', id: c1.id, action: 'approve', gold: 1, mat: 0 }) } catch (e) { again = e }
assert(again?.status === 400, '已赔付申报不能重复复核')
let evDone = null
try { C.addEvidence({ farmId: FID, userId: 2, userName: '阿强', id: c1.id, text: 'x' }) } catch (e) { evDone = e }
assert(evDone?.status === 400, '已结案申报不能补证')
// 已赔付后同一成员对同事件同类不能再申报（防止重复领赔）
let dupPaid = null
try { C.submitClaim({ farmId: FID, userId: 2, userName: '阿强', eventId: evId, category: 'crop', gold: 10, mat: 0, note: '再领一次' }) } catch (e) { dupPaid = e }
assert(dupPaid?.status === 400, '已赔付的损失不能重复申报')

// ===== 6) 驳回：结案但允许重新申报 =====
const rj = C.reviewClaim({ farmId: FID, userId: 1, userName: '场主', id: c3.id, action: 'reject', note: '与当日灾情不符' })
assert(rj.status === 'rejected', '驳回后状态为已驳回')
const c3b = C.submitClaim({ farmId: FID, userId: 3, userName: '阿珍', eventId: evId, category: 'crop', gold: 30, mat: 0, note: '重新整理材料再报' })
assert(c3b.id > 0, '驳回后允许重新申报')

// ===== 7) 列表：全农场可见，带事件与补证明细 =====
const list = C.listClaims(FID)
assert(list.length === 4, `列表含全部 4 张申报单（实际 ${list.length}）`)
const c1v = list.find((x) => x.id === c1.id)
assert(c1v.event_name === '暴雨' && c1v.evidence.length === 1 && c1v.reviewed_name === '场主', '列表带天气事件/补证/复核人信息')

db.close()
rmSync(tmp, { recursive: true, force: true })
console.log(failures ? `\n${failures} 个断言失败` : '\n全部通过 🎉')
process.exit(failures ? 1 : 0)
