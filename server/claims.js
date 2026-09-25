import { db } from './db.js'

// ===== 灾害损失申报与协作复核 =====
// 成员针对恶劣天气事件申报作物/动物/设施损失 → 管理员/场主复核：
//   approve  批准并按核定金额赔付（金币入农场金库、防灾物资入背包，同一事务落库）
//   reject   驳回（结案；同一事件同一类别允许重新申报）
//   moreinfo 要求补证（申报人补充材料后自动回到待审核队列）
// 重复申报约束由数据库部分唯一索引 idx_claims_active 兜底（见 db.js）。

export const CLAIM_CATS = {
  crop: { name: '作物损失', icon: '🌾' },
  animal: { name: '动物损失', icon: '🐄' },
  facility: { name: '设施损失', icon: '🏚️' }
}
export const CLAIM_STATUS = {
  pending: '待审核', moreinfo: '待补证', approved: '已赔付', rejected: '已驳回'
}
// 单笔申报/核赔上限（防止误输入或超额赔付掏空金库）
export const MAX_CLAIM_GOLD = 500
export const MAX_CLAIM_MAT = 20

const q = (sql, ...p) => db.prepare(sql).all(...p)
const q1 = (sql, ...p) => db.prepare(sql).get(...p)
const run = (sql, ...p) => db.prepare(sql).run(...p)

const err = (msg, status = 400) => Object.assign(new Error(msg), { status })
const clampInt = (v, max) => Math.max(0, Math.min(max, Math.floor(Number(v) || 0)))

function parseEvidence(json) {
  try {
    const arr = JSON.parse(json || '[]')
    return Array.isArray(arr) ? arr : []
  } catch { return [] }
}

// 可申报的灾害事件：本农场发生过的恶劣天气（severity>=1），最近的在前
export function claimableEvents(farmId) {
  return q(`SELECT id, type, name, icon, severity, season, day, abs_day, done
            FROM weather_events WHERE farm_id=? AND severity>=1
            ORDER BY abs_day DESC LIMIT 8`, farmId)
}

// 全农场申报单（协作复核：所有成员可见，便于互相知会；带天气事件与补证明细）
export function listClaims(farmId) {
  return q(`SELECT c.*, e.type AS event_type, e.name AS event_name, e.icon AS event_icon,
                   e.severity AS event_severity, e.abs_day AS event_abs
            FROM disaster_claims c JOIN weather_events e ON e.id=c.event_id
            WHERE c.farm_id=? ORDER BY c.id DESC LIMIT 50`, farmId)
    .map((c) => ({ ...c, evidence: parseEvidence(c.evidence) }))
}

// 提交申报：同一成员对同一事件的同类损失只允许一条进行中的申报（驳回后可重报）
export function submitClaim({ farmId, userId, userName, eventId, category, gold, mat, note }) {
  const cat = CLAIM_CATS[category] ? category : null
  if (!cat) throw err('损失类别非法')
  const g = clampInt(gold, MAX_CLAIM_GOLD)
  const m = clampInt(mat, MAX_CLAIM_MAT)
  if (!g && !m) throw err('请填写申请赔付的金币或物资数量')
  const text = String(note || '').trim().slice(0, 120)
  if (!text) throw err('请填写损失说明')
  const ev = q1('SELECT * FROM weather_events WHERE farm_id=? AND id=?', farmId, Number(eventId))
  if (!ev) throw err('天气事件不存在', 404)
  if (ev.severity < 1) throw err('只有灾害天气（⚠）造成的损失才能申报')
  // 重复申报预检（友好提示）；并发场景由唯一索引 idx_claims_active 兜底
  const dup = q1(`SELECT id, status FROM disaster_claims
                  WHERE farm_id=? AND event_id=? AND category=? AND created_by=?
                  AND status IN ('pending','moreinfo','approved')`, farmId, ev.id, cat, userId)
  if (dup) {
    throw err(dup.status === 'approved'
      ? `该事件的${CLAIM_CATS[cat].name}已赔付结案（单号 #${dup.id}），不能重复申报`
      : `你已申报过该事件的${CLAIM_CATS[cat].name}（单号 #${dup.id}），请勿重复提交；可在原单上补证`)
  }
  try {
    const r = run(`INSERT INTO disaster_claims
                   (farm_id,event_id,category,amount_gold,amount_mat,note,status,created_by,created_name,created_at)
                   VALUES (?,?,?,?,?,?, 'pending', ?,?,?)`,
      farmId, ev.id, cat, g, m, text, userId, userName, Date.now())
    return { ok: true, id: r.lastInsertRowid }
  } catch (e) {
    if (String(e.message).includes('idx_claims_active')) throw err('该损失已有进行中的申报，请勿重复提交')
    throw e
  }
}

