import type { Specimen } from './specimen';
import type { PrepProcedureRevision } from './procedure';
import type { SupplyLot } from './supply';
import type { PrepPhoto } from './photo';

/** 留痕包格式版本 */
export const TRACE_PACKET_VERSION = 1;

/** 留痕包类型标识 */
export const TRACE_PACKET_MAGIC = 'gbfossilprep/trace-packet';

/** 单张表的一批记录（分批写入时一个包就是一个分片） */
export interface TracePacket {
  /** 固定标识，导入时校验 */
  magic: typeof TRACE_PACKET_MAGIC;
  /** 包格式版本 */
  packetVersion: number;
  /** 同一次导出/同一份留痕的批次号，所有分片相同 */
  batchId: string;
  /** 分片序号，从 0 开始 */
  partIndex: number;
  /** 分片总数 */
  partCount: number;
  /** 数据结构版本（历史留痕包可能没有修订号） */
  schemaVersion: number;
  /** 导出端标识（合作修复室 / 本馆） */
  source: string;
  /** 导出时间 */
  exportedAt: number;
  specimens: Specimen[];
  procedures: PrepProcedureRevision[];
  supplies: SupplyLot[];
  photos: PrepPhoto[];
}

/** 合并冲突条目（两版待核） */
export interface MergeConflict {
  table: 'procedures';
  id: string;
  /** 本机版 */
  local: PrepProcedureRevision;
  /** 留痕包版 */
  remote: PrepProcedureRevision;
  baseRev: number;
}

/** 逐表合并计数 */
export interface MergeCounts {
  specimens: { added: number; updated: number; unchanged: number; conflict: number };
  procedures: { added: number; updated: number; unchanged: number; conflict: number };
  supplies: { added: number; updated: number; unchanged: number; conflict: number };
  photos: { added: number; deduped: number; relinked: number };
}

export interface MergeReport {
  /** 来源批次号 */
  batchId: string;
  source: string;
  importedAt: number;
  counts: MergeCounts;
  /** 两版待核的工序数（counts.procedures.conflict 同值） */
  conflicts: MergeConflict[];
  /** 本次合并后受影响、需要重算完成度/材料余量的标本号与材料批号 */
  affectedSpecimenIds: string[];
  affectedSupplyIds: string[];
  /** 合并后重算的完成度，按标本号索引 */
  progressBySpecimen: Record<string, { total: number; done: number; percent: number }>;
  /** 合并后重算的材料余量，按批次 id 索引 */
  supplyBalance: Record<string, { qty: number; issuedTotal: number; low: boolean }>;
  /** 对照说明重算记录（每个受影响标本一段） */
  compareNotes: string[];
  /** 失败/告警信息 */
  warnings: string[];
}

/** 单次导出的分片信息 */
export interface ExportManifest {
  batchId: string;
  partCount: number;
  exportedAt: number;
  sizeBytes: number[];
}
