import type { Specimen } from '../types/specimen';
import type { PrepProcedure, PrepProcedureRevision } from '../types/procedure';
import type { SupplyLot } from '../types/supply';
import type { PrepPhoto } from '../types/photo';
import {
  TRACE_PACKET_MAGIC,
  TRACE_PACKET_VERSION,
  type ExportManifest,
  type MergeReport,
  type TracePacket,
} from '../types/trace';
import { db } from './db';
import { byteLength } from './hash';
import { mergeOfflinePacket, type LocalSnapshot, type RemotePacketData } from './offlineMerge';

/** 单包目标容量（约 8 MB JSON；真实文件下载无硬限，留足余量，超了自动分批） */
export const DEFAULT_PACKET_LIMIT_BYTES = 8 * 1024 * 1024;

/** localStorage 键：本机工序最后改动时间——在此之前导出的旧留痕包视为失效 */
export const LS_DIRTY_SINCE_KEY = 'gbfossilprep:dirty-since';
/** localStorage 键：已成功合并的批次（同批次重导幂等、漏片可补） */
export const LS_IMPORTED_BATCHES_KEY = 'gbfossilprep:imported-batches';
/** localStorage 键：最近一次合并报告（页面回显） */
export const LS_LAST_MERGE_REPORT_KEY = 'gbfossilprep:last-merge-report';

export interface ExportBundle {
  /** 分片文件名 → 内容 */
  files: { name: string; content: string }[];
  manifest: ExportManifest;
}

export class PacketValidationError extends Error {}
export class PacketStaleError extends Error {}

/* ------------------------------------------------------------------ */
/* 导出：构造留痕包，超容量分批写入                                     */
/* ------------------------------------------------------------------ */

export interface BuildOptions {
  source: string;
  schemaVersion: number;
  maxBytes?: number;
  /** 导出时间，便于测试注入 */
  now?: number;
}

/**
 * 把本机全量数据序列化为留痕包；按 maxBytes 分批。
 * 影像逐条打包，单张影像自身超限会抛错（避免静默丢数据）。
 */
