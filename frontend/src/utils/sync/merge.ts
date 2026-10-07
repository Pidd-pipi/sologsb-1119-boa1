/**
 * 离线留痕包三方合并引擎
 *
 * 规则（对应回馆合并需求）：
 * - 标本 / 工序 / 材料 / 影像按 id 对齐；
 * - 只有一边新改的记录直接并入（馆内单边新改不会出现在回包里，自然保留）；
 * - 工序两边都动过 → 同一节点留两版（museum / coop）待核，不互相覆盖；
 * - 影像按拍摄时间与阶段归到工序修订上，指纹重复只留一条；
 * - 合并后完成度由 UI 侧按“核定行 + 每个冲突组的馆内版”重算，材料余量在
 *   馆内当前余量上直接扣减合作室新登记的领用，对照说明随数据刷新；
 * - 本机工序改动后，旧留痕包（导出早于最近一次本机工序改动）标记失效，
 *   不得直接覆盖本机工序；
 * - 旧数据无修订号时按当前值回填（v3 迁移已补 rev=1，包内缺号同样补 1）。
 */
import { db, SYNC_STATE_KEY, type SyncJournalEntry } from '../../utils/db';
import type { Specimen } from '../../types/specimen';
import type { PrepProcedure, RevisionSide } from '../../types/procedure';
import type { SupplyLot, SupplyIssue } from '../../types/supply';
import type { PrepPhoto } from '../../types/photo';
import type { MergeReport, SyncPacketPart } from '../../types/sync';
import { newId } from '../../utils/id';

/** 业务字段规范化文本（不含修订元数据与影像挂接数组，影像增减不触发冲突） */
function canonicalFields(row: Record<string, unknown>, fields: string[]): string {
  const picked: Record<string, unknown> = {};
  for (const f of fields) picked[f] = row[f];
  return JSON.stringify(picked);
}

const SPECIMEN_FIELDS = [
  'specimenNo',
  'taxon',
  'horizon',
  'locality',
  'lithology',
  'matrixHardness',
  'dimensions',
  'weight',
  'storageBox',
  'status',
];
const SUPPLY_FIELDS = ['name', 'kind', 'spec', 'lotNo', 'unit', 'openedAt', 'shelfLifeMonths', 'lowThreshold'];
const PROC_FIELDS = [
  'specimenId',
  'stepType',
  'nodeName',
  'seq',
  'tools',
  'abrasive',
  'adhesive',
  'adhesiveConc',
  'durationMin',
  'tempC',
  'rh',
  'operator',
  'startedAt',
  'state',
  'finishedAt',
];

export function specimenHash(row: Specimen): string {
  return canonicalFields(row as unknown as Record<string, unknown>, SPECIMEN_FIELDS);
}
export function supplyHash(row: SupplyLot): string {
  return canonicalFields(row as unknown as Record<string, unknown>, SUPPLY_FIELDS);
}
export function procedureHash(row: PrepProcedure): string {
  return canonicalFields(row as unknown as Record<string, unknown>, PROC_FIELDS);
}

/** 影像去重指纹：内容 + 归属 + 阶段 + 拍摄时间，与 id 无关 */
export function photoFingerprint(p: PrepPhoto): string {
  return [p.specimenId, p.procedureId, p.stage, p.capturedAt, p.dataUrl].join('');
}

/** 旧数据 / 包内老记录缺修订号时，按当前值回填为 1 */
function withRev(row: PrepProcedure): PrepProcedure {
  return { ...row, rev: row.rev ?? 1, updatedAt: row.updatedAt ?? row.startedAt };
}

export interface LastSyncBase {
  batchId?: string;
  mergedAt: number;
  /** 本机最近一次工序改动时间（旧包失效判据） */
  localProcEditAt: number;
  proc: Record<string, string>;
  supply: Record<string, { hash: string; qty: number }>;
  specimen: Record<string, string>;
  recentBatchIds: string[];
}

const EMPTY_BASE: LastSyncBase = {
  mergedAt: 0,
  localProcEditAt: 0,
  proc: {},
  supply: {},
  specimen: {},
  recentBatchIds: [],
};

export async function loadBase(): Promise<LastSyncBase> {
  const row = await db.syncState.get(SYNC_STATE_KEY);
  if (row?.value) return { ...EMPTY_BASE, ...(row.value as Partial<LastSyncBase>) };
  return { ...EMPTY_BASE };
}

