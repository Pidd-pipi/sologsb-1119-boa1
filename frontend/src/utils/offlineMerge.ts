import type { Specimen } from '../types/specimen';
import type { PrepProcedure, PrepProcedureRevision, ProcedureConflict } from '../types/procedure';
import type { SupplyIssue, SupplyLot } from '../types/supply';
import type { PhotoStage, PrepPhoto } from '../types/photo';
import type { MergeConflict, MergeCounts, MergeReport } from '../types/trace';
import { photoContentHash } from './hash';

/** 归挂时拍摄时间落在工序窗口边缘的容差（ms） */
const STAGE_TOLERANCE_MS = 5 * 60 * 1000;

export interface LocalSnapshot {
  specimens: Specimen[];
  procedures: PrepProcedure[];
  supplies: SupplyLot[];
  photos: PrepPhoto[];
}

export interface RemotePacketData {
  source: string;
  batchId: string;
  exportedAt: number;
  schemaVersion: number;
  specimens: unknown[];
  procedures: unknown[];
  supplies: unknown[];
  photos: unknown[];
}

export interface MergeResult {
  specimens: Specimen[];
  procedures: PrepProcedure[];
  supplies: SupplyLot[];
  photos: PrepPhoto[];
  report: MergeReport;
}

const emptyCounts = (): MergeCounts => ({
  specimens: { added: 0, updated: 0, unchanged: 0, conflict: 0 },
  procedures: { added: 0, updated: 0, unchanged: 0, conflict: 0 },
  supplies: { added: 0, updated: 0, unchanged: 0, conflict: 0 },
  photos: { added: 0, deduped: 0, relinked: 0 },
});

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/* ------------------------------------------------------------------ */
/* 旧数据升级：无修订号时按当前值回填                                   */
/* ------------------------------------------------------------------ */

export interface BackfillStat {
  specimens: number;
  procedures: number;
  supplies: number;
  photos: number;
}

function normalizeSpecimen(raw: unknown): Specimen {
  const r = asRecord(raw);
  const createdAt = num(r.createdAt, Date.now());
  return {
    id: str(r.id),
    specimenNo: str(r.specimenNo),
    taxon: str(r.taxon),
    horizon: str(r.horizon),
    locality: str(r.locality),
    lithology: str(r.lithology),
    matrixHardness: num(r.matrixHardness),
    dimensions: str(r.dimensions),
    weight: num(r.weight),
    storageBox: str(r.storageBox),
    status: (str(r.status, '待清修') as Specimen['status']) ?? '待清修',
    createdAt,
    rev: num(r.rev, 1),
    updatedAt: num(r.updatedAt, createdAt),
  };
}

function normalizeProcedure(raw: unknown): PrepProcedureRevision {
  const r = asRecord(raw);
  const startedAt = num(r.startedAt, Date.now());
  const finishedAt = typeof r.finishedAt === 'number' ? r.finishedAt : undefined;
  const state = r.state === 'done' || r.state === 'rolledback' ? r.state : 'pending';
  return {
    id: str(r.id),
    specimenId: str(r.specimenId),
    stepType: str(r.stepType, '清修') as PrepProcedure['stepType'],
    nodeName: str(r.nodeName),
    seq: num(r.seq, 1),
    tools: strArr(r.tools),
    abrasive: str(r.abrasive),
    adhesive: str(r.adhesive),
    adhesiveConc: num(r.adhesiveConc),
    durationMin: num(r.durationMin),
    tempC: num(r.tempC),
    rh: num(r.rh),
    photoBeforeIds: strArr(r.photoBeforeIds),
    photoAfterIds: strArr(r.photoAfterIds),
    operator: str(r.operator),
    startedAt,
    state,
    finishedAt,
    rev: num(r.rev, 1),
    updatedAt: num(r.updatedAt, finishedAt ?? startedAt),
  };
}

