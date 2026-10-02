<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useOnline } from '@vueuse/core';
import { toTypedSchema } from '@vee-validate/zod';
import { useForm } from 'vee-validate';
import { z } from 'zod';
import { api } from './services/api';
import { useExhibitionStore, stageLabel, STAGES, type Exhibit, type Stage } from './stores/exhibition';

const store = useExhibitionStore();
const online = useOnline();
const tab = ref<'checkin' | 'environment' | 'discrepancy'>('checkin');
const dialog = ref(false);
const selected = ref<Exhibit | null>(null);
const panel = ref<Stage[]>([]);
const newAttName = ref('');
const newAttSpec = ref('');

const schema = toTypedSchema(z.object({ code: z.string().min(2), name: z.string().min(2), lender: z.string().min(2), hall: z.string().min(2) }));
const { defineField, errors, handleSubmit, resetForm } = useForm({ validationSchema: schema });
const [code] = defineField('code');
const [name] = defineField('name');
const [lender] = defineField('lender');
const [hall] = defineField('hall');
const apiLabel = computed(() => String(api.defaults.baseURL));

const submit = handleSubmit((values) => { store.addExhibit(values); dialog.value = false; resetForm(); });

watch(selected, (ex) => {
  panel.value = ex ? [ex.stage] : [];
  newAttName.value = '';
  newAttSpec.value = '';
});

function recordOf(stage: Stage) {
  return selected.value?.handovers.find((h) => h.stage === stage);
}
const signedRoles = computed(() => {
  const rec = recordOf(selected.value?.stage ?? 'arrival');
  return rec ? rec.signatures.map((s) => s.role) : [];
});
const unresolvedReturnDiffs = computed(() =>
  selected.value ? store.discrepancies.filter((d) => d.exhibitId === selected.value!.id && !d.resolved) : []
);

function addAttachment(stage: Stage) {
  if (!selected.value) return;
  store.addAttachment(selected.value.id, stage, newAttName.value, newAttSpec.value);
  newAttName.value = '';
  newAttSpec.value = '';
}
function removeAttachment(stage: Stage, attachmentId: string) {
  if (!selected.value) return;
  store.removeAttachment(selected.value.id, stage, attachmentId);
}
function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
</script>