/** 工序增删改后调用：使此前导出的留痕包失效 */
export async function touchLocalProcEdit(): Promise<void> {
  const base = await loadBase();
  await db.syncState.put({ key: SYNC_STATE_KEY, value: { ...base, localProcEditAt: Date.now() } });
}

/** 按当前库内容重建基线快照（一次成功合并 / 核定之后调用） */
async function rebuildBase(planBatchId: string | undefined, prev: LastSyncBase, bumpEdit = false): Promise<LastSyncBase> {
  const [specimens, procs, supplies] = await Promise.all([
    db.specimens.toArray(),
    db.procedures.toArray(),
    db.supplies.toArray(),
  ]);
  const proc: Record<string, string> = {};
  for (const p of procs) {
    if (p.conflictId) continue; // 待核行未定稿，不进基线
    proc[p.id] = procedureHash(p);
  }
  const supply: Record<string, { hash: string; qty: number }> = {};
  for (const s of supplies) supply[s.id] = { hash: supplyHash(s), qty: s.qty };
  const specimen: Record<string, string> = {};
  for (const s of specimens) specimen[s.id] = specimenHash(s);

  const recent = Array.from(new Set(planBatchId ? [planBatchId, ...prev.recentBatchIds] : prev.recentBatchIds)).slice(0, 20);
  return {
    batchId: planBatchId ?? prev.batchId,
    mergedAt: Date.now(),
    localProcEditAt: bumpEdit ? Date.now() : prev.localProcEditAt,
    proc,
    supply,
    specimen,
    recentBatchIds: recent,
  };
}

type MergeOp =
  | { table: 'specimens' | 'supplies' | 'photos'; action: 'put'; row: Specimen | SupplyLot | PrepPhoto }
  | { table: 'procedures'; action: 'put'; row: PrepProcedure }
  | { table: 'procedures'; action: 'delete'; id: string };

export interface MergePlan {
  parts: SyncPacketPart[];
  report: MergeReport;
  ops: MergeOp[];
  base: LastSyncBase;
  isStalePacket: boolean;
  alreadyImported: boolean;
}

function newReport(first: SyncPacketPart): MergeReport {
  return {
    importedAt: Date.now(),
    packetBatchId: first.batchId,
    packetExportedAt: first.exportedAt,
    specimensAdded: 0,
    specimensUpdated: 0,
    proceduresAdded: 0,
    proceduresUpdated: 0,
    conflictsCreated: 0,
    conflictsRefreshed: 0,
    conflictsResolved: 0,
    staleTakeoversBlocked: 0,
    photosAdded: 0,
    photosDeduped: 0,
    suppliesAdded: 0,
    suppliesUpdated: 0,
    supplyIssuesMerged: 0,
    touchedSpecimenIds: [],
    conflictIds: [],
    notes: [],
  };
}

function pushTouched(report: MergeReport, specimenId: string): void {
  if (specimenId && !report.touchedSpecimenIds.includes(specimenId)) report.touchedSpecimenIds.push(specimenId);
}

/**
 * 纯计算合并方案（不落库），便于在 UI 上先预览再提交。
 * parts 必须是已通过 parsePacket 校验并按 index 排好序的整包。
 */
