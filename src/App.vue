<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { useOnline } from '@vueuse/core';
import { toTypedSchema } from '@vee-validate/zod';
import { useForm } from 'vee-validate';
import { z } from 'zod';
import { api } from './services/api';
import { useExhibitionStore, type ActionResult, type Exhibit, type HandoverRecord, type Role, type Stage, STAGE_ORDER } from './stores/exhibition';

const store = useExhibitionStore();
const online = useOnline();
const tab = ref<'checkin' | 'environment' | 'discrepancy'>('checkin');
const dialog = ref(false);
const selected = ref<Exhibit | null>(null);
const roles: Role[] = ['保管员', '借展方'];
const stageMeta: Record<Stage, { label: string; color: string }> = {
  arrival: { label: '到场点交', color: 'green' },
  install: { label: '布展核验', color: 'orange' },
  return: { label: '闭展归还', color: 'deep-purple' }
};
const draft = reactive<Record<Stage, { code: string; name: string }>>({
  arrival: { code: '', name: '' },
  install: { code: '', name: '' },
  return: { code: '', name: '' }
});
const snackbar = ref(false);
const snackbarColor = ref('green-darken-1');
const message = ref('');

const schema = toTypedSchema(z.object({ code: z.string().min(2), name: z.string().min(2), lender: z.string().min(2), hall: z.string().min(2) }));
const { defineField, errors, handleSubmit, resetForm } = useForm({ validationSchema: schema });
const [code] = defineField('code');
const [name] = defineField('name');
const [lender] = defineField('lender');
const [hall] = defineField('hall');
const apiLabel = computed(() => String(api.defaults.baseURL));

const submit = handleSubmit((values) => { store.addExhibit(values); dialog.value = false; resetForm(); });
function stageLabel(stage: Exhibit['stage']) { return stageMeta[stage].label; }

function notify(result: ActionResult | { ok: boolean; error?: string }) {
  message.value = result.ok ? '操作成功' : (result.error ?? '操作失败');
  snackbarColor.value = result.ok ? 'green-darken-1' : 'red-darken-1';
  snackbar.value = true;
}