<template>
  <v-app>
    <v-app-bar color="deep-purple-darken-3" flat>
      <v-app-bar-title>{{ $t('title') }}</v-app-bar-title>
      <v-btn-toggle v-model="store.currentRole" mandatory density="compact" variant="outlined" class="mr-3 role-switch">
        <v-btn value="保管员">保管员</v-btn>
        <v-btn value="借展方">借展方</v-btn>
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
              <v-list><v-list-item v-for="item in store.discrepancies" :key="item.id"><v-list-item-title>{{ item.title }}<v-chip v-if="item.fromReconciliation" size="x-small" color="warning" variant="tonal" class="ml-2">对账</v-chip></v-list-item-title><v-list-item-subtitle>展品 {{ item.exhibitId }} · {{ item.severity === 'major' ? '重大差异' : '轻微差异' }}</v-list-item-subtitle><template #append><v-btn :disabled="item.resolved" color="green" @click="store.resolveDiscrepancy(item.id)">{{ item.resolved ? '已解决' : '确认解决' }}</v-btn></template></v-list-item></v-list>
            </v-window-item>
          </v-window>
        </v-card>

        <v-dialog v-model="dialog" max-width="560">
          <v-card title="登记新展品">
            <v-card-text><v-form @submit.prevent="submit"><v-text-field v-model="code" label="展品编号" :error-messages="errors.code" /><v-text-field v-model="name" label="展品名称" :error-messages="errors.name" /><v-text-field v-model="lender" label="借展方" :error-messages="errors.lender" /><v-text-field v-model="hall" label="展厅/柜位" :error-messages="errors.hall" /><v-btn type="submit" color="deep-purple" block>写入点交队列</v-btn></v-form></v-card-text>
          </v-card>
        </v-dialog>

        <v-dialog :model-value="Boolean(selected)" max-width="820" @update:model-value="selected = null">
          <v-card v-if="selected" :title="`${selected.code} · ${selected.name}`">
            <v-card-text>
              <v-alert v-if="selected.handovers.some((h) => h.source)" type="info" variant="tonal" class="mb-3">
                历史数据：已按当前状态补录标注来源的初始交接记录，原有签字与阶段保留不变。
              </v-alert>

              <v-expansion-panels v-model="panel" multiple>
                <v-expansion-panel v-for="st in STAGES" :key="st" :value="st">
                  <v-expansion-panel-title>
                    <span>{{ stageLabel(st) }}</span>
                    <v-chip v-if="recordOf(st)?.source" size="small" color="info" variant="tonal" class="ml-2">{{ recordOf(st)!.source }}</v-chip>
                    <v-chip v-if="st === 'return' && recordOf(st)?.reconciled" size="small" color="success" variant="tonal" class="ml-2">已对账</v-chip>
                  </v-expansion-panel-title>
                  <v-expansion-panel-text>
                    <div class="text-subtitle-2 mb-1">附件清单</div>
                    <div v-if="recordOf(st)?.attachments?.length" class="mb-2">
                      <v-chip v-for="att in recordOf(st)!.attachments" :key="att.id" class="ma-1" :closable="st === selected!.stage" @click:close="removeAttachment(st, att.id)">
                        {{ att.name }}<template v-if="att.spec"> · {{ att.spec }}</template>
                      </v-chip>
                    </div>
                    <div v-else class="text-disabled mb-2">暂无附件</div>
                    <div v-if="st === selected!.stage" class="d-flex align-center flex-wrap ga-2 mb-3">
                      <v-text-field v-model="newAttName" label="附件名称" density="compact" hide-details class="att-input" />
                      <v-text-field v-model="newAttSpec" label="规格/编号（可选）" density="compact" hide-details class="att-input" />
                      <v-btn size="small" variant="tonal" @click="addAttachment(st)">添加附件</v-btn>
                    </div>

                    <div class="text-subtitle-2 mb-1">签字</div>
                    <div v-if="recordOf(st)?.signatures?.length" class="mb-2">
                      <v-chip v-for="sig in recordOf(st)!.signatures" :key="sig.role" class="ma-1">
                        {{ sig.role }} · {{ formatTime(sig.at) }}
                      </v-chip>
                    </div>
                    <div v-else class="text-disabled mb-2">未签字</div>

                    <template v-if="st === 'return'">
                      <v-btn size="small" color="warning" variant="tonal" class="mt-2" @click="store.reconcileReturn(selected!.id)">归还对账</v-btn>
                      <v-btn size="small" color="success" variant="tonal" class="mt-2 ml-2" @click="store.confirmReturn(selected!.id)">确认归还</v-btn>
                      <v-alert v-if="unresolvedReturnDiffs.length" type="error" variant="tonal" class="mt-3 mb-0">
                        未解决差异 {{ unresolvedReturnDiffs.length }} 项，归还确认已阻止：
                        <ul class="mb-0 mt-1"><li v-for="d in unresolvedReturnDiffs" :key="d.id">{{ d.title }}</li></ul>
                      </v-alert>
                    </template>
                  </v-expansion-panel-text>
                </v-expansion-panel>
              </v-expansion-panels>

              <v-divider class="my-3" />
              <div class="d-flex align-center flex-wrap ga-2">
                <span class="text-subtitle-2">当前操作角色：</span>
                <v-chip size="small" color="deep-purple" variant="tonal">{{ store.currentRole }}</v-chip>
                <v-spacer />
                <v-btn size="small" :disabled="signedRoles.includes('保管员')" @click="store.sign(selected!.id, '保管员')">保管员签字</v-btn>
                <v-btn size="small" :disabled="signedRoles.includes('借展方')" @click="store.sign(selected!.id, '借展方')">借展方签字</v-btn>
                <v-btn size="small" color="deep-purple" @click="store.advance(selected!.id)">推进到下一阶段</v-btn>
              </div>
            </v-card-text>
          </v-card>
        </v-dialog>
      </v-container>
    </v-main>

    <v-snackbar :model-value="Boolean(store.notice)" color="error" timeout="4000" @update:model-value="store.notice = null">
      {{ store.notice }}
    </v-snackbar>
  </v-app>
</template>

<style>
.metric-label { color: #6b7280; font-size: 13px; }
.metric { font-size: 31px; font-weight: 750; color: #4c1d95; }
.metric.warn { color: #b91c1c; }
.exhibit-row { border-bottom: 1px solid #eee; cursor: pointer; }
.role-switch .v-btn { text-transform: none; }
.att-input { max-width: 180px; }
</style>