export async function buildMergePlan(parts: SyncPacketPart[]): Promise<MergePlan> {
  if (parts.length === 0) throw new Error('留痕包为空，没有可导入的分卷');

  const packet: SyncPacketPart = {
    ...parts[0],
    specimens: parts.flatMap((p) => p.specimens),
    procedures: parts.flatMap((p) => p.procedures),
    supplies: parts.flatMap((p) => p.supplies),
    photos: parts.flatMap((p) => p.photos),
  };

  const [localSpecimens, localProcsRaw, localSupplies, localPhotos] = await Promise.all([
    db.specimens.toArray(),
    db.procedures.toArray(),
    db.supplies.toArray(),
    db.photos.toArray(),
  ]);
  const localProcs = localProcsRaw.map(withRev);
  const base = await loadBase();
  const report = newReport(parts[0]);
  const ops: MergeOp[] = [];

  const isStalePacket = base.localProcEditAt > 0 && packet.exportedAt < base.localProcEditAt;
  const alreadyImported = base.recentBatchIds.includes(packet.batchId);
  if (isStalePacket) {
    report.notes.push(
      `该留痕包导出于 ${new Date(packet.exportedAt).toLocaleString('zh-CN')}，早于本机最近一次工序改动（${new Date(
        base.localProcEditAt,
      ).toLocaleString('zh-CN')}），已按旧包处理：不直接覆盖本机工序，差异处一律留两版待核。`,
    );
  }
  if (alreadyImported) {
    report.notes.push('该留痕包批次此前已导入过；重复导入不会产生新数据，可用于回滚后重导。');
  }

  // ---------- 工序（三方合并核心） ----------
  const localById = new Map(localProcs.map((p) => [p.id, p]));
  /** conflictId -> 已有两版行 */
  const conflictGroups = new Map<string, { museum?: PrepProcedure; coop?: PrepProcedure }>();
  for (const p of localProcs) {
    if (!p.conflictId) continue;
    const g = conflictGroups.get(p.conflictId) ?? {};
    if (p.conflictSide === 'museum') g.museum = p;
    if (p.conflictSide === 'coop') g.coop = p;
    conflictGroups.set(p.conflictId, g);
  }

  /** 影像 procedureId 重映射：包内工序 id -> 落库后实际承载行 id */
  const procIdRemap = new Map<string, string>();

  for (const incomingRaw of packet.procedures) {
    const incoming = withRev(incomingRaw);
    const local = localById.get(incoming.id);

    // 仅合作室新增 → 直接并入
    if (!local) {
      ops.push({ table: 'procedures', action: 'put', row: { ...incoming, conflictId: undefined, conflictSide: undefined } });
      procIdRemap.set(incoming.id, incoming.id);
      report.proceduresAdded += 1;
      pushTouched(report, incoming.specimenId);
      continue;
    }

    // 命中已有待核分组（回包针对的通常是馆内侧原 id）
    if (local.conflictId) {
      const g = conflictGroups.get(local.conflictId);
      const museum = g?.museum ?? (local.conflictSide === 'museum' ? local : undefined);
      const coop = g?.coop ?? (local.conflictSide === 'coop' ? local : undefined);
      if (!museum || !coop) {
        // 异常残缺分组：用回包直接补齐 / 覆盖命中行
        ops.push({ table: 'procedures', action: 'put', row: { ...incoming } });
        procIdRemap.set(incoming.id, local.id);
        continue;
      }

      if (procedureHash(incoming) === procedureHash(museum)) {
        // 回包内容已与馆内版一致 → 自动核定撤销两版
        const merged: PrepProcedure = {
          ...museum,
          rev: Math.max(museum.rev ?? 1, incoming.rev ?? 1) + 1,
          updatedAt: Date.now(),
          conflictId: undefined,
          conflictSide: undefined,
          conflictOtherRev: undefined,
        };
        ops.push({ table: 'procedures', action: 'put', row: merged });
        ops.push({ table: 'procedures', action: 'delete', id: coop.id });
        procIdRemap.set(incoming.id, museum.id);
        report.conflictsResolved += 1;
        pushTouched(report, museum.specimenId);
        continue;
      }

      // 刷新 coop 版为最新回包内容；馆内版同步对侧修订号
      const coopRow: PrepProcedure = {
        ...incoming,
        id: coop.id,
        conflictId: museum.conflictId,
        conflictSide: 'coop',
        conflictOtherRev: museum.rev,
        updatedAt: Date.now(),
      };
      ops.push({ table: 'procedures', action: 'put', row: coopRow });
      ops.push({
        table: 'procedures',
        action: 'put',
        row: { ...museum, conflictOtherRev: incoming.rev },
      });
      procIdRemap.set(incoming.id, coop.id);
      report.conflictsRefreshed += 1;
      if (!report.conflictIds.includes(museum.conflictId as string)) report.conflictIds.push(museum.conflictId as string);
      pushTouched(report, museum.specimenId);
      continue;
    }

    const localHash = procedureHash(local);
    const incomingHash = procedureHash(incoming);
    if (localHash === incomingHash) {
      if ((incoming.rev ?? 1) > (local.rev ?? 1)) {
        ops.push({ table: 'procedures', action: 'put', row: { ...local, rev: incoming.rev } });
      }
      procIdRemap.set(incoming.id, local.id);
      continue;
    }

    const baseHash = base.proc[incoming.id];
    const localChanged = baseHash !== undefined ? localHash !== baseHash : false;
    const incomingChanged = baseHash !== undefined ? incomingHash !== baseHash : true;

    // 只有合作室一侧新改 → 直接并入；旧包不得覆盖本机
    if (!localChanged && incomingChanged && !isStalePacket) {
      const merged: PrepProcedure = {
        ...incoming,
        rev: Math.max(local.rev ?? 1, incoming.rev ?? 1) + 1,
        updatedAt: Date.now(),
      };
      ops.push({ table: 'procedures', action: 'put', row: merged });
      procIdRemap.set(incoming.id, merged.id);
      report.proceduresUpdated += 1;
      pushTouched(report, merged.specimenId);
      continue;
    }
    // 只有馆内一侧改动（回包是旧版本）→ 保留本机
    if (localChanged && !incomingChanged) {
      procIdRemap.set(incoming.id, local.id);
      continue;
    }

    // 两边都动过 / 无基线无法判定 / 旧包拦截 → 留两版待核
    if (isStalePacket) report.staleTakeoversBlocked += 1;
    const conflictId = newId('cnf');
    const museumRow: PrepProcedure = {
      ...local,
      rev: local.rev ?? 1,
      updatedAt: Date.now(),
      conflictId,
      conflictSide: 'museum',
      conflictOtherRev: incoming.rev,
    };
    const coopId = newId('prc');
    const coopRow: PrepProcedure = {
      ...incoming,
      id: coopId,
      rev: incoming.rev ?? 1,
      updatedAt: Date.now(),
      conflictId,
      conflictSide: 'coop',
      conflictOtherRev: local.rev,
    };
    ops.push({ table: 'procedures', action: 'put', row: museumRow });
    ops.push({ table: 'procedures', action: 'put', row: coopRow });
    procIdRemap.set(incoming.id, coopId);
    report.conflictsCreated += 1;
    report.conflictIds.push(conflictId);
    pushTouched(report, museumRow.specimenId);
  }

  // ---------- 影像：按拍摄时间与阶段归到工序修订，重复只留一条 ----------
  const localPhotoById = new Map(localPhotos.map((p) => [p.id, p]));
  const localFps = new Set(localPhotos.map(photoFingerprint));
  const incomingPhotos = [...packet.photos].sort((a, b) => a.capturedAt - b.capturedAt);
  /** 目标工序 id -> 本次需要并入挂接数组的影像 id（按阶段） */
  const pendingAttach = new Map<string, { before: string[]; after: string[] }>();
  /** 导入后需要改挂（工序行已变成待核行 id）的本机影像 */
  const reattached = new Set<string>();
  const ensureAttach = (id: string) => {
    let bucket = pendingAttach.get(id);
    if (!bucket) {
      bucket = { before: [], after: [] };
      pendingAttach.set(id, bucket);
    }
    return bucket;
  };

  for (const photoRaw of incomingPhotos) {
    const targetProcId = procIdRemap.get(photoRaw.procedureId) ?? photoRaw.procedureId;
    const stageBucket = photoRaw.stage === 'after' ? 'after' : 'before';
    const sameId = localPhotoById.get(photoRaw.id);
    const fp = photoFingerprint(photoRaw);

    if (sameId) {
      // 同一影像再次进包（重导 / 回包刷新）：不新增，只在工序行被拆成待核行时补挂接
      if (sameId.procedureId !== targetProcId && !reattached.has(sameId.id)) {
        ops.push({ table: 'photos', action: 'put', row: { ...sameId, procedureId: targetProcId } });
        ensureAttach(targetProcId)[stageBucket].push(sameId.id);
        reattached.add(sameId.id);
      }
      report.photosDeduped += 1;
      continue;
    }
    if (localFps.has(fp)) {
      // 跨端生成了不同 id、但内容完全一致：视为重复，只留本机一条
      report.photosDeduped += 1;
      continue;
    }

    const photo: PrepPhoto = { ...photoRaw, procedureId: targetProcId };
    ops.push({ table: 'photos', action: 'put', row: photo });
    localPhotoById.set(photo.id, photo);
    localFps.add(photoFingerprint(photo));
    ensureAttach(targetProcId)[stageBucket].push(photo.id);
    report.photosAdded += 1;
    pushTouched(report, photo.specimenId);
  }

  // 把新增 / 重映射影像的 id 并回工序行的挂接数组
  const finalProcPuts = new Map<string, MergeOp>();
  for (const op of ops) {
    if (op.table === 'procedures' && op.action === 'put') finalProcPuts.set(op.row.id, op);
  }
  for (const [pid, bucket] of pendingAttach) {
    const op = finalProcPuts.get(pid);
    const row = op && op.table === 'procedures' && op.action === 'put' ? op.row : localById.get(pid);
    if (!row) continue;
    const mergeIds = (oldIds: string[], add: string[]) => Array.from(new Set([...oldIds, ...add]));
    const next: PrepProcedure = {
      ...row,
      photoBeforeIds: mergeIds(row.photoBeforeIds, bucket.before),
      photoAfterIds: mergeIds(row.photoAfterIds, bucket.after),
    };
    finalProcPuts.set(pid, { table: 'procedures', action: 'put', row: next });
  }
  // 用挂接完成的工序行重建 ops：工序 put 去重取最终版，删除项与其它表操作原样保留
  const mergedOps: MergeOp[] = [];
  const emittedProcPuts = new Set<string>();
  for (const op of ops) {
    if (op.table === 'procedures' && op.action === 'put') {
      if (emittedProcPuts.has(op.row.id)) continue;
      emittedProcPuts.add(op.row.id);
      mergedOps.push(finalProcPuts.get(op.row.id) ?? op);
    } else {
      mergedOps.push(op);
    }
  }

  // ---------- 标本：单边新改直接并入，双边改动保留馆内并提示 ----------
  const localSpecimenById = new Map(localSpecimens.map((s) => [s.id, s]));
  for (const incoming of packet.specimens) {
    const local = localSpecimenById.get(incoming.id);
    if (!local) {
      mergedOps.push({ table: 'specimens', action: 'put', row: incoming });
      report.specimensAdded += 1;
      pushTouched(report, incoming.id);
      continue;
    }
    if (specimenHash(local) === specimenHash(incoming)) continue;
    const localChanged = base.specimen[incoming.id] !== undefined && specimenHash(local) !== base.specimen[incoming.id];
    if (!localChanged) {
      mergedOps.push({ table: 'specimens', action: 'put', row: { ...incoming, id: local.id, createdAt: local.createdAt } });
      report.specimensUpdated += 1;
      pushTouched(report, incoming.id);
    } else {
      report.notes.push(`标本 ${local.specimenNo} 两侧都有改动，已保留馆内版本，请人工核对。`);
    }
  }

  // ---------- 材料批次：标量字段取较新版本，领用明细并集，余量随领用重算 ----------
  const localSupplyById = new Map(localSupplies.map((s) => [s.id, s]));
  for (const incoming of packet.supplies) {
    const local = localSupplyById.get(incoming.id);
    if (!local) {
      mergedOps.push({ table: 'supplies', action: 'put', row: incoming });
      report.suppliesAdded += 1;
      continue;
    }
    const localIssueIds = new Set(local.issues.map((i) => i.id));
    const newIssues: SupplyIssue[] = incoming.issues.filter((i) => !localIssueIds.has(i.id));
    const issues = [...local.issues, ...newIssues].sort((a, b) => b.issuedAt - a.issuedAt);
    // 材料余量：馆内当前余量已是本机领用后的值，只需再扣减合作室新登记领用
    const coopUsed = newIssues.reduce((s, i) => s + i.qty, 0);
    const qty = Math.max(0, Math.round((local.qty - coopUsed) * 1000) / 1000);
    const scalarChanged = supplyHash(local) !== supplyHash(incoming);
    if (newIssues.length === 0 && !scalarChanged && qty === local.qty) continue;
    const next: SupplyLot = {
      ...local,
      ...(scalarChanged
        ? {
            name: incoming.name,
            kind: incoming.kind,
            spec: incoming.spec,
            lotNo: incoming.lotNo,
            unit: incoming.unit,
            openedAt: incoming.openedAt,
            shelfLifeMonths: incoming.shelfLifeMonths,
            lowThreshold: incoming.lowThreshold,
          }
        : {}),
      issues,
      qty,
    };
    mergedOps.push({ table: 'supplies', action: 'put', row: next });
    report.suppliesUpdated += 1;
    report.supplyIssuesMerged += newIssues.length;
  }

  if (report.conflictsCreated > 0) {
    report.notes.push(`有 ${report.conflictsCreated} 处工序两边都动过，已保留馆内 / 合作室两版，请到「离线合并 · 待核修订」逐处核定。`);
  }

  return { parts, report, ops: mergedOps, base, isStalePacket, alreadyImported };
}

