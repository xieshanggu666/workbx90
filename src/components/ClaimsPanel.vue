<template>
  <div class="page claims-page">
    <!-- 左：提交申报 -->
    <div class="pcol card">
      <h4>🌪️ 灾害损失申报</h4>
      <p class="hint">
        恶劣天气（⚠）造成作物、动物或设施损失时，可在此申报赔付；
        管理员复核通过后，赔付金币与防灾物资将直接入账。同一事件的同类损失只能申报一次（驳回后可重报）。
      </p>

      <template v-if="store.claimEvents.length">
        <label class="f-label">灾害事件</label>
        <select v-model="form.eventId" class="f-select">
          <option :value="null" disabled>— 选择造成损失的天气事件 —</option>
          <option v-for="e in store.claimEvents" :key="e.id" :value="e.id">
            {{ e.icon }} {{ e.name }} · 第{{ e.abs_day }}天 · {{ '⚠'.repeat(e.severity) }}{{ e.done ? '' : '（进行中）' }}
          </option>
        </select>

        <label class="f-label">损失类别</label>
        <div class="cat-pick">
          <button v-for="(c, key) in store.claimMeta.cats" :key="key"
                  :class="{on: form.category === key}" @click="form.category = key">
            {{ c.icon }} {{ c.name }}
          </button>
        </div>

        <label class="f-label">申请赔付（金币 ≤{{ store.claimMeta.maxGold }} / 物资 ≤{{ store.claimMeta.maxMat }}）</label>
        <div class="amt-row">
          <span>🪙</span><input type="number" min="0" :max="store.claimMeta.maxGold" v-model.number="form.gold" />
          <span>🧱</span><input type="number" min="0" :max="store.claimMeta.maxMat" v-model.number="form.mat" />
        </div>

        <label class="f-label">损失说明</label>
        <textarea v-model.trim="form.note" rows="3" maxlength="120"
                  placeholder="例：暴雨冲毁 3 块地的番茄，鸡舍进水两只母鸡健康归零…"></textarea>

        <button class="wide start" :disabled="!canSubmit" @click="doSubmit">📮 提交申报</button>
        <p v-if="!store.can('claimSubmit')" class="perm-hint">🔒 需要成员及以上权限才能申报。</p>
      </template>
      <div v-else class="none">近期没有灾害天气事件，无需申报 🎉</div>
    </div>

    <!-- 右：申报单列表（全农场可见，协作复核） -->
    <div class="pcol card">
      <h4>📋 申报单
        <span class="tag tip">全农场可见 · 管理员复核</span>
      </h4>
      <div v-if="!store.claims.length" class="none">还没有申报单</div>
      <div v-for="c in store.claims" :key="c.id" class="claim" :class="c.status">
        <div class="cl-head">
          <b>#{{ c.id }} {{ catOf(c).icon }} {{ catOf(c).name }}</b>
          <span class="cl-state" :class="c.status">{{ statusLabel(c.status) }}</span>
        </div>
        <div class="cl-meta">
          <span class="tag">{{ c.event_icon }} {{ c.event_name }} · 第{{ c.event_abs }}天</span>
          <span class="tag ask">申请 🪙{{ c.amount_gold }} + 物资×{{ c.amount_mat }}</span>
          <span class="creator">
            👤{{ c.created_name }}
            <i class="live-dot" :class="{on: store.onlineUserIds.has(c.created_by)}"
               :title="store.onlineUserIds.has(c.created_by) ? '申报人在线' : '申报人离线'"></i>
          </span>
        </div>
        <p class="cl-note">「{{ c.note }}」</p>

        <!-- 补证记录 -->
        <div v-if="c.evidence && c.evidence.length" class="ev-list">
          <div v-for="(ev, i) in c.evidence" :key="i" class="ev-item">
            📎 <b>{{ ev.byName }}</b>：{{ ev.text }}
            <em>{{ fmtTime(ev.at) }}</em>
          </div>
        </div>

        <!-- 复核结论 -->
        <p v-if="c.review_note" class="cl-review" :class="c.status">
          {{ c.status === 'rejected' ? '🚫 驳回' : c.status === 'moreinfo' ? '📎 需补证' : '✅ 复核' }}
          <template v-if="c.reviewed_name">（{{ c.reviewed_name }}）</template>：{{ c.review_note }}
        </p>
        <p v-if="c.status === 'approved'" class="cl-review approved">
          💰 已赔付 🪙{{ c.amount_gold }} + 防灾物资×{{ c.amount_mat }}（金币与物资已入账）
        </p>

        <!-- 申报人：补证 -->
        <div v-if="isMine(c) && (c.status === 'pending' || c.status === 'moreinfo')" class="ev-form">
          <input v-model.trim="evText[c.id]" maxlength="200"
                 :placeholder="c.status === 'moreinfo' ? '按复核意见补充材料…' : '补充说明（可选）…'" />
          <button class="mini" :disabled="!evText[c.id]" @click="doEvidence(c)">📎 补证</button>
        </div>

        <!-- 管理员：复核 -->
        <div v-if="store.canManage && (c.status === 'pending' || c.status === 'moreinfo')" class="rv-form">
          <div class="rv-amt">
            核定 <span>🪙</span>
            <input type="number" min="0" :max="store.claimMeta.maxGold" v-model.number="rv[c.id].gold" />
            <span>🧱</span>
            <input type="number" min="0" :max="store.claimMeta.maxMat" v-model.number="rv[c.id].mat" />
          </div>
          <input v-model.trim="rv[c.id].note" maxlength="120" placeholder="复核意见（驳回/要求补证时必填）" />
          <div class="rv-btns">
            <button class="mini green" @click="doReview(c, 'approve')">✅ 批准赔付</button>
            <button class="mini" @click="doReview(c, 'moreinfo')">📎 要求补证</button>
            <button class="mini red" @click="doReview(c, 'reject')">🚫 驳回</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { reactive, computed, watch } from 'vue'
