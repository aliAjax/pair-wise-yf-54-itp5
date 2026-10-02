import { defineStore } from 'pinia';

export type Stage = 'arrival' | 'install' | 'return';
export type CheckStatus = 'pending' | 'passed' | 'issue';
export type Role = '保管员' | '借展方';

export interface Attachment { id: string; name: string; spec?: string; }
export interface Signature { role: Role; at: number; }
export interface HandoverRecord {
  id: string;
  stage: Stage;
  attachments: Attachment[];
  signatures: Signature[];
  /** 来源标注：历史数据补录等 */
  source?: string;
  /** 归还阶段是否已执行对账 */
  reconciled?: boolean;
  createdAt: number;
}
export interface Exhibit {
  id: string;
  code: string;
  name: string;
  lender: string;
  hall: string;
  stage: Stage;
  status: CheckStatus;
  /** 兼容历史数据的全局签字角色集合 */
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
  /** 是否由归还对账生成（便于重复对账时清理） */
  fromReconciliation?: boolean;
}
interface State {
  exhibits: Exhibit[];
  discrepancies: Discrepancy[];
  queued: number;
  currentRole: Role;
  notice: string | null;
}

export const STAGES: Stage[] = ['arrival', 'install', 'return'];

export function stageLabel(stage: Stage): string {
  return { arrival: '到场点交', install: '布展核验', return: '闭展归还' }[stage];
}

/** 历史数据补录时使用的默认附件基线 */
function defaultAttachments(): Attachment[] {
  return [
    { id: 'att-body', name: '文物本体' },
    { id: 'att-seal', name: '封条', spec: 'FT-001' },
    { id: 'att-list', name: '附件清单' },
    { id: 'att-box', name: '包装箱' }
  ];
}