/** 分批写入的体积上限（留出 IndexedDB 事务与索引开销） */
export const APPLY_BATCH_BYTES = 3_500_000;
const APPLY_BATCH_ROWS = 300;

function rowBytes(op: MergeOp): number {
  if (op.action === 'delete') return 0;
  return JSON.stringify(op.row).length;
}

/**
 * 按批写入合并方案；任一批失败即按回滚日志恢复全部已写批次并抛出异常，
 * 调用方可在修正后重新导入。
 */
export async function applyMergePlan(
  plan: MergePlan,
  onProgress?: (done: number, total: number) => void,
  opts: { batchBytes?: number; batchRows?: number } = {},
): Promise<MergeReport> {
  const batchId = plan.parts[0].batchId;
  if ((await db.syncJournal.where('batchId').equals(batchId).count()) > 0) {
    await rollbackByBatch(batchId); // 上次失败残留，先回滚干净
  }

  const allTables = [db.specimens, db.procedures, db.supplies, db.photos];
  const maxBatchBytes = opts.batchBytes ?? APPLY_BATCH_BYTES;
  const maxBatchRows = opts.batchRows ?? APPLY_BATCH_ROWS;

  const batches: MergeOp[][] = [];
  let cur: MergeOp[] = [];
  let curBytes = 0;
  for (const op of plan.ops) {
    const size = rowBytes(op);
    if (cur.length > 0 && (cur.length >= maxBatchRows || curBytes + size > maxBatchBytes)) {
      batches.push(cur);
      cur = [];
      curBytes = 0;
    }
    cur.push(op);
    curBytes += size;
  }
  if (cur.length > 0) batches.push(cur);

  const total = plan.ops.length;
  let done = 0;
  let journalSeq = 0;

  try {
    for (const batch of batches) {
      await db.transaction('rw', [...allTables, db.syncState, db.syncJournal], async () => {
        const entries: SyncJournalEntry[] = [];
        for (const op of batch) {
          const key = op.action === 'delete' ? op.id : (op.row as { id: string }).id;
          const table = op.table as SyncJournalEntry['table'];
          const existing = await (db[table] as typeof db.specimens).get(key);
          entries.push({
            id: newId('jnl'),
            batchId,
            seq: (journalSeq += 1),
            table,
            recordKey: key,
            existed: existing !== undefined,
            row: existing,
            createdAt: Date.now(),
          });
        }
        await db.syncJournal.bulkPut(entries);
        for (const op of batch) {
          const table = db[op.table as SyncJournalEntry['table']] as typeof db.specimens;
          if (op.action === 'delete') await table.delete(op.id);
          else await table.put(op.row as never);
        }
      });
      done += batch.length;
      onProgress?.(done, total);
    }

    const nextBase = await rebuildBase(batchId, plan.base);
    await db.transaction('rw', db.syncState, db.syncJournal, async () => {
      await db.syncState.put({ key: SYNC_STATE_KEY, value: nextBase });
      await db.syncJournal.where('batchId').equals(batchId).delete();
    });
  } catch (err) {
    await rollbackByBatch(batchId).catch(() => undefined);
    throw err;
  }

  return plan.report;
}