export function buildTracePackets(
  data: {
    specimens: Specimen[];
    procedures: PrepProcedure[];
    supplies: SupplyLot[];
    photos: PrepPhoto[];
  },
  options: BuildOptions,
): ExportBundle {
  const maxBytes = options.maxBytes ?? DEFAULT_PACKET_LIMIT_BYTES;
  const now = options.now ?? Date.now();
  const batchId = `trc_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  // 非影像数据固定放入第 0 片
  const chunks: { specimens: Specimen[]; procedures: PrepProcedureRevision[]; supplies: SupplyLot[]; photos: PrepPhoto[] }[] = [
    { specimens: data.specimens, procedures: data.procedures.map(stripProcConflicts), supplies: data.supplies, photos: [] },
  ];

  const packet = (partIndex: number, partCount: number, body: (typeof chunks)[number]): TracePacket => ({
    magic: TRACE_PACKET_MAGIC,
    packetVersion: TRACE_PACKET_VERSION,
    batchId,
    partIndex,
    partCount,
    schemaVersion: options.schemaVersion,
    source: options.source,
    exportedAt: now,
    ...body,
  });

  const serialize = (p: TracePacket): string => JSON.stringify(p);

  // 先看看非影像部分是否已经超容量（极少见，直接报错，不丢数据）
  const skeleton = packet(0, 1, chunks[0]);
  if (byteLength(serialize(skeleton)) > maxBytes) {
    throw new PacketValidationError('非影像数据已超过单包容量，无法在当前限制下导出，请收窄导出范围。');
  }

  // 贪心装箱：逐张影像往当前片里塞，塞不下就新开一片
  let cursor = 0;
  for (const photo of data.photos) {
    const single = packet(0, 1, { ...chunks[cursor], photos: [photo] });
    if (byteLength(JSON.stringify(single.photos)) + 2 > maxBytes) {
      throw new PacketValidationError(`影像 ${photo.id} 单张超过包体容量，无法分批。`);
    }
    const candidate = packet(cursor, 1, { ...chunks[cursor], photos: [...chunks[cursor].photos, photo] });
    if (cursor === 0 && byteLength(serialize(candidate)) <= maxBytes) {
      chunks[cursor].photos.push(photo);
      continue;
    }
    if (cursor > 0) {
      const base = packet(cursor, 1, { ...chunks[cursor] });
      const photoBytes = byteLength(JSON.stringify(photo)) + 1;
      if (byteLength(serialize(base)) + photoBytes <= maxBytes) {
        chunks[cursor].photos.push(photo);
        continue;
      }
    }
    cursor += 1;
    chunks.push({ specimens: [], procedures: [], supplies: [], photos: [photo] });
  }

  const partCount = chunks.length;
  const files = chunks.map((body, index) => {
    const p = packet(index, partCount, body);
    const content = serialize(p);
    const suffix = partCount === 1 ? '' : `_part${index + 1}of${partCount}`;
    return {
      name: `gbfossilprep-trace_${new Date(now).toISOString().slice(0, 10)}${suffix}.json`,
      content,
    };
  });

  return {
    files,
    manifest: { batchId, partCount, exportedAt: now, sizeBytes: files.map((f) => byteLength(f.content)) },
  };
}

function stripProcConflicts(p: PrepProcedure): PrepProcedureRevision {
  const { conflicts: _c, ...rest } = p;
  void _c;
  return rest;
}

/* ------------------------------------------------------------------ */
/* 导入：校验分片 → 合并 → 单事务写入（失败由 Dexie 回滚整个导入）      */
/* ------------------------------------------------------------------ */

export function parseTracePacket(text: string): TracePacket {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new PacketValidationError(`留痕包不是合法 JSON：${(e as Error).message}`);
  }
  const p = parsed as Partial<TracePacket>;
  if (!p || p.magic !== TRACE_PACKET_MAGIC) {
    throw new PacketValidationError('文件标识不符，不是本系统的离线留痕包。');
  }
  if (p.packetVersion !== TRACE_PACKET_VERSION) {
    throw new PacketValidationError(`留痕包版本 ${p.packetVersion} 不被支持（当前支持 v${TRACE_PACKET_VERSION}）。`);
  }
  if (!Array.isArray(p.specimens) || !Array.isArray(p.procedures) || !Array.isArray(p.supplies) || !Array.isArray(p.photos)) {
    throw new PacketValidationError('留痕包缺少必需的数据表。');
  }
  if (typeof p.partIndex !== 'number' || typeof p.partCount !== 'number' || p.partIndex < 0 || p.partCount < 1) {
    throw new PacketValidationError('留痕包分片信息缺失或非法。');
  }
  if (p.partIndex >= p.partCount) {
    throw new PacketValidationError('留痕包分片序号越界。');
  }
  return p as TracePacket;
}

/** 校验同批次分片齐全且无重复；返回按序排好的包 */
export function validatePacketSet(packets: TracePacket[]): TracePacket[] {
  if (packets.length === 0) throw new PacketValidationError('没有可导入的留痕包。');
  const batchId = packets[0].batchId;
  if (!batchId) throw new PacketValidationError('留痕包缺少批次号。');
  if (!packets.every((p) => p.batchId === batchId)) {
    throw new PacketValidationError('所选文件来自不同导出批次，不能混导；请只选择同一批的分片。');
  }
  const seen = new Set<number>();
  const expected = packets[0].partCount;
  for (const p of packets) {
    if (p.partCount !== expected) throw new PacketValidationError('同批次分片的总数标记不一致。');
    if (seen.has(p.partIndex)) throw new PacketValidationError(`分片 ${p.partIndex + 1} 重复选择。`);
    seen.add(p.partIndex);
  }
  if (seen.size !== expected) {
    const missing: number[] = [];
    for (let i = 0; i < expected; i += 1) if (!seen.has(i)) missing.push(i + 1);
    throw new PacketValidationError(`分片不齐：缺第 ${missing.join('、')} 片，共 ${expected} 片。`);
  }
  return [...packets].sort((a, b) => a.partIndex - b.partIndex);
}

/* ---- 失效标记：本机工序改动后，在此之前的旧留痕包失效 ---- */

/** 标记的底层存取，默认走 localStorage，测试可注入 */
let markerStore: { getItem: (k: string) => string | null; setItem: (k: string, v: string) => void } | null = null;

export function __setMarkerStoreForTest(store: typeof markerStore): void {
  markerStore = store;
}

function markerGetItem(k: string): string | null {
  if (markerStore) return markerStore.getItem(k);
  return window.localStorage.getItem(k);
}

function markerSetItem(k: string, v: string): void {
  if (markerStore) {
    markerStore.setItem(k, v);
    return;
  }
  try {
    window.localStorage.setItem(k, v);
  } catch {
    /* localStorage 不可用时忽略 */
  }
}

export function markLocalProceduresChanged(at = Date.now()): void {
  markerSetItem(LS_DIRTY_SINCE_KEY, String(at));
}

export function readDirtySince(): number {
  try {
    const raw = markerGetItem(LS_DIRTY_SINCE_KEY);
    return raw ? Number(raw) || 0 : 0;
  } catch {
    return 0;
  }
}

export function getImportedBatches(): Record<string, number> {
  try {
    return JSON.parse(window.localStorage.getItem(LS_IMPORTED_BATCHES_KEY) || '{}') as Record<string, number>;
  } catch {
    return {};
  }
}

function rememberImportedBatch(batchId: string, at: number): void {
  try {
    const all = getImportedBatches();
    all[batchId] = at;
    window.localStorage.setItem(LS_IMPORTED_BATCHES_KEY, JSON.stringify(all));
  } catch {
    /* 忽略配额问题 */
  }
}

export function getLastMergeReport(): MergeReport | null {
  try {
    const raw = window.localStorage.getItem(LS_LAST_MERGE_REPORT_KEY);
    return raw ? (JSON.parse(raw) as MergeReport) : null;
  } catch {
    return null;
  }
}

function saveLastMergeReport(report: MergeReport): void {
  try {
    window.localStorage.setItem(LS_LAST_MERGE_REPORT_KEY, JSON.stringify(report));
  } catch {
    /* 忽略配额问题 */
  }
}

/** 旧包失效校验：本机工序已改动，且留痕包导出早于改动点 → 拒绝 */
export function assertPacketNotStale(packet: TracePacket): void {
  const dirtySince = readDirtySince();
  if (dirtySince > 0 && packet.exportedAt < dirtySince) {
    throw new PacketStaleError(
      `该留痕包导出于 ${new Date(packet.exportedAt).toLocaleString('zh-CN')}，之后本机工序已有改动，旧包已失效，请让修复室基于最新留痕重新导出后再导。`,
    );
  }
}

export interface ApplyResult {
  report: MergeReport;
  /** 同一批次此前是否已成功导入过（重导只做幂等对账，不产生重复写入语义） */
  alreadyImported: boolean;
}

/**
 * 合并并写入一整套留痕包分片。
 * 全程在单个 Dexie 读写事务内执行：任一步失败，四张表整体回滚，可重新导入。
 */
export async function applyTracePackets(packetsInput: TracePacket[]): Promise<ApplyResult> {
  const packets = validatePacketSet(packetsInput);
  const head = packets[0];
  assertPacketNotStale(head);

  const remote: RemotePacketData = {
    source: head.source,
    batchId: head.batchId,
    exportedAt: head.exportedAt,
    schemaVersion: head.schemaVersion,
    specimens: packets.flatMap((p) => p.specimens),
    procedures: packets.flatMap((p) => p.procedures),
    supplies: packets.flatMap((p) => p.supplies),
    photos: packets.flatMap((p) => p.photos),
  };

  const merged = await db.transaction('rw', db.specimens, db.procedures, db.supplies, db.photos, async () => {
    const local: LocalSnapshot = {
      specimens: await db.specimens.toArray(),
      procedures: await db.procedures.toArray(),
      supplies: await db.supplies.toArray(),
      photos: await db.photos.toArray(),
    };
    const result = mergeOfflinePacket(local, remote);
    await db.specimens.bulkPut(result.specimens);
    await db.procedures.bulkPut(result.procedures);
    await db.supplies.bulkPut(result.supplies);
    await db.photos.bulkPut(result.photos);
    return result;
  });

  const already = !!getImportedBatches()[head.batchId];
  rememberImportedBatch(head.batchId, Date.now());
  saveLastMergeReport(merged.report);
  return { report: merged.report, alreadyImported: already };
}

/* ------------------------------------------------------------------ */
/* 浏览器端文件下载（页面调用）                                          */
/* ------------------------------------------------------------------ */

export function downloadTextFile(name: string, content: string): void {
  const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
