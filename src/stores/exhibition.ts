import { defineStore } from 'pinia';

export type Stage = 'arrival' | 'install' | 'return';
export type CheckStatus = 'pending' | 'passed' | 'issue';
// 签字角色：保管员（馆方）与借展方，互不能代签
export type Role = '保管员' | '借展方';
export type HandoverSource = '现场交接' | '历史补录';
export type DiscrepancyKind = 'general' | 'return-missing' | 'return-swapped';

/** 到场点交时随件清点的附件（配件、封条、底座、证书等） */
export interface HandoverAttachment {
  id: string;
  /** 附件/封条编号，是逐件对账时的身份依据 */
  code: string;
  name: string;
}

export interface HandoverSignature {
  role: Role;
  /** 历史补录的签字时间不可考，保留角色但时间记 null */
  signedAt: string | null;
}

/** 每个阶段（到场/布展/归还）各留存一条交接记录 */
export interface HandoverRecord {
  stage: Stage;
  source: HandoverSource;
  attachments: HandoverAttachment[];
  signatures: HandoverSignature[];
  /** 交接完成时间；非空即锁定，附件与签字都不能再改 */
  handoverAt: string | null;
}

export interface Exhibit {
  id: string;
  code: string;
  name: string;
  lender: string;
  hall: string;
  stage: Stage;
  status: CheckStatus;
  /** 兼容字段：各阶段签字角色的并集，签字时同步维护 */
  signed: string[];
  environment: { temperature: number; humidity: number; light: number };
  handovers: HandoverRecord[];
}

export interface Discrepancy {
  id: string;
  exhibitId: string;
  title: string;
  severity: 'minor' | 'major';
  resolved: boolean;
  kind: DiscrepancyKind;
  detail?: string;
}

interface State {
  exhibits: Exhibit[];
  discrepancies: Discrepancy[];
  queued: number;
  /** 当前操作人角色，签字时据此做越权校验 */
  currentRole: Role;
}

/** 旧版本数据：没有 handovers，签字只有角色字符串数组 */
interface LegacyExhibit extends Omit<Exhibit, 'handovers'> { handovers?: HandoverRecord[]; }
interface LegacyState { exhibits: LegacyExhibit[]; discrepancies: Array<Omit<Discrepancy, 'kind'> & { kind?: DiscrepancyKind }>; queued?: number; currentRole?: Role; }

// 种子数据保持旧结构，首次加载时由 migrate 补录初始交接记录
const seed: LegacyState = {
  exhibits: Array.from({ length: 24 }, (_, index) => ({
    id: `ex-${index + 1}`,
    code: `M${String(index + 1).padStart(3, '0')}`,
    name: ['青铜镜', '釉里红瓷瓶', '石雕佛首', '手抄经卷', '鎏金香炉'][index % 5] + ` ${index + 1}`,
    lender: index % 2 ? '西北博物馆' : '私人借展方',
    hall: index % 3 === 0 ? 'A2 温湿展柜' : 'B1 开放展区',
    stage: (index < 8 ? 'arrival' : index < 18 ? 'install' : 'return') as Stage,
    status: index === 4 ? 'issue' : index < 10 ? 'passed' : 'pending',
    signed: index < 5 ? ['保管员', '借展方'] : index < 10 ? ['保管员'] : [],
    environment: { temperature: 20 + index % 3, humidity: 48 + index % 8, light: 120 + index * 3 }
  })),
  discrepancies: [
    { id: 'd1', exhibitId: 'ex-5', title: '封条编号与交接单不一致', severity: 'major', resolved: false },
    { id: 'd2', exhibitId: 'ex-7', title: '木箱边角轻微磕碰', severity: 'minor', resolved: false }
  ],
  queued: 0
};

export const STAGE_ORDER: Stage[] = ['arrival', 'install', 'return'];

/**
 * 历史数据升级：
 * 旧展品没有交接记录时，按当前所处阶段补一条“历史补录”初始记录，
 * 原有签字角色原样保留（时间不可考记 null），stage 与 signed 均不改动。
 */
function migrate(raw: LegacyState): State {
  const state = raw as unknown as State;
  if (!state.currentRole) state.currentRole = '保管员';
  if (typeof state.queued !== 'number') state.queued = 0;
  for (const exhibit of state.exhibits) {
    if (!Array.isArray(exhibit.handovers) || exhibit.handovers.length === 0) {
      exhibit.handovers = [{
        stage: exhibit.stage,
        source: '历史补录',
        attachments: [],
        signatures: (exhibit.signed ?? []).map((role) => ({ role: role as Role, signedAt: null })),
        handoverAt: null
      }];
    }
    // 反向兜底：signed 缺失时从交接记录恢复，保证原有签字不丢
    if (!Array.isArray(exhibit.signed)) {
      exhibit.signed = [...new Set(exhibit.handovers.flatMap((record) => record.signatures.map((sig) => sig.role)))];
    }
  }
  for (const item of state.discrepancies) {
    if (!item.kind) item.kind = 'general';
  }
  return state;
}