/** 按回滚日志把某批次全部改动恢复到导入前状态（失败后可重导） */
export async function rollbackByBatch(batchId: string): Promise<void> {
  const entries = await db.syncJournal.where('batchId').equals(batchId).toArray();
  entries.sort((a, b) => b.seq - a.seq);
  const allTables = [db.specimens, db.procedures, db.supplies, db.photos];
  await db.transaction('rw', [...allTables, db.syncJournal], async () => {
    for (const e of entries) {
      const table = db[e.table] as typeof db.specimens;
      if (e.existed && e.row !== undefined) await table.put(e.row as never);
      else await table.delete(e.recordKey);
    }
    await db.syncJournal.where('batchId').equals(batchId).delete();
  });
}

/** 是否存在失败导入遗留的回滚日志 */
export async function listPendingRollbacks(): Promise<Array<{ batchId: string; count: number }>> {
  const rows = await db.syncJournal.toArray();
  const map = new Map<string, number>();
  for (const r of rows) map.set(r.batchId, (map.get(r.batchId) ?? 0) + 1);
  return Array.from(map.entries()).map(([id, count]) => ({ batchId: id, count }));
}

/** 待核分组视图：返回每个 conflictId 的两版行与字段差异 */
export interface ConflictView {
  conflictId: string;
  specimenId: string;
  museum: PrepProcedure;
  coop: PrepProcedure;
  diffFields: string[];
}

