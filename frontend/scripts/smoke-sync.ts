/**
 * 离线留痕包三方合并端到端冒烟测试（Node + fake-indexeddb）：
 *   npx tsx scripts/smoke-sync.ts
 * 覆盖：单边并入 / 双边留两版 / 影像归并去重 / 完成度与材料余量重算 /
 *      旧包失效 / 分批写入 / 失败回滚重导 / 待核核定 / 缺修订号回填 / 多卷校验。
 * 说明：scripts 不在 tsconfig 的 include 内，由 tsx 直接转译运行，不做类型检查。
 */
import 'fake-indexeddb/auto';
import { TextDecoder, TextEncoder } from 'util';

(globalThis as { TextEncoder?: unknown }).TextEncoder = TextEncoder;
(globalThis as { TextDecoder?: unknown }).TextDecoder = TextDecoder;

import { DB_NAME, SYNC_STATE_KEY, db } from '../src/utils/db';
import {
  applyMergePlan,
  buildMergePlan,
  listConflicts,
  listPendingRollbacks,
  procedureHash,
  resolveConflict,
  specimenHash,
  supplyHash,
  touchLocalProcEdit,
  type LastSyncBase,
} from '../src/utils/sync/merge';
import { buildExportPacket, readPacketFiles, type ExportBundle } from '../src/utils/sync/packet';
import { digestText } from '../src/utils/hash';
import type { PrepProcedure } from '../src/types/procedure';
import type { PrepPhoto } from '../src/types/photo';
import type { SupplyLot } from '../src/types/supply';
import type { Specimen, SpecimenStatus } from '../src/types/specimen';
import type { SyncPacketPart } from '../src/types/sync';

let passed = 0;
let failed = 0;