function normalizeSupply(raw: unknown): SupplyLot {
  const r = asRecord(raw);
  const openedAt = num(r.openedAt, Date.now());
  const issues: SupplyIssue[] = Array.isArray(r.issues)
    ? r.issues
        .map((it) => asRecord(it))
        .filter((it) => !!str(it.id))
        .map((it) => ({
          id: str(it.id),
          qty: num(it.qty),
          operator: str(it.operator),
          specimenNo: str(it.specimenNo),
          issuedAt: num(it.issuedAt),
        }))
    : [];
  const lastIssue = issues.reduce<number>((max, it) => Math.max(max, it.issuedAt), 0);
  return {
    id: str(r.id),
    name: str(r.name),
    kind: str(r.kind, '耗材') as SupplyLot['kind'],
    spec: str(r.spec),
    lotNo: str(r.lotNo),
    qty: num(r.qty),
    unit: str(r.unit),
    openedAt,
    shelfLifeMonths: num(r.shelfLifeMonths),
    lowThreshold: num(r.lowThreshold, 0),
    issues,
    rev: num(r.rev, 1),
    updatedAt: num(r.updatedAt, Math.max(openedAt, lastIssue)),
  };
}

function normalizePhoto(raw: unknown): PrepPhoto {
  const r = asRecord(raw);
  const capturedAt = num(r.capturedAt, Date.now());
  const dataUrl = str(r.dataUrl);
  const stage = ['before', 'after', 'process'].includes(String(r.stage))
    ? (String(r.stage) as PhotoStage)
    : 'process';
  return {
    id: str(r.id),
    specimenId: str(r.specimenId),
    procedureId: str(r.procedureId),
    stage,
    caption: str(r.caption),
    dataUrl,
    capturedAt,
    contentHash: str(r.contentHash) || photoContentHash(dataUrl),
    rev: num(r.rev, 1),
    updatedAt: num(r.updatedAt, capturedAt),
  };
}

/* ------------------------------------------------------------------ */
/* 内容比对：修订号与更新时间不参与业务内容比较                          */
/* ------------------------------------------------------------------ */

const stripTracked = <T extends { rev?: number; updatedAt?: number }>(r: T): Omit<T, 'rev' | 'updatedAt'> => {
  const { rev: _r, updatedAt: _u, ...rest } = r as T & { rev?: number; updatedAt?: number };
  void _r;
  void _u;
  return rest;
};

function sameContent(a: unknown, b: unknown): boolean {
  return JSON.stringify(stripTracked(a as { rev?: number; updatedAt?: number })) ===
    JSON.stringify(stripTracked(b as { rev?: number; updatedAt?: number }));
}

function procedureContentEqual(a: PrepProcedureRevision, b: PrepProcedureRevision): boolean {
  const ca = stripTracked(a);
  const cb = stripTracked(b);
  return JSON.stringify(ca) === JSON.stringify(cb);
}

/* ------------------------------------------------------------------ */
/* 影像归挂：按拍摄时间与阶段归到工序修订                                */
/* ------------------------------------------------------------------ */

interface ProcWindow {
  proc: PrepProcedure;
  start: number;
  end: number;
}

function procWindow(proc: PrepProcedure): ProcWindow {
  const start = proc.startedAt;
  const end = proc.finishedAt ?? start + Math.max(0, proc.durationMin) * 60000;
  return { proc, start, end: Math.max(end, start) };
}

function inferStage(t: number, win: ProcWindow): PhotoStage {
  if (t < win.start - STAGE_TOLERANCE_MS) return 'before';
  if (t > win.end + STAGE_TOLERANCE_MS) return 'after';
  return 'process';
}