function formatTime(value: string | null | undefined) {
  if (!value) return '时间不可考（历史补录）';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function record(stage: Stage): HandoverRecord | undefined {
  return selected.value ? store.recordOf(selected.value, stage) : undefined;
}

function signedRole(record: HandoverRecord | undefined, role: Role) {
  return Boolean(record?.signatures.some((sig) => sig.role === role));
}

function addAttachment(stage: Stage) {
  if (!selected.value) return;
  const result = store.addAttachment(selected.value.id, stage, draft[stage].code, draft[stage].name);
  if (result.ok) { draft[stage].code = ''; draft[stage].name = ''; }
  notify(result);
}

function onSign(stage: Stage, role: Role) {
  if (!selected.value) return;
  notify(store.signHandover(selected.value.id, stage, role));
}

function complete(stage: Stage) {
  if (!selected.value) return;
  notify(store.completeHandover(selected.value.id, stage));
}

function advance() {
  if (!selected.value) return;
  const result = store.advance(selected.value.id);
  notify(result);
}

function reconcile() {
  if (!selected.value) return;
  const result = store.reconcileReturn(selected.value.id);
  if (result.ok) {
    message.value = result.missing || result.swapped
      ? `对账完成：缺件 ${result.missing ?? 0} 件、换件 ${result.swapped ?? 0} 件，已写入差异项并挡住归还确认`
      : '对账完成：到场与归还逐件相符';
    snackbarColor.value = result.missing || result.swapped ? 'red-darken-1' : 'green-darken-1';
    snackbar.value = true;
  } else {
    notify(result);
  }
}

function confirmReturn() {
  if (!selected.value) return;
  notify(store.confirmReturn(selected.value.id));
}

const selectedDiff = computed(() => {
  if (!selected.value || selected.value.stage !== 'return') return null;
  return store.diffReturn(selected.value);
});

const selectedUnresolved = computed(() => {
  if (!selected.value) return [];
  return store.discrepancies.filter((item) => item.exhibitId === selected.value!.id && !item.resolved);
});
</script>

<template>
  <v-app>
    <v-app-bar color="deep-purple-darken-3" flat>
      <v-app-bar-title>{{ $t('title') }}</v-app-bar-title>
      <v-btn-toggle v-model="store.currentRole" mandatory color="white" divided density="compact" class="mr-3" style="--v-theme-on-secondary: #4c1d95;">
        <v-btn value="保管员" size="small">当前角色：保管员</v-btn>
        <v-btn value="借展方" size="small">当前角色：借展方</v-btn>
      </v-btn-toggle>
      <v-chip class="mr-3" :color="online ? 'green' : 'orange'" theme="dark">{{ online ? '在线' : '离线暂存' }}</v-chip>
      <v-btn prepend-icon="mdi-plus" @click="dialog = true">登记展品</v-btn>
    </v-app-bar>
    <v-main class="bg-grey-lighten-4">
      <v-container fluid class="pa-6">
        <v-alert v-if="!online || store.queued" color="orange-lighten-4" icon="mdi-cloud-off-outline" class="mb-5">
          网络不可用时核验不会丢失：当前有 {{ store.queued }} 条变更在本地队列。接口地址 {{ apiLabel }}
          <template #append><v-btn v-if="online" variant="text" @click="store.syncQueue">确认同步</v-btn></template>
        </v-alert>

        <v-row class="mb-5">
          <v-col cols="12" md="3"><v-card><v-card-text><div class="metric-label">待到场点交</div><div class="metric">{{ store.stageCounts.arrival }}</div></v-card-text></v-card></v-col>
          <v-col cols="12" md="3"><v-card><v-card-text><div class="metric-label">布展中</div><div class="metric">{{ store.stageCounts.install }}</div></v-card-text></v-card></v-col>
          <v-col cols="12" md="3"><v-card><v-card-text><div class="metric-label">未解决差异</div><div class="metric warn">{{ store.unresolved }}</div></v-card-text></v-card></v-col>
          <v-col cols="12" md="3"><v-card><v-card-text><div class="metric-label">本地待同步</div><div class="metric">{{ store.queued }}</div></v-card-text></v-card></v-col>
        </v-row>

        <v-card>
          <v-tabs v-model="tab" color="deep-purple">
            <v-tab value="checkin">{{ $t('checkIn') }}</v-tab><v-tab value="environment">{{ $t('environment') }}</v-tab><v-tab value="discrepancy">{{ $t('discrepancies') }}</v-tab>
          </v-tabs>
          <v-window v-model="tab">
            <v-window-item value="checkin">
              <v-virtual-scroll :items="store.exhibits" height="520" item-height="112">
                <template #default="{ item }">
                  <v-list-item :key="item.id" class="exhibit-row" @click="selected = item">
                    <template #prepend><v-avatar color="deep-purple-lighten-4">{{ item.code.slice(1) }}</v-avatar></template>
                    <v-list-item-title>{{ item.name }} · {{ item.code }}</v-list-item-title>
                    <v-list-item-subtitle>{{ item.lender }} · {{ item.hall }} · {{ stageLabel(item.stage) }}</v-list-item-subtitle>
                    <template #append>
                      <v-chip size="small" :color="item.status === 'issue' ? 'red' : item.status === 'passed' ? 'green' : 'grey'">{{ item.status }}</v-chip>
                    </template>
                  </v-list-item>
                </template>
              </v-virtual-scroll>
            </v-window-item>
            <v-window-item value="environment">
              <v-table>
                <thead><tr><th>展品</th><th>温度</th><th>湿度</th><th>照度</th><th>条件</th></tr></thead>
                <tbody><tr v-for="item in store.exhibits" :key="item.id"><td>{{ item.code }}</td><td>{{ item.environment.temperature }}℃</td><td>{{ item.environment.humidity }}%</td><td>{{ item.environment.light }} lux</td><td><v-btn size="small" color="green" variant="text" @click="store.setCondition(item.id, 'passed')">通过</v-btn><v-btn size="small" color="red" variant="text" @click="store.setCondition(item.id, 'issue')">异常</v-btn></td></tr></tbody>
              </v-table>
            </v-window-item>
            <v-window-item value="discrepancy">
              <v-list><v-list-item v-for="item in store.discrepancies" :key="item.id">
                <v-list-item-title>{{ item.title }}</v-list-item-title>
                <v-list-item-subtitle>
                  展品 {{ item.exhibitId }} · {{ item.kind === 'return-missing' ? '归还缺件' : item.kind === 'return-swapped' ? '归还换件' : item.severity === 'major' ? '重大差异' : '轻微差异' }}
                  <template v-if="item.detail"> · {{ item.detail }}</template>
                </v-list-item-subtitle>
                <template #append><v-btn :disabled="item.resolved" color="green" @click="store.resolveDiscrepancy(item.id)">{{ item.resolved ? '已解决' : '确认解决' }}</v-btn></template>
              </v-list-item></v-list>
            </v-window-item>
          </v-window>
        </v-card>

        <v-dialog v-model="dialog" max-width="560">
          <v-card title="登记新展品">
            <v-card-text><v-form @submit.prevent="submit"><v-text-field v-model="code" label="展品编号" :error-messages="errors.code" /><v-text-field v-model="name" label="展品名称" :error-messages="errors.name" /><v-text-field v-model="lender" label="借展方" :error-messages="errors.lender" /><v-text-field v-model="hall" label="展厅/柜位" :error-messages="errors.hall" /><v-btn type="submit" color="deep-purple" block>写入点交队列</v-btn></v-form></v-card-text>
          </v-card>
        </v-dialog>

        <v-dialog :model-value="Boolean(selected)" max-width="860" @update:model-value="selected = null">
          <v-card v-if="selected" :title="`${selected.code} · ${selected.name}`">
            <v-card-text>
              <v-alert v-if="selectedUnresolved.length" type="error" density="compact" class="mb-3">
                本展品有 {{ selectedUnresolved.length }} 条未解决差异，阶段推进/归还确认将被挡住。
              </v-alert>

              <v-row>
                <v-col v-for="stage in STAGE_ORDER" :key="stage" cols="12" md="4">
                  <v-card :loading="false" variant="tonal" :color="stage === selected.stage ? stageMeta[stage].color + '-lighten-5' : 'grey-lighten-4'">
                    <v-card-text class="handover-card">
                      <div class="d-flex align-center mb-2">
                        <strong>{{ stageMeta[stage].label }}</strong>
                        <v-chip v-if="record(stage)?.source === '历史补录'" size="x-small" color="amber-lighten-2" class="ml-2">历史补录</v-chip>
                        <v-chip v-else-if="record(stage)" size="x-small" color="blue-lighten-3" class="ml-2">现场交接</v-chip>
                      </div>

                      <template v-if="record(stage)">
                        <div class="attachment-box">
                          <div v-if="!record(stage)!.attachments.length" class="muted">暂无附件记录</div>
                          <v-chip v-for="attachment in record(stage)!.attachments" :key="attachment.id" size="small" class="mr-1 mb-1" :closable="stage === selected.stage && !record(stage)!.handoverAt" @click:close="store.removeAttachment(selected.id, stage, attachment.id)">
                            {{ attachment.name }} · {{ attachment.code }}
                          </v-chip>
                        </div>
                        <v-row v-if="stage === selected.stage && !record(stage)!.handoverAt" dense class="mt-1">
                          <v-col cols="5"><v-text-field v-model="draft[stage].code" label="附件/封条编号" density="compact" hide-details /></v-col>
                          <v-col cols="4"><v-text-field v-model="draft[stage].name" label="附件名称" density="compact" hide-details /></v-col>
                          <v-col cols="3" class="d-flex align-center"><v-btn size="small" variant="tonal" color="primary" block @click="addAttachment(stage)">登记附件</v-btn></v-col>
                        </v-row>

                        <v-divider class="my-2" />
                        <div v-for="role in roles" :key="role" class="d-flex align-center justify-space-between py-1">
                          <v-chip size="small" :color="signedRole(record(stage), role) ? 'green' : 'grey-lighten-2'" :variant="signedRole(record(stage), role) ? 'flat' : 'tonal'">
                            {{ role }}{{ signedRole(record(stage), role) ? '已签' : '未签' }}
                          </v-chip>
                          <span class="sign-time">
                            {{ formatTime(record(stage)!.signatures.find((sig) => sig.role === role)?.signedAt) }}
                          </span>
                          <v-btn
                            size="x-small"
                            :variant="signedRole(record(stage), role) ? 'outlined' : 'flat'"
                            :color="signedRole(record(stage), role) ? 'red' : 'primary'"
                            :disabled="Boolean(record(stage)!.handoverAt)"
                            @click="onSign(stage, role)"
                          >{{ signedRole(record(stage), role) ? '撤签' : `${role}签字` }}</v-btn>
                        </div>
                        <div class="muted mt-1">
                          交接完成：{{ formatTime(record(stage)!.handoverAt) === '时间不可考（历史补录）' ? '—' : formatTime(record(stage)!.handoverAt) }}
                        </div>

                        <template v-if="stage === selected.stage && !record(stage)!.handoverAt">
                          <v-btn v-if="stage !== 'return'" size="small" block class="mt-2" color="green" variant="tonal" @click="complete(stage)">
                            双方签字齐备后完成本阶段交接
                          </v-btn>
                          <template v-else>
                            <v-btn size="small" block class="mt-2" color="orange" variant="tonal" @click="reconcile">
                              与到场记录逐项对账
                            </v-btn>
                            <v-btn size="small" block class="mt-2" color="deep-purple" variant="tonal" @click="confirmReturn">
                              归还确认（缺件/换件未清不可确认）
                            </v-btn>
                          </template>
                        </template>
                      </template>
                      <div v-else class="muted">该阶段尚未发生交接</div>
                    </v-card-text>
                  </v-card>
                </v-col>
              </v-row>

              <div v-if="selectedDiff" class="diff-panel pa-3 mt-2">
                <strong>归还对账（以到场记录为基线）：</strong>
                到场 {{ selectedDiff.baseline.length }} 件，归还 {{ selectedDiff.actual.length }} 件，
                <span :class="selectedDiff.missing.length ? 'text-red' : 'text-green'">缺件 {{ selectedDiff.missing.length }}</span> /
                <span :class="selectedDiff.swapped.length ? 'text-red' : 'text-green'">换件 {{ selectedDiff.swapped.length }}</span>
                <div v-if="selectedDiff.missing.length || selectedDiff.swapped.length" class="text-red text-caption">
                  存在差异项时归还确认已被拦截，请先在“差异项”页处理。
                </div>
              </div>

              <div v-if="selected.stage !== 'return'" class="text-center mt-4">
                <v-btn color="deep-purple" prepend-icon="mdi-arrow-right" @click="advance">推进到下一阶段</v-btn>
                <div class="muted mt-1">当前阶段交接未完成或有未解决差异时不能推进。</div>
              </div>
            </v-card-text>
          </v-card>
        </v-dialog>
      </v-container>
    </v-main>

    <v-snackbar v-model="snackbar" :color="snackbarColor" timeout="3500">{{ message }}</v-snackbar>
  </v-app>
</template>

<style>
.metric-label { color: #6b7280; font-size: 13px; }
.metric { font-size: 31px; font-weight: 750; color: #4c1d95; }
.metric.warn { color: #b91c1c; }
.exhibit-row { border-bottom: 1px solid #eee; cursor: pointer; }
.muted { color: #9ca3af; font-size: 12px; }
.sign-time { color: #6b7280; font-size: 11px; flex: 1; margin: 0 8px; text-align: right; }
.attachment-box { min-height: 32px; }
.handover-card { font-size: 13px; }
.diff-panel { background: #f5f3ff; border-radius: 8px; font-size: 13px; }
.text-caption { font-size: 12px; }
</style>