// 补证：仅申报人本人、且申报单仍在审核流程中（待审核/待补证）；
// 待补证状态补证后自动回到待审核，等待管理员复核
export function addEvidence({ farmId, userId, userName, id, text }) {
  const c = q1('SELECT * FROM disaster_claims WHERE farm_id=? AND id=?', farmId, Number(id))
  if (!c) throw err('申报单不存在', 404)
  if (c.created_by !== userId) throw err('只能给自己的申报单补证', 403)
  if (!['pending', 'moreinfo'].includes(c.status)) throw err('该申报已结案，无法补证')
  const t = String(text || '').trim().slice(0, 200)
  if (!t) throw err('请填写补充说明')
  const list = parseEvidence(c.evidence)
  list.push({ by: userId, byName: userName, text: t, at: Date.now() })
  run('UPDATE disaster_claims SET evidence=?, status=? WHERE id=?', JSON.stringify(list), 'pending', c.id)
  return { ok: true, status: 'pending', evidence: list }
}

// 复核（管理员/场主）：action = approve / reject / moreinfo
// approve 时以核定金额（默认按申请额）在同一事务内完成赔付落库：
//   金币 → player.gold；物资 → inventory 防灾物资；申报单 → approved
export function reviewClaim({ farmId, userId, userName, id, action, note, gold, mat }) {
  const c = q1('SELECT * FROM disaster_claims WHERE farm_id=? AND id=?', farmId, Number(id))
  if (!c) throw err('申报单不存在', 404)
  if (!['pending', 'moreinfo'].includes(c.status)) throw err('该申报已结案，无需复核')
  const act = String(action || '')
  if (!['approve', 'reject', 'moreinfo'].includes(act)) throw err('复核动作非法')
  const reviewNote = String(note || '').trim().slice(0, 120)
  if (act === 'moreinfo' && !reviewNote) throw err('请说明需要补充的材料')
  if (act === 'reject' && !reviewNote) throw err('请填写驳回原因')
  const now = Date.now()

  if (act !== 'approve') {
    run(`UPDATE disaster_claims SET status=?, reviewed_by=?, reviewed_name=?, reviewed_at=?, review_note=?
         WHERE id=?`, act === 'reject' ? 'rejected' : 'moreinfo', userId, userName, now, reviewNote, c.id)
    return { ok: true, status: act === 'reject' ? 'rejected' : 'moreinfo' }
  }

  const g = clampInt(gold == null ? c.amount_gold : gold, MAX_CLAIM_GOLD)
  const m = clampInt(mat == null ? c.amount_mat : mat, MAX_CLAIM_MAT)
  if (!g && !m) throw err('赔付金额不能全为 0（可选择驳回）')
  db.exec('BEGIN IMMEDIATE')
  try {
    // 联动农场状态：赔付金币入金库、防灾物资入背包，申报单结案
    run('UPDATE player SET gold=gold+? WHERE farm_id=?', g, farmId)
    if (m > 0) {
      const row = q1(`SELECT id, qty FROM inventory WHERE farm_id=? AND item_id='disaster-kit'`, farmId)
      if (row) run('UPDATE inventory SET qty=qty+? WHERE id=?', m, row.id)
      else run(`INSERT INTO inventory (farm_id,item_id,name,cat,qty) VALUES (?, 'disaster-kit', '防灾物资', 'material', ?)`, farmId, m)
    }
    run(`UPDATE disaster_claims SET status='approved', amount_gold=?, amount_mat=?,
         reviewed_by=?, reviewed_name=?, reviewed_at=?, review_note=? WHERE id=?`,
      g, m, userId, userName, now, reviewNote, c.id)
    db.exec('COMMIT')
    return { ok: true, status: 'approved', payoutGold: g, payoutMat: m }
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 事务可能已结束，忽略 */ }
    throw e
  }
}