function createHandover(stage: Stage, source?: string): HandoverRecord {
  return {
    id: `h-${stage}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    stage,
    attachments: [],
    signatures: [],
    source,
    createdAt: Date.now()
  };
}

function ensureHandover(exhibit: Exhibit, stage: Stage): HandoverRecord {
  let record = exhibit.handovers.find((h) => h.stage === stage);
  if (!record) {
    record = createHandover(stage);
    exhibit.handovers.push(record);
  }
  return record;
}

const seed: State = {
  exhibits: Array.from({ length: 24 }, (_, index) => ({
    id: `ex-${index + 1}`,
    code: `M${String(index + 1).padStart(3, '0')}`,
    name: ['青铜镜', '釉里红瓷瓶', '石雕佛首', '手抄经卷', '鎏金香炉'][index % 5] + ` ${index + 1}`,
    lender: index % 2 ? '西北博物馆' : '私人借展方',
    hall: index % 3 === 0 ? 'A2 温湿展柜' : 'B1 开放展区',
    stage: index < 8 ? 'arrival' : index < 18 ? 'install' : 'return',
    status: index === 4 ? 'issue' : index < 10 ? 'passed' : 'pending',
    signed: index < 5 ? ['保管员', '借展方'] : index < 10 ? ['保管员'] : [],
    environment: { temperature: 20 + index % 3, humidity: 48 + index % 8, light: 120 + index * 3 },
    handovers: []
  })),
  discrepancies: [
    { id: 'd1', exhibitId: 'ex-5', title: '封条编号与交接单不一致', severity: 'major', resolved: false },
    { id: 'd2', exhibitId: 'ex-7', title: '木箱边角轻微磕碰', severity: 'minor', resolved: false }
  ],
  queued: 0,
  currentRole: '保管员',
  notice: null
};

function load(): State {
  const saved = localStorage.getItem('yf54-exhibition-state');
  const state: State = saved ? (JSON.parse(saved) as State) : seed;
  if (!state.currentRole) state.currentRole = '保管员';
  state.notice = null;
  // 历史数据兼容：为没有交接记录的展品补录标注来源的初始记录，原有签字和阶段保留。
  for (const exhibit of state.exhibits) {
    if (!exhibit.handovers || exhibit.handovers.length === 0) {
      exhibit.handovers = [];
      const record = createHandover(exhibit.stage, '历史数据补录');
      record.attachments = defaultAttachments();
      record.signatures = (exhibit.signed || [])
        .filter((r): r is Role => r === '保管员' || r === '借展方')
        .map((role) => ({ role, at: Date.now() }));
      exhibit.handovers.push(record);
      // 闭展归还的展品需要到场记录作为对账基准，补一条到场基线（同样标注来源）。
      if (exhibit.stage === 'return' && !exhibit.handovers.some((h) => h.stage === 'arrival')) {
        const arrival = createHandover('arrival', '历史数据补录');
        arrival.attachments = defaultAttachments();
        exhibit.handovers.unshift(arrival);
      }
    }
  }
  return state;
}

export const useExhibitionStore = defineStore('exhibition', {
  state: () => load(),
  getters: {
    unresolved: (state) => state.discrepancies.filter((item) => !item.resolved).length,
    stageCounts: (state) => ({
      arrival: state.exhibits.filter((item) => item.stage === 'arrival').length,
      install: state.exhibits.filter((item) => item.stage === 'install').length,
      return: state.exhibits.filter((item) => item.stage === 'return').length
    }),
    handoverByStage: (state) => (id: string, stage: Stage) => {
      const exhibit = state.exhibits.find((item) => item.id === id);
      return exhibit?.handovers.find((h) => h.stage === stage);
    }
  },
  actions: {
    persist() { localStorage.setItem('yf54-exhibition-state', JSON.stringify(this.$state)); },
    markQueued() { this.queued += 1; this.persist(); },
    setRole(role: Role) { this.currentRole = role; this.notice = null; },
    setCondition(id: string, status: CheckStatus) {
      const exhibit = this.exhibits.find((item) => item.id === id);
      if (exhibit) { exhibit.status = status; this.markQueued(); }
    },
    sign(id: string, role: Role) {
      const exhibit = this.exhibits.find((item) => item.id === id);
      if (!exhibit) return;
      // 签字鉴权：只有对应角色本人能签，越权当场拒绝。
      if (this.currentRole !== role) {
        this.notice = `越权拒绝：当前操作角色为「${this.currentRole}」，不能代「${role}」签字。签字只能由对应角色本人完成。`;
        return;
      }
      // 签字按阶段独立：同一角色在当前阶段已签过则跳过。
      const record = ensureHandover(exhibit, exhibit.stage);
      if (record.signatures.some((s) => s.role === role)) return;
      record.signatures.push({ role, at: Date.now() });
      // 同步全局签字集合以兼容历史数据。
      if (!exhibit.signed.includes(role)) exhibit.signed.push(role);
      this.notice = null;
      this.markQueued();
    },
    advance(id: string) {
      const exhibit = this.exhibits.find((item) => item.id === id);
      if (!exhibit) return;
      const current = ensureHandover(exhibit, exhibit.stage);
      if (!current.signatures.some((s) => s.role === '借展方')) {
        this.notice = `当前${stageLabel(exhibit.stage)}阶段缺少借展方签字，不能推进。`;
        return;
      }
      if (this.discrepancies.some((item) => item.exhibitId === id && !item.resolved)) {
        this.notice = '存在未解决差异项，不能推进。';
        return;
      }
      const next: Stage = exhibit.stage === 'arrival' ? 'install' : exhibit.stage === 'install' ? 'return' : 'return';
      if (next === exhibit.stage) return;
      ensureHandover(exhibit, next);
      exhibit.stage = next;
      this.notice = null;
      this.markQueued();
    },
    addAttachment(id: string, stage: Stage, name: string, spec?: string) {
      const exhibit = this.exhibits.find((item) => item.id === id);
      if (!exhibit || !name.trim()) return;
      const record = ensureHandover(exhibit, stage);
      record.attachments.push({
        id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: name.trim(),
        spec: spec?.trim() || undefined
      });
      this.markQueued();
    },
    removeAttachment(id: string, stage: Stage, attachmentId: string) {
      const exhibit = this.exhibits.find((item) => item.id === id);
      if (!exhibit) return;
      const record = exhibit.handovers.find((h) => h.stage === stage);
      if (!record) return;
      record.attachments = record.attachments.filter((a) => a.id !== attachmentId);
      this.markQueued();
    },
    reconcileReturn(id: string) {
      const exhibit = this.exhibits.find((item) => item.id === id);
      if (!exhibit) return;
      if (exhibit.stage !== 'return') {
        this.notice = '请先推进到闭展归还阶段再进行归还对账。';
        return;
      }
      // 清除上一次对账生成的差异项，避免重复。
      this.discrepancies = this.discrepancies.filter((d) => !d.fromReconciliation);
      const arrival = exhibit.handovers.find((h) => h.stage === 'arrival');
      const record = ensureHandover(exhibit, 'return');
      record.reconciled = true;
      const stamp = Date.now();
      if (!arrival) {
        this.discrepancies.push({
          id: `d-${stamp}`, exhibitId: id, title: '到场交接记录缺失，无法对账',
          severity: 'major', resolved: false, fromReconciliation: true
        });
        this.notice = '到场交接记录缺失，已记为差异项并阻止归还确认。';
        this.markQueued();
        return;
      }
      let seq = 0;
      const push = (title: string, severity: 'minor' | 'major') => {
        this.discrepancies.push({ id: `d-${stamp}-${seq++}`, exhibitId: id, title, severity, resolved: false, fromReconciliation: true });
      };
      // 逐项对账：到场有而归还无 → 缺件；同件规格/编号不一致 → 换件。
      for (const att of arrival.attachments) {
        const ret = record.attachments.find((a) => a.name === att.name);
        if (!ret) push(`缺件：${att.name}未随展品归还`, 'major');
        else if (att.spec && ret.spec && att.spec !== ret.spec) {
          push(`换件：${att.name}编号不一致（到场${att.spec} / 归还${ret.spec}）`, 'major');
        }
      }
      // 归还多出的件 → 多件（轻微）。
      for (const att of record.attachments) {
        if (!arrival.attachments.some((a) => a.name === att.name)) {
          push(`多件：${att.name}（到场记录无此件）`, 'minor');
        }
      }
      const unresolved = this.discrepancies.filter((d) => d.exhibitId === id && !d.resolved).length;
      this.notice = unresolved
        ? `对账完成，发现 ${unresolved} 项未解决差异，已阻止归还确认。`
        : '对账完成，账实相符，可以确认归还。';
      this.markQueued();
    },
    confirmReturn(id: string) {
      const exhibit = this.exhibits.find((item) => item.id === id);
      if (!exhibit) return;
      const record = exhibit.handovers.find((h) => h.stage === 'return');
      if (!record || !record.reconciled) { this.notice = '请先完成归还对账。'; return; }
      if (this.discrepancies.some((d) => d.exhibitId === id && !d.resolved)) {
        this.notice = '存在未解决差异项，归还确认被阻止。';
        return;
      }
      if (!record.signatures.some((s) => s.role === '保管员') || !record.signatures.some((s) => s.role === '借展方')) {
        this.notice = '归还交接需保管员与借展方双方签字。';
        return;
      }
      this.notice = '归还确认完成，展品交接闭环。';
      this.markQueued();
    },
    resolveDiscrepancy(id: string) {
      const item = this.discrepancies.find((entry) => entry.id === id);
      if (item) { item.resolved = true; this.markQueued(); }
    },
    addExhibit(payload: Pick<Exhibit, 'code' | 'name' | 'lender' | 'hall'>) {
      this.exhibits.unshift({
        id: `ex-${Date.now()}`,
        ...payload,
        stage: 'arrival',
        status: 'pending',
        signed: [],
        environment: { temperature: 20, humidity: 50, light: 150 },
        handovers: []
      });
      this.markQueued();
    },
    syncQueue() { this.queued = 0; this.persist(); }
  }
});