export async function listConflicts(): Promise<ConflictView[]> {
  const all = await db.procedures.toArray();
  const groups = new Map<string, { museum?: PrepProcedure; coop?: PrepProcedure }>();
  for (const r of all) {
    if (!r.conflictId) continue;
    const g = groups.get(r.conflictId) ?? {};
    if (r.conflictSide === 'museum') g.museum = r;
    if (r.conflictSide === 'coop') g.coop = r;
    groups.set(r.conflictId, g);
  }
  const views: ConflictView[] = [];
  for (const [conflictId, g] of groups) {
    if (!g.museum || !g.coop) continue;
    const diffFields = PROC_FIELDS.filter((f) => {
      const a = (g.museum as unknown as Record<string, unknown>)[f];
      const b = (g.coop as unknown as Record<string, unknown>)[f];
      return JSON.stringify(a) !== JSON.stringify(b);
    });
    views.push({ conflictId, specimenId: g.museum.specimenId, museum: g.museum, coop: g.coop, diffFields });
  }
  return views.sort((a, b) => a.museum.seq - b.museum.seq || a.museum.startedAt - b.museum.startedAt);
}

/**
 * 核定一处两版待核：
 * - 保留 chosen 侧内容（可叠加用户补丁），输方行删除；
 * - 输方挂接的影像按拍摄时间并入胜出行（指纹重复只留一条）；
 * - 定稿修订号 +1，并重建基线、登记本机工序改动时间。
 */