function pickProcedure(t: number, windows: ProcWindow[]): ProcWindow | undefined {
  if (windows.length === 0) return undefined;
  const inside = windows.find((w) => t >= w.start - STAGE_TOLERANCE_MS && t <= w.end + STAGE_TOLERANCE_MS);
  if (inside) return inside;
  let best = windows[0];
  let bestDist = Math.min(Math.abs(t - best.start), Math.abs(t - best.end));
  for (const w of windows.slice(1)) {
    const dist = Math.min(Math.abs(t - w.start), Math.abs(t - w.end));
    if (dist < bestDist) {
      best = w;
      bestDist = dist;
    }
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* 三方合并主流程                                                       */
/* ------------------------------------------------------------------ */

/**
 * 离线合并：
 * - 一边新改（仅一侧相对共同版本有改动）直接并入；
 * - 两边都动过的工序留两版待核（conflicts）；
 * - 影像按拍摄时间与阶段归挂到工序修订，同标本/同拍摄时间/同内容重复只留一条；
 * - 旧数据无修订号时按当前值回填 rev=1。
 */
export function mergeOfflinePacket(local: LocalSnapshot, remote: RemotePacketData): MergeResult {
  const counts = emptyCounts();
  const warnings: string[] = [];
  const backfill: BackfillStat = { specimens: 0, procedures: 0, supplies: 0, photos: 0 };

  const countBackfill = (raw: unknown): boolean =>
    typeof (asRecord(raw).rev) !== 'number';

  /* 标本 */
  const specimenMap = new Map<string, Specimen>(local.specimens.map((s) => [s.id, s]));
  remote.specimens.forEach((raw) => {
    if (countBackfill(raw)) backfill.specimens += 1;
    const incoming = normalizeSpecimen(raw);
    if (!incoming.id) return;
    const cur = specimenMap.get(incoming.id);
    if (!cur) {
      specimenMap.set(incoming.id, incoming);
      counts.specimens.added += 1;
    } else if (incoming.rev > cur.rev) {
      specimenMap.set(incoming.id, incoming);
      counts.specimens.updated += 1;
    } else if (incoming.rev === cur.rev && !sameContent(cur, incoming)) {
      counts.specimens.conflict += 1;
      warnings.push(`标本 ${incoming.specimenNo || incoming.id} 两侧修订号相同但内容不一致，保留本机版，请人工核对。`);
    } else {
      counts.specimens.unchanged += 1;
    }
  });

  /* 材料批次 */
  const supplyMap = new Map<string, SupplyLot>(local.supplies.map((s) => [s.id, s]));
  remote.supplies.forEach((raw) => {
    if (countBackfill(raw)) backfill.supplies += 1;
    const incoming = normalizeSupply(raw);
    if (!incoming.id) return;
    const cur = supplyMap.get(incoming.id);
    if (!cur) {
      supplyMap.set(incoming.id, incoming);
      counts.supplies.added += 1;
    } else if (incoming.rev > cur.rev) {
      supplyMap.set(incoming.id, incoming);
      counts.supplies.updated += 1;
    } else if (incoming.rev === cur.rev && !sameContent(cur, incoming)) {
      counts.supplies.conflict += 1;
      warnings.push(`材料批次 ${incoming.lotNo || incoming.name}（${incoming.id}）两侧修订号相同但内容不一致，保留本机余量，请人工核对。`);
    } else {
      counts.supplies.unchanged += 1;
    }
  });

  /* 工序：两边都动过 → 留两版待核 */
  const procedureMap = new Map<string, PrepProcedure>(
    local.procedures.map((p) => [p.id, { ...p }]),
  );
  const conflicts: MergeConflict[] = [];
  remote.procedures.forEach((raw) => {
    if (countBackfill(raw)) backfill.procedures += 1;
    const incoming = normalizeProcedure(raw);
    if (!incoming.id) return;
    const cur = procedureMap.get(incoming.id);
    if (!cur) {
      procedureMap.set(incoming.id, { ...incoming, conflicts: [] });
      counts.procedures.added += 1;
      return;
    }
    if (procedureContentEqual(incoming, stripConflicts(cur))) {
      counts.procedures.unchanged += 1;
      return;
    }
    if (incoming.rev > cur.rev) {
      procedureMap.set(incoming.id, { ...incoming, conflicts: cur.conflicts ?? [] });
      counts.procedures.updated += 1;
      return;
    }
    if (incoming.rev < cur.rev) {
      counts.procedures.unchanged += 1;
      return;
    }
    // rev 相同且内容不同：无法判定共同版本，按两边都动过处理，留两版待核
    const now = Date.now();
    const localRevision = stripConflicts(cur);
    const remoteRevision = { ...incoming };
    const next: PrepProcedure = {
      ...localRevision,
      rev: cur.rev + 1,
      updatedAt: now,
      conflicts: [
        ...(cur.conflicts ?? []).filter((c) => c.status === 'pending'),
        {
          side: 'local',
          baseRev: incoming.rev,
          snapshot: localRevision,
          status: 'pending',
          flaggedAt: now,
        },
        {
          side: 'remote',
          baseRev: incoming.rev,
          snapshot: remoteRevision,
          status: 'pending',
          flaggedAt: now,
        },
      ],
    };
    procedureMap.set(incoming.id, next);
    counts.procedures.conflict += 1;
    conflicts.push({
      table: 'procedures',
      id: incoming.id,
      local: localRevision,
      remote: remoteRevision,
      baseRev: incoming.rev,
    });
  });

  /* 影像：去重 + 归挂 */
  const photoMap = new Map<string, PrepPhoto>(local.photos.map((p) => [p.id, p]));
  const dedupeKeys = new Set<string>(
    local.photos.map((p) => `${p.specimenId}|${p.capturedAt}|${p.contentHash}`),
  );

  remote.photos.forEach((raw) => {
    if (countBackfill(raw)) backfill.photos += 1;
    const incoming = normalizePhoto(raw);
    if (!incoming.id) return;
    const key = `${incoming.specimenId}|${incoming.capturedAt}|${incoming.contentHash}`;
    if (dedupeKeys.has(key)) {
      counts.photos.deduped += 1;
      return;
    }
    dedupeKeys.add(key);
    photoMap.set(incoming.id, incoming);
    counts.photos.added += 1;
  });

  // 按标本组织工序窗口，供归挂使用
  const windowsBySpecimen = new Map<string, ProcWindow[]>();
  procedureMap.forEach((p) => {
    const list = windowsBySpecimen.get(p.specimenId) ?? [];
    list.push(procWindow(p));
    windowsBySpecimen.set(p.specimenId, list);
  });
  windowsBySpecimen.forEach((list) => list.sort((a, b) => a.start - b.start));

  // 重新挂接：本机孤儿影像与新导入影像都按拍摄时间/阶段归位
  const beforeByProc = new Map<string, string[]>();
  const afterByProc = new Map<string, string[]>();
  let relinked = 0;
  const knownSpecimenIds = new Set(specimenMap.keys());

  photoMap.forEach((photo) => {
    if (!knownSpecimenIds.has(photo.specimenId)) {
      warnings.push(`影像 ${photo.caption || photo.id} 所属标本 ${photo.specimenId} 不在档案中，暂未归挂，请补登标本。`);
      return;
    }
    const windows = windowsBySpecimen.get(photo.specimenId) ?? [];
    const declared = photo.procedureId
      ? windows.find((w) => w.proc.id === photo.procedureId)
      : undefined;
    const target = declared ?? pickProcedure(photo.capturedAt, windows);
    if (!target) return;

    const validStage: PhotoStage = ['before', 'after', 'process'].includes(photo.stage)
      ? photo.stage
      : inferStage(photo.capturedAt, target);
    const finalStage = declared ? validStage : inferStage(photo.capturedAt, target);

    if (photo.procedureId !== target.proc.id || photo.stage !== finalStage) {
      relinked += 1;
      photo.procedureId = target.proc.id;
      photo.stage = finalStage;
      photo.updatedAt = Date.now();
    }
    const bucket = finalStage === 'before' ? beforeByProc : afterByProc;
    const ids = bucket.get(target.proc.id) ?? [];
    ids.push(photo.id);
    bucket.set(target.proc.id, ids);
  });
  counts.photos.relinked = relinked;

  // 依据最终影像归属重建工序上的影像清单；有变化则工序修订号自增
  const affectedSpecimenIds = new Set<string>();
  conflicts.forEach((c) => affectedSpecimenIds.add(c.local.specimenId));

  procedureMap.forEach((proc) => {
    const beforeIds = (beforeByProc.get(proc.id) ?? [])
      .filter((id, i, arr) => arr.indexOf(id) === i)
      .sort();
    const afterIds = (afterByProc.get(proc.id) ?? [])
      .filter((id, i, arr) => arr.indexOf(id) === i)
      .sort();
    const changed =
      JSON.stringify([...proc.photoBeforeIds].sort()) !== JSON.stringify(beforeIds) ||
      JSON.stringify([...proc.photoAfterIds].sort()) !== JSON.stringify(afterIds);
    if (!changed) return;
    proc.photoBeforeIds = beforeIds;
    proc.photoAfterIds = afterIds;
    proc.rev += 1;
    proc.updatedAt = Date.now();
    affectedSpecimenIds.add(proc.specimenId);
  });

  // 受影响标本 / 批次汇总
  remote.procedures.forEach((raw) => {
    const id = str(asRecord(raw).specimenId);
    if (id) affectedSpecimenIds.add(id);
  });
  remote.photos.forEach((raw) => {
    const id = str(asRecord(raw).specimenId);
    if (id) affectedSpecimenIds.add(id);
  });
  const affectedSupplyIds = new Set<string>();
  local.supplies.forEach((s) => {
    const now = supplyMap.get(s.id);
    if (now && !sameContent(s, now)) affectedSupplyIds.add(s.id);
  });
  remote.supplies.forEach((raw) => {
    const id = str(asRecord(raw).id);
    const existed = local.supplies.some((s) => s.id === id);
    if (id && !existed) affectedSupplyIds.add(id);
  });

  /* 合并后重算：完成度 */
  const procedures = [...procedureMap.values()];
  const progressBySpecimen: MergeReport['progressBySpecimen'] = {};
  specimenMap.forEach((s) => {
    const list = procedures.filter((p) => p.specimenId === s.id);
    const total = list.length;
    const done = list.filter((p) => p.state === 'done').length;
    progressBySpecimen[s.id] = {
      total,
      done,
      percent: total === 0 ? 0 : Math.round((done / total) * 100),
    };
  });

  /* 合并后重算：材料余量（在库余量 + 累计领用 + 是否低量） */
  const supplyBalance: MergeReport['supplyBalance'] = {};
  supplyMap.forEach((lot) => {
    const issuedTotal = lot.issues.reduce((sum, it) => sum + it.qty, 0);
    supplyBalance[lot.id] = {
      qty: lot.qty,
      issuedTotal,
      low: lot.qty <= lot.lowThreshold,
    };
  });

  /* 对照说明跟着重算：每个受影响标本一段合并对照记录；纯材料变化另记一段 */
  const compareNotes = [...affectedSpecimenIds]
    .map((sid) => specimenMap.get(sid))
    .filter((s): s is Specimen => !!s)
    .sort((a, b) => a.specimenNo.localeCompare(b.specimenNo))
    .map((s) => {
      const prog = progressBySpecimen[s.id];
      const procConflicts = procedures.filter((p) => p.specimenId === s.id && (p.conflicts?.length ?? 0) > 0).length;
      const photoCount = [...photoMap.values()].filter((p) => p.specimenId === s.id).length;
      return [
        `【离线合并对照 · ${s.specimenNo}】`,
        `工序完成度：${prog.done}/${prog.total}（${prog.percent}%）`,
        `两版待核工序：${procConflicts} 个；当前留痕影像：${photoCount} 张`,
        `合并口径：单边新改直接并入；同号工序双方均改动时保留两版待核；影像按拍摄时间与阶段归挂，重复影像只留一条。`,
      ].join('\n');
    });

  if (affectedSupplyIds.size > 0) {
    const lowLots = [...affectedSupplyIds]
      .map((id) => supplyMap.get(id))
      .filter((l): l is SupplyLot => !!l)
      .filter((l) => supplyBalance[l.id].low)
      .map((l) => `${l.name}(${l.lotNo}) 余 ${l.qty} ${l.unit}`);
    compareNotes.push(
      [
        `【离线合并对照 · 材料余量】`,
        `重算批次：${affectedSupplyIds.size} 个`,
        lowLots.length > 0 ? `低量预警：${lowLots.join('；')}` : '无低量批次。',
      ].join('\n'),
    );
  }

  const legacyBackfilled =
    backfill.specimens + backfill.procedures + backfill.supplies + backfill.photos;
  if (legacyBackfilled > 0) {
    warnings.push(
      `旧留痕包无修订号，已按当前值回填（标本 ${backfill.specimens} / 工序 ${backfill.procedures} / 批次 ${backfill.supplies} / 影像 ${backfill.photos}）。`,
    );
  }

  const report: MergeReport = {
    batchId: remote.batchId,
    source: remote.source,
    importedAt: Date.now(),
    counts,
    conflicts,
    affectedSpecimenIds: [...affectedSpecimenIds],
    affectedSupplyIds: [...affectedSupplyIds],
    progressBySpecimen,
    supplyBalance,
    compareNotes,
    warnings,
  };

  return {
    specimens: [...specimenMap.values()],
    procedures,
    supplies: [...supplyMap.values()],
    photos: [...photoMap.values()],
    report,
  };
}

function stripConflicts(p: PrepProcedure): PrepProcedureRevision {
  const { conflicts: _c, ...rest } = p;
  void _c;
  return rest;
}

/** 取工序当前待核分叉（供待核页使用） */
export function pendingConflicts(p: PrepProcedure): ProcedureConflict[] {
  return (p.conflicts ?? []).filter((c) => c.status === 'pending');
}