function load(): State {
  const saved = localStorage.getItem('yf54-exhibition-state');
  if (saved) {
    try {
      return migrate(JSON.parse(saved) as LegacyState);
    } catch {
      // 损坏的存档不影响使用，回落到种子并重新迁移
    }
  }
  return migrate(structuredClone(seed));
}

let seq = 0;
function nextId(prefix: string) {
  seq += 1;
  return `${prefix}-${Date.now()}-${seq}`;
}

export interface ActionResult { ok: boolean; error?: string; }

export const useExhibitionStore = defineStore('exhibition', {
  state: (): State => load(),
  getters: {
    unresolved: (state) => state.discrepancies.filter((item) => !item.resolved).length,
    stageCounts: (state) => ({ arrival: state.exhibits.filter((item) => item.stage === 'arrival').length, install: state.exhibits.filter((item) => item.stage === 'install').length, return: state.exhibits.filter((item) => item.stage === 'return').length })
  },
  actions: {
    persist() { localStorage.setItem('yf54-exhibition-state', JSON.stringify(this.$state)); },
    markQueued() { this.queued += 1; this.persist(); },
    setRole(role: Role) { this.currentRole = role; },

    recordOf(exhibit: Exhibit, stage: Stage): HandoverRecord | undefined {
      return exhibit.handovers.find((record) => record.stage === stage);
    },

    /** 归还对账：以到场记录为基线，逐项比对归还附件，缺件/换件落差异项 */
    diffReturn(exhibit: Exhibit) {
      const baseline = this.recordOf(exhibit, 'arrival')?.attachments ?? [];
      const actual = this.recordOf(exhibit, 'return')?.attachments ?? [];
      const missing = baseline.filter((expected) => !actual.some((item) => item.code === expected.code));
      const swapped = actual.filter((item) => {
        const expected = baseline.find((entry) => entry.code === item.code);
        // 清单外的件，或同编号但名称对不上，都视为换件
        return !expected || expected.name !== item.name;
      });
      return { baseline, actual, missing, swapped };
    },

    setCondition(id: string, status: CheckStatus) { const exhibit = this.exhibits.find((item) => item.id === id); if (exhibit) { exhibit.status = status; this.markQueued(); } },

    addAttachment(id: string, stage: Stage, code: string, name: string): ActionResult {
      const exhibit = this.exhibits.find((item) => item.id === id);
      const record = exhibit && this.recordOf(exhibit, stage);
      if (!exhibit || !record) return { ok: false, error: '该阶段还没有交接记录' };
      if (exhibit.stage !== stage) return { ok: false, error: '只能登记当前阶段的附件' };
      if (record.handoverAt) return { ok: false, error: '交接已完成，记录锁定' };
      const trimmedCode = code.trim();
      if (!trimmedCode || !name.trim()) return { ok: false, error: '附件编号和名称都要填写' };
      if (record.attachments.some((item) => item.code === trimmedCode)) return { ok: false, error: '附件编号已存在' };
      record.attachments.push({ id: nextId('att'), code: trimmedCode, name: name.trim() });
      this.markQueued();
      return { ok: true };
    },

    removeAttachment(id: string, stage: Stage, attachmentId: string): ActionResult {
      const exhibit = this.exhibits.find((item) => item.id === id);
      const record = exhibit && this.recordOf(exhibit, stage);
      if (!exhibit || !record) return { ok: false, error: '该阶段还没有交接记录' };
      if (record.handoverAt) return { ok: false, error: '交接已完成，记录锁定' };
      record.attachments = record.attachments.filter((item) => item.id !== attachmentId);
      this.markQueued();
      return { ok: true };
    },

    /**
     * 签字/撤签：只有对应角色本人能改自己那条签字。
     * 借展方替保管员签（或反向）当场拒绝。
     */
    signHandover(id: string, stage: Stage, role: Role): ActionResult {
      const exhibit = this.exhibits.find((item) => item.id === id);
      const record = exhibit && this.recordOf(exhibit, stage);
      if (!exhibit || !record) return { ok: false, error: '该阶段还没有交接记录' };
      if (this.currentRole !== role) {
        return { ok: false, error: `已当场拒绝：${this.currentRole}不能替${role}签字` };
      }
      if (record.handoverAt) return { ok: false, error: '交接已完成，签字锁定' };
      const existing = record.signatures.find((sig) => sig.role === role);
      if (existing) {
        record.signatures = record.signatures.filter((sig) => sig.role !== role);
      } else {
        record.signatures.push({ role, signedAt: new Date().toISOString() });
      }
      // 同步维护兼容字段：各阶段签字角色的并集
      exhibit.signed = [...new Set(exhibit.handovers.flatMap((entry) => entry.signatures.map((sig) => sig.role)))];
      this.markQueued();
      return { ok: true };
    },

    /** 完成到场/布展阶段交接：双方签字齐备后锁定 */
    completeHandover(id: string, stage: Stage): ActionResult {
      const exhibit = this.exhibits.find((item) => item.id === id);
      const record = exhibit && this.recordOf(exhibit, stage);
      if (!exhibit || !record) return { ok: false, error: '该阶段还没有交接记录' };
      if (exhibit.stage !== stage) return { ok: false, error: '该阶段已结束' };
      if (record.handoverAt) return { ok: false, error: '交接已完成' };
      const roles = record.signatures.map((sig) => sig.role);
      if (!roles.includes('保管员') || !roles.includes('借展方')) {
        return { ok: false, error: '保管员与借展方双方签字齐备后才能完成交接' };
      }
      record.handoverAt = new Date().toISOString();
      this.markQueued();
      return { ok: true };
    },

    /**
     * 闭展归还逐项对账：
     * 先清掉本展品上一轮自动生成且未解决的归还差异，再按当前附件重新生成。
     */
    reconcileReturn(id: string): ActionResult & { missing?: number; swapped?: number } {
      const exhibit = this.exhibits.find((item) => item.id === id);
      if (!exhibit || exhibit.stage !== 'return') return { ok: false, error: '只有闭展归还阶段才能对账' };
      this.discrepancies = this.discrepancies.filter(
        (item) => !(item.exhibitId === id && !item.resolved && (item.kind === 'return-missing' || item.kind === 'return-swapped'))
      );
      const { missing, swapped } = this.diffReturn(exhibit);
      for (const attachment of missing) {
        this.discrepancies.push({
          id: nextId('d'),
          exhibitId: id,
          kind: 'return-missing',
          severity: 'major',
          resolved: false,
          title: `归还缺件：${attachment.name}（${attachment.code}）`,
          detail: `到场清单有此件，归还清单中未找到编号 ${attachment.code}`
        });
      }
      for (const attachment of swapped) {
        this.discrepancies.push({
          id: nextId('d'),
          exhibitId: id,
          kind: 'return-swapped',
          severity: 'major',
          resolved: false,
          title: `归还换件：${attachment.name}（${attachment.code}）`,
          detail: `归还件与到场记录不符：编号 ${attachment.code} 为清单外件或同编号不同件`
        });
      }
      this.markQueued();
      return { ok: true, missing: missing.length, swapped: swapped.length };
    },

    /** 归还确认：存在缺件/换件差异时一律挡住 */
    confirmReturn(id: string): ActionResult {
      const exhibit = this.exhibits.find((item) => item.id === id);
      if (!exhibit) return { ok: false, error: '展品不存在' };
      const record = this.recordOf(exhibit, 'return');
      if (!record) return { ok: false, error: '归还交接记录尚未建立' };
      if (record.handoverAt) return { ok: false, error: '归还已确认' };
      const roles = record.signatures.map((sig) => sig.role);
      if (!roles.includes('保管员') || !roles.includes('借展方')) {
        return { ok: false, error: '保管员与借展方双方签字齐备后才能确认归还' };
      }
      // 以到场记录为准重新逐件比对，差异未清不允许确认
      const { missing, swapped } = this.diffReturn(exhibit);
      if (missing.length || swapped.length) {
        return { ok: false, error: `对账未通过：缺件 ${missing.length} 件、换件 ${swapped.length} 件，需先处理差异项` };
      }
      record.handoverAt = new Date().toISOString();
      this.markQueued();
      return { ok: true };
    },

    /**
     * 推进到下一阶段：当前阶段交接必须已完成且无未解决差异；
     * 推进时为下一阶段建立交接记录，附件沿用上一阶段实际清点结果。
     */
    advance(id: string): ActionResult {
      const exhibit = this.exhibits.find((item) => item.id === id);
      if (!exhibit) return { ok: false, error: '展品不存在' };
      if (exhibit.stage === 'return') return { ok: false, error: '已到最终阶段' };
      const current = this.recordOf(exhibit, exhibit.stage);
      if (!current?.handoverAt) return { ok: false, error: '请先完成当前阶段交接（双方签字）' };
      if (this.discrepancies.some((item) => item.exhibitId === id && !item.resolved)) {
        return { ok: false, error: '存在未解决差异，不能推进阶段' };
      }
      const nextStage = STAGE_ORDER[STAGE_ORDER.indexOf(exhibit.stage) + 1];
      if (!this.recordOf(exhibit, nextStage)) {
        exhibit.handovers.push({
          stage: nextStage,
          source: '现场交接',
          attachments: current.attachments.map((item) => ({ ...item })),
          signatures: [],
          handoverAt: null
        });
      }
      exhibit.stage = nextStage;
      this.markQueued();
      return { ok: true };
    },

    resolveDiscrepancy(id: string) { const item = this.discrepancies.find((entry) => entry.id === id); if (item) { item.resolved = true; this.markQueued(); } },

    addExhibit(payload: Pick<Exhibit, 'code' | 'name' | 'lender' | 'hall'>) {
      this.exhibits.unshift({
        id: `ex-${Date.now()}`,
        ...payload,
        stage: 'arrival',
        status: 'pending',
        signed: [],
        environment: { temperature: 20, humidity: 50, light: 150 },
        handovers: [{ stage: 'arrival', source: '现场交接', attachments: [], signatures: [], handoverAt: null }]
      });
      this.markQueued();
    },

    syncQueue() { this.queued = 0; this.persist(); }
  }
});