export async function resolveConflict(conflictId: string, chosen: RevisionSide, patch?: Partial<PrepProcedure>): Promise<void> {
  const rows = await db.procedures.where('conflictId').equals(conflictId).toArray();
  const museum = rows.find((r) => r.conflictSide === 'museum');
  const coop = rows.find((r) => r.conflictSide === 'coop');
  if (!museum || !coop) throw new Error('待核分组数据不完整，无法核定');

  const winner0 = chosen === 'museum' ? museum : coop;
  const loser = chosen === 'museum' ? coop : museum;

  const winnerPhotos = await db.photos.where('procedureId').equals(winner0.id).toArray();
  const loserPhotos = (await db.photos.where('procedureId').equals(loser.id).toArray()).sort((a, b) => a.capturedAt - b.capturedAt);
  const haveFp = new Set(winnerPhotos.map(photoFingerprint));
  const movedBefore: string[] = [];
  const movedAfter: string[] = [];
  for (const p of loserPhotos) {
    if (haveFp.has(photoFingerprint(p))) {
      await db.photos.delete(p.id); // 重复只留一条
      continue;
    }
    await db.photos.put({ ...p, procedureId: winner0.id });
    haveFp.add(photoFingerprint(p));
    if (p.stage === 'after') movedAfter.push(p.id);
    else movedBefore.push(p.id);
  }

  const winner: PrepProcedure = {
    ...winner0,
    ...patch,
    photoBeforeIds: Array.from(new Set([...winner0.photoBeforeIds, ...movedBefore])),
    photoAfterIds: Array.from(new Set([...winner0.photoAfterIds, ...movedAfter])),
    rev: Math.max(museum.rev ?? 1, coop.rev ?? 1) + 1,
    updatedAt: Date.now(),
    conflictId: undefined,
    conflictSide: undefined,
    conflictOtherRev: undefined,
  };

  await db.transaction('rw', db.procedures, db.photos, async () => {
    await db.procedures.put(winner);
    await db.procedures.delete(loser.id);
  });

  const prev = await loadBase();
  const nextBase = await rebuildBase(prev.batchId, prev, true);
  await db.syncState.put({ key: SYNC_STATE_KEY, value: nextBase });
}