function assert(cond: unknown, message: string): asserts cond {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${message}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${message}`);
  }
}

async function resetDb(): Promise<void> {
  db.close();
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('删除数据库被阻塞'));
  });
  await db.open();
}

function makeSpecimen(id: string, no: string, status: SpecimenStatus): Specimen {
  return {
    id,
    specimenNo: no,
    taxon: '测试种',
    horizon: '测试层位',
    locality: '测试产地',
    lithology: '测试岩性',
    matrixHardness: 3,
    dimensions: '100×80×40',
    weight: 500,
    storageBox: '测试匣',
    status,
    createdAt: 1_000_000,
  };
}

function makeProc(over: Partial<PrepProcedure> & { id: string; specimenId: string }): PrepProcedure {
  return {
    stepType: '清修',
    nodeName: '节点',
    seq: 1,
    tools: [],
    abrasive: '',
    adhesive: '',
    adhesiveConc: 0,
    durationMin: 60,
    tempC: 20,
    rh: 50,
    photoBeforeIds: [],
    photoAfterIds: [],
    operator: '甲',
    startedAt: 2_000_000,
    state: 'pending',
    rev: 1,
    updatedAt: 2_000_000,
    ...over,
  };
}

function makePhoto(over: Partial<PrepPhoto> & { id: string; specimenId: string; procedureId: string }): PrepPhoto {
  return {
    stage: 'before',
    caption: '影像',
    dataUrl: 'data:image/svg+xml;utf8,<svg/>',
    capturedAt: 3_000_000,
    ...over,
  };
}

function makeSupply(over: Partial<SupplyLot> & { id: string }): SupplyLot {
  return {
    name: '胶',
    kind: '胶种',
    spec: '规格',
    lotNo: `LOT-${over.id}`,
    qty: 10,
    unit: '瓶',
    openedAt: 1_000_000,
    shelfLifeMonths: 36,
    lowThreshold: 2,
    issues: [],
    ...over,
  };
}

async function importBundle(bundle: ExportBundle) {
  const files = bundle.parts.map((p, i) => new File([JSON.stringify(p)], `part-${i + 1}.json`, { type: 'application/json' }));
  const parsed = await readPacketFiles(files);
  return buildMergePlan(parsed);
}

async function importParts(parts: SyncPacketPart[]) {
  const files = parts.map((p, i) => new File([JSON.stringify(p)], `part-${i + 1}.json`, { type: 'application/json' }));
  const parsed = await readPacketFiles(files);
  return buildMergePlan(parsed);
}

/** 与页面 usePrepProgress 同一口径：普通行 + 每个待核组馆内版 */
function canonicalCount(all: PrepProcedure[]): number {
  const seen = new Set<string>();
  let n = 0;
  for (const p of all) {
    if (p.conflictId) {
      if (seen.has(p.conflictId)) continue;
      seen.add(p.conflictId);
      if (p.conflictSide === 'museum') n += 1;
    } else n += 1;
  }
  return n;
}

function stableStringify(v: unknown): string {
  return JSON.stringify(sortKeys(v));
}
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) o[k] = sortKeys((v as Record<string, unknown>)[k]);
    return o;
  }
  return v;
}

async function reseal(part: SyncPacketPart): Promise<SyncPacketPart> {
  const { checksum: _c, ...rest } = part;
  void _c;
  const { hex } = await digestText(stableStringify(rest));
  return { ...part, checksum: hex };
}

// ---------------------------------------------------------------------------
console.log('\n[1] 首次回包：合作室单边新增直接并入 + 影像归并 + 缺修订号回填');
{
  // 合作室视角建包
  await resetDb();
  await db.specimens.put(makeSpecimen('sp1', 'FP-T-001', '修复中'));
  const coopProc = makeProc({ id: 'p1', specimenId: 'sp1', operator: '合作室技师', nodeName: '粗清' });
  delete coopProc.rev; // 模拟旧数据无修订号
  await db.transaction('rw', db.procedures, db.photos, async () => {
    await db.procedures.put(coopProc);
    await db.photos.put(makePhoto({ id: 'ph1', specimenId: 'sp1', procedureId: 'p1', stage: 'after' }));
  });
  const outgoing = await buildExportPacket({ side: 'coop', deviceName: '合作修复室' });
  assert(outgoing.parts.length === 1, '首次导出为单卷');

  // 馆内空库导入
  await resetDb();
  const plan = await importBundle(outgoing);
  assert(plan.report.proceduresAdded === 1, '合作室新增工序直接并入（1）');
  assert(plan.report.photosAdded === 1, '影像随工序归并（1）');
  await applyMergePlan(plan);

  const saved = await db.procedures.get('p1');
  assert(saved?.rev === 1, '无修订号旧记录按当前值回填 rev=1');
  assert((await db.photos.get('ph1'))?.procedureId === 'p1', '影像挂在并入的工序上');
  assert(saved?.photoAfterIds.includes('ph1'), 'after 影像 id 回写工序修订');
}

// ---------------------------------------------------------------------------
console.log('\n[2] 三方合并：单边新改并入、双边留两版、影像去重挂接、材料余量重算、核定');
{
  const sp1 = makeSpecimen('sp1', 'FP-T-002', '修复中');
  const p1Base = makeProc({ id: 'p1', specimenId: 'sp1', nodeName: '粗清', durationMin: 60 });
  const s1Base = makeSupply({ id: 's1', qty: 10 });

  // 合作室视角：p1 改 done/90；新增 p2；s1 领用 3；p1 挂 after 影像
  await resetDb();
  await db.specimens.put(sp1);
  await db.procedures.put(p1Base);
  await db.supplies.put(s1Base);
  await db.procedures.put(
    makeProc({ id: 'p1', specimenId: 'sp1', nodeName: '粗清', durationMin: 90, state: 'done', finishedAt: 4_200_000, rev: 2, updatedAt: 4_100_000 }),
  );
  await db.procedures.put(makeProc({ id: 'p2', specimenId: 'sp1', nodeName: '细清', seq: 2, operator: '合作室技师', startedAt: 4_000_000 }));
  await db.supplies.put(
    makeSupply({ id: 's1', qty: 7, issues: [{ id: 'i1', qty: 3, operator: '合作室技师', specimenNo: 'FP-T-002', issuedAt: 4_500_000 }] }),
  );
  await db.photos.put(makePhoto({ id: 'ph-after', specimenId: 'sp1', procedureId: 'p1', stage: 'after', capturedAt: 4_600_000 }));
  const coopReturn = await buildExportPacket({ side: 'coop', deviceName: '合作修复室' });

  // 馆内视角：基线数据 + 手写“上次同步基线”（p1=60、s1=10），随后馆内把 p1 改为 75
  await resetDb();
  await db.specimens.put(sp1);
  await db.procedures.put(p1Base);
  await db.supplies.put(s1Base);
  const base: LastSyncBase = {
    mergedAt: 1,
    localProcEditAt: 1000, // 早于回包导出时间 → 回包不是旧包
    proc: { p1: procedureHash(p1Base) },
    supply: { s1: { hash: supplyHash(s1Base), qty: 10 } },
    specimen: { sp1: specimenHash(sp1) },
    recentBatchIds: [],
  };
  await db.syncState.put({ key: SYNC_STATE_KEY, value: base });
  await db.procedures.put(makeProc({ id: 'p1', specimenId: 'sp1', nodeName: '粗清', durationMin: 75, rev: 2, updatedAt: 5_000_000 }));

  const plan = await importBundle(coopReturn);
  assert(plan.isStalePacket === false, '回包导出于馆内改动之后，不是旧包');
  assert(plan.report.proceduresAdded === 1, '合作室单边新增 p2 直接并入');
  assert(plan.report.conflictsCreated === 1, 'p1 两边都动 → 留两版待核');
  assert(plan.report.photosAdded === 1, '合作室 after 影像归并');
  await applyMergePlan(plan);

  const procs = await db.procedures.toArray();
  assert(!!procs.find((p) => p.id === 'p2' && p.operator === '合作室技师'), 'p2 已并入');
  assert(canonicalCount(procs) === 2, '完成度口径节点数为 2（待核 p1 按馆内版计一次，不重复）');
  const conflictRows = procs.filter((p) => p.conflictId);
  assert(conflictRows.length === 2, '数据库中保留两版待核行');
  const museumRow = conflictRows.find((p) => p.conflictSide === 'museum')!;
  const coopRow = conflictRows.find((p) => p.conflictSide === 'coop')!;
  assert(museumRow.durationMin === 75 && coopRow.durationMin === 90, '两版内容各自保留、互不覆盖');

  const afterPhoto = await db.photos.get('ph-after');
  assert(afterPhoto?.procedureId === coopRow.id, 'after 影像按阶段归到合作室工序修订行');
  assert((await db.procedures.get(coopRow.id))?.photoAfterIds.includes('ph-after'), '影像 id 回挂合作室修订');

  // 同一批回包再导一次：重复影像去重、不新增
  const dupPlan = await importBundle(coopReturn);
  assert(dupPlan.report.photosAdded === 0, '重复影像不新增');
  assert(dupPlan.report.photosDeduped >= 1, '重复影像识别为去重（只留一条）');

  // 材料余量：馆内 10，扣合作室新领用 3 → 7；领用明细合并
  const supply = await db.supplies.get('s1');
  assert(supply?.qty === 7, `材料余量重算为 7（实际 ${supply?.qty}）`);
  assert(supply?.issues.length === 1 && supply.issues[0].id === 'i1', '合作室领用明细并入');

  // 待核核定采用馆内版：合作室独有影像按拍摄时间并入，定稿 rev+1
  const conflicts = await listConflicts();
  assert(conflicts.length === 1 && conflicts[0].diffFields.includes('durationMin'), '待核列表标出差异字段');
  await resolveConflict(conflicts[0].conflictId, 'museum');
  const resolved = await db.procedures.toArray();
  assert(resolved.filter((p) => p.conflictId).length === 0, '核定后无待核行');
  assert(resolved.find((p) => p.id === museumRow.id)?.durationMin === 75, '定稿采用馆内版内容');
  assert((await db.procedures.get(museumRow.id))?.photoAfterIds.includes('ph-after'), '输方合作室的独有影像并入定稿');
  assert((await db.photos.where('id').equals('ph-after').count()) === 1, '影像仍只有一条');
  assert((await db.procedures.get(museumRow.id))?.rev === 3, '定稿修订号 max(2,1)+1 = 3');
}

// ---------------------------------------------------------------------------
console.log('\n[3] 旧留痕包失效：本机工序改动后，旧包不得覆盖，差异转两版待核');
{
  const sp1 = makeSpecimen('sp1', 'FP-T-003', '修复中');
  const p1Base = makeProc({ id: 'p1', specimenId: 'sp1', durationMin: 60 });

  await resetDb();
  await db.specimens.put(sp1);
  await db.procedures.put(p1Base);
  const first = await buildExportPacket({ deviceName: '馆内' });
  const plan0 = await importBundle(first);
  await applyMergePlan(plan0); // 建立基线（p1=60）

  // 馆内随后改 p1 并登记本机改动时间
  await db.procedures.put(makeProc({ id: 'p1', specimenId: 'sp1', durationMin: 80, rev: 2, updatedAt: 9_000_000 }));
  await touchLocalProcEdit();

  // 合作室旧包（导出时间很早）把 p1 改成 120
  const oldPart = JSON.parse(JSON.stringify(first.parts[0])) as SyncPacketPart;
  oldPart.exportedAt = 1_000;
  oldPart.procedures = [
    makeProc({ id: 'p1', specimenId: 'sp1', durationMin: 120, state: 'done', finishedAt: 1_100, rev: 2, updatedAt: 1_050 }),
  ];
  const sealed = await reseal(oldPart);

  const stalePlan = await importParts([sealed]);
  assert(stalePlan.isStalePacket, '识别为旧留痕包');
  assert(stalePlan.report.staleTakeoversBlocked === 1, '旧包覆盖被拦截');
  assert(stalePlan.report.conflictsCreated === 1, '差异处留两版待核而非并入');
  await applyMergePlan(stalePlan);
  const rows = await db.procedures.toArray();
  assert(rows.every((r) => r.durationMin !== 120 || r.conflictSide === 'coop'), '馆内版本未被旧包覆盖');
  assert(!!rows.find((r) => r.conflictSide === 'museum' && r.durationMin === 80), '馆内 80 分钟版原样保留');
}

// ---------------------------------------------------------------------------
console.log('\n[4] 超容量分批：多卷导出/校验/拼回，缺卷、坏卷被拦截');
{
  await resetDb();
  await db.specimens.put(makeSpecimen('sp1', 'FP-T-004', '修复中'));
  for (let i = 0; i < 3; i += 1) {
    const pid = `p${i + 1}`;
    await db.procedures.put(makeProc({ id: pid, specimenId: 'sp1', seq: i + 1, startedAt: 2_000_000 + i }));
    await db.photos.put(
      makePhoto({
        id: `ph${i + 1}`,
        specimenId: 'sp1',
        procedureId: pid,
        dataUrl: `data:image/png;base64,${'A'.repeat(30_000)}`,
        capturedAt: 3_000_000 + i,
      }),
    );
  }
  const bundle = await buildExportPacket({ maxBytesPerPart: 42_000 });
  assert(bundle.parts.length === 3, `大包分成 3 卷（实际 ${bundle.parts.length}）`);
  assert(bundle.parts.every((p) => p.total === 3), '每卷声明的总卷数一致');

  await resetDb();
  const plan = await importBundle(bundle);
  assert(plan.report.proceduresAdded === 3 && plan.report.photosAdded === 3, '多卷拼回后记录完整');
  const ticks: number[] = [];
  await applyMergePlan(plan, (done) => ticks.push(done), { batchRows: 1 });
  assert(ticks.length >= 6, `写入分多批并回调进度（${ticks.length} 批）`);

  let err = '';
  try {
    await readPacketFiles(bundle.parts.slice(0, 2).map((p, i) => new File([JSON.stringify(p)], `p${i}.json`)));
  } catch (e) {
    err = (e as Error).message;
  }
  assert(err.includes('缺少分卷'), '缺少分卷被拦截：' + err);

  const photoPart = bundle.parts.find((p) => p.photos.length > 0);
  assert(!!photoPart, '至少有一卷包含影像');
  const tampered = JSON.parse(JSON.stringify(photoPart)) as SyncPacketPart;
  tampered.photos[0].caption = '被改动';
  let err2 = '';
  try {
    await readPacketFiles([new File([JSON.stringify(tampered)], 'bad.json')]);
  } catch (e) {
    err2 = (e as Error).message;
  }
  assert(err2.includes('校验失败'), '卷内容被改动时校验失败：' + err2);
}

// ---------------------------------------------------------------------------
console.log('\n[5] 分批写入失败按日志回滚，回滚后可重新导入');
{
  // 合作室新标本 + 5 条新工序
  await resetDb();
  await db.specimens.put(makeSpecimen('sp9', 'FP-T-NEW', '待清修'));
  for (let i = 0; i < 5; i += 1) {
    await db.procedures.put(makeProc({ id: `n${i}`, specimenId: 'sp9', seq: i + 1, nodeName: `新节点${i}`, startedAt: 6_000_000 + i }));
  }
  const incoming = await buildExportPacket({ side: 'coop' });

  // 馆内库
  await resetDb();
  await db.specimens.put(makeSpecimen('sp1', 'FP-T-005', '修复中'));
  await db.procedures.put(makeProc({ id: 'p1', specimenId: 'sp1', nodeName: '馆内节点' }));
  const plan = await importBundle(incoming);

  // 第 4 次工序写入时失败：第一批（3 行）已落库，第二批失败
  const origPut = db.procedures.put.bind(db.procedures);
  let calls = 0;
  (db.procedures as { put: (...args: unknown[]) => Promise<unknown> }).put = (row: PrepProcedure) => {
    calls += 1;
    if (calls === 4) return Promise.reject(new Error('模拟写入失败'));
    return origPut(row);
  };

  let msg = '';
  try {
    await applyMergePlan(plan, undefined, { batchRows: 3 });
  } catch (e) {
    msg = (e as Error).message;
  }
  (db.procedures as { put: typeof origPut }).put = origPut;
  assert(msg === '模拟写入失败', '写入失败时异常向上抛出');
  assert((await listPendingRollbacks()).length === 0, '失败后自动按日志回滚且日志清空');

  const afterFail = await db.procedures.toArray();
  assert(afterFail.length === 1 && afterFail[0].id === 'p1', '已提交的前一批也被回滚，只剩馆内原节点');
  assert((await db.specimens.toArray()).length === 1, '标本新增一并回滚');

  // 回滚后重导成功
  const plan2 = await importBundle(incoming);
  await applyMergePlan(plan2);
  const procs2 = await db.procedures.toArray();
  assert(procs2.length === 6, '回滚后重新导入成功（1 原有 + 5 新增）');
  assert((await listPendingRollbacks()).length === 0, '成功导入无残留日志');
}

// ---------------------------------------------------------------------------
console.log(`\n结果：${passed} 通过，${failed} 失败`);
if (failed > 0) process.exit(1);