import { useGameStore } from '@/store/game'
const store = useGameStore()

const form = reactive({ eventId: null, category: 'crop', gold: 0, mat: 0, note: '' })
const evText = reactive({}) // 每张申报单的补证输入
const rv = reactive({})     // 每张申报单的复核输入（核定金额 + 意见）

// 待复核的申报单预填核定金额（默认按申请额），供管理员调整后批准
watch(() => store.claims, (list) => {
  for (const c of list) {
    if ((c.status === 'pending' || c.status === 'moreinfo') && !rv[c.id]) {
      rv[c.id] = { gold: c.amount_gold, mat: c.amount_mat, note: '' }
    }
  }
}, { immediate: true })

const canSubmit = computed(() =>
  store.can('claimSubmit') && form.eventId && form.category &&
  (Number(form.gold) > 0 || Number(form.mat) > 0) && form.note.length > 0
)

function catOf(c) {
  return store.claimMeta.cats[c.category] || { name: c.category, icon: '❓' }
}
function statusLabel(s) {
  return store.claimMeta.status[s] || s
}
function isMine(c) {
  return c.created_by === store.user?.id
}
function fmtTime(at) {
  return at ? new Date(at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''
}
function rvOf(c) {
  if (!rv[c.id]) rv[c.id] = { gold: c.amount_gold, mat: c.amount_mat, note: '' }
  return rv[c.id]
}

async function doSubmit() {
  const r = await store.submitClaim({ ...form })
  if (r) { form.eventId = null; form.gold = 0; form.mat = 0; form.note = '' }
}
async function doEvidence(c) {
  const r = await store.addClaimEvidence(c.id, evText[c.id])
  if (r) evText[c.id] = ''
}
async function doReview(c, action) {
  const v = rvOf(c)
  if ((action === 'reject' || action === 'moreinfo') && !v.note) {
    store.showToast(action === 'reject' ? '请填写驳回原因' : '请说明需要补充的材料', 'warn')
    return
  }
  await store.reviewClaim(c.id, action, v.note, v.gold, v.mat)
}
</script>

<style scoped>
.page { display:grid;grid-template-columns:1fr 1fr;gap:16px; }
@media(max-width:760px){ .page{grid-template-columns:1fr;} }
.pcol { display:flex;flex-direction:column;gap:2px; }
.card { background:#0f1b38;border:1px solid rgba(120,160,220,0.16);border-radius:12px;padding:16px; }
h4 { margin:0 0 8px;color:#fff;display:flex;gap:8px;align-items:center; }
.tag { font-size:10px;color:#6f84ab;background:#16263f;padding:2px 6px;border-radius:4px; }
.tag.tip { color:#6f84ab; }
.tag.ask { color:#ffd54f;background:#2d2814; }
.hint { color:#5b6f94;font-size:11px;margin:0 0 10px;line-height:1.6; }
.perm-hint { color:#ef9a9a;font-size:11px;margin:6px 0 0; }
.f-label { color:#8ba2c8;font-size:11px;margin:8px 0 4px; }
.f-select, textarea, input {
  background:#0c1730;border:1px solid rgba(120,160,220,0.25);border-radius:8px;
  color:#dbe4f3;padding:8px 10px;font-size:12px;width:100%;box-sizing:border-box;
}
textarea { resize:vertical;font-family:inherit; }
.cat-pick { display:flex;gap:6px; }
.cat-pick button {
  flex:1;background:#16263f;border:1px solid rgba(120,160,220,0.2);border-radius:8px;
  color:#aebadd;padding:8px 4px;font-size:12px;cursor:pointer;
}
.cat-pick button.on { background:linear-gradient(135deg,#1d3f8f,#2962ff);color:#fff;border-color:transparent; }
.amt-row { display:flex;align-items:center;gap:6px; }
.amt-row span { font-size:15px; }
.wide { width:100%;margin-top:12px;background:#16263f;border:1px solid rgba(255,213,79,0.3);color:#ffd54f;border-radius:9px;padding:10px;font-size:13px;cursor:pointer; }
.wide.start { background:linear-gradient(135deg,#e65100,#f57c00);color:#fff;border-color:transparent; }
.wide:disabled { background:#2a3a5e;color:#6f84ab;cursor:not-allowed;border-color:transparent; }
.none { color:#5b6f94;text-align:center;padding:20px;font-size:12px; }
/* 申报单 */
.claim { padding:10px 0;border-bottom:1px dashed rgba(120,160,220,0.1); }
.claim:last-child { border-bottom:none; }
.claim.rejected { opacity:.62; }
.cl-head { display:flex;align-items:center;gap:8px; }
.cl-head b { color:#e8eefb;font-size:13px;flex:1; }
.cl-state { font-size:10px;padding:2px 8px;border-radius:4px;white-space:nowrap; }
.cl-state.pending { color:#90caf9;background:#122a47; }
.cl-state.moreinfo { color:#ffcc80;background:#3a2a12; }
.cl-state.approved { color:#a5d6a7;background:#1b3a21; }
.cl-state.rejected { color:#8ba2c8;background:#23304a; }
.cl-meta { display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:5px 0; }
.creator { font-size:10px;color:#8ba2c8;white-space:nowrap; }
.live-dot { display:inline-block;width:6px;height:6px;border-radius:50%;background:#4a5a78;margin-left:3px;vertical-align:middle; }
.live-dot.on { background:#66bb6a;box-shadow:0 0 4px #66bb6a; }
.cl-note { color:#c6d2e6;font-size:12px;margin:4px 0; }
.ev-list { background:#0c1730;border-radius:8px;padding:6px 10px;margin:6px 0; }
.ev-item { font-size:11px;color:#8ba2c8;padding:2px 0; }
.ev-item b { color:#c6d2e6; }
.ev-item em { font-style:normal;color:#5b6f94;margin-left:6px;font-size:10px; }
.cl-review { font-size:11px;margin:4px 0;color:#ffcc80; }
.cl-review.approved { color:#a5d6a7; }
.cl-review.rejected { color:#ef9a9a; }
.ev-form { display:flex;gap:6px;margin-top:6px; }
.ev-form input { flex:1; }
.rv-form { background:#0c1730;border:1px dashed rgba(120,160,220,0.25);border-radius:8px;padding:8px;margin-top:8px;display:flex;flex-direction:column;gap:6px; }
.rv-amt { display:flex;align-items:center;gap:6px;font-size:11px;color:#8ba2c8; }
.rv-amt input { width:70px; }
.rv-btns { display:flex;gap:6px; }
.mini { background:#2962ff;border:none;color:#fff;border-radius:7px;padding:6px 10px;font-size:12px;cursor:pointer; }
.mini.green { background:#43a047; }
.mini.red { background:#c62828; }
.mini:disabled { background:#2a3a5e;color:#6f84ab;cursor:not-allowed; }
</style>
