/**
 * 离线留痕包的打包与解包：
 * - 导出时按体积上限分批（每卷自带校验和，可独立校验）；
 * - 导入时逐卷解析、验卷、拼回整包；
 * - 待核两版行不导出（未定稿数据不得出馆）。
 */
import { db } from '../../utils/db';
import { digestText } from '../../utils/hash';
import { newId } from '../../utils/id';
import { PACKET_FORMAT, PACKET_FORMAT_VERSION, type SyncPacketPart } from '../../types/sync';
import type { PrepPhoto } from '../../types/photo';
import type { PrepProcedure } from '../../types/procedure';
import type { Specimen } from '../../types/specimen';
import type { SupplyLot } from '../../types/supply';

/** 单卷默认容量（约 3.8 MB，低于导入侧的 3.5MB 写入批是为留出头部与余量） */
export const DEFAULT_PART_BYTES = 3_800_000;

export interface ExportBundle {
  batchId: string;
  exportedAt: number;
  parts: SyncPacketPart[];
}

/** 不含 checksum 的稳定 JSON（键排序），保证两端逐字一致 */
function stableJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

async function checksumOf(part: Omit<SyncPacketPart, 'checksum'>): Promise<string> {
  const { hex } = await digestText(stableJson(part));
  return hex;
}

/** 估算 UTF-8 字节数（dataUrl 是 ASCII，长度近似足够用于分卷） */
function byteLen(text: string): number {
  return new TextEncoder().encode(text).length;
}

interface ChunkBucket {
  specimens: Specimen[];
  procedures: PrepProcedure[];
  supplies: SupplyLot[];
  photos: PrepPhoto[];
  bytes: number;
}

function emptyBucket(): ChunkBucket {
  return { specimens: [], procedures: [], supplies: [], photos: [], bytes: 0 };
}

/**
 * 贪心装卷：先把影像（最大）逐条放入，放不下就开新卷；
 * 其余小记录顺序填入。保证每张影像都在单卷容量内（超出时单独成卷）。
 */
function chunkEntities(
  specimens: Specimen[],
  procedures: PrepProcedure[],
  supplies: SupplyLot[],
  photos: PrepPhoto[],
  maxBytes: number,
): Omit<SyncPacketPart, 'format' | 'formatVersion' | 'batchId' | 'index' | 'total' | 'exportedAt' | 'exporter' | 'checksum'>[] {
  const buckets: ChunkBucket[] = [emptyBucket()];
  const cur = () => buckets[buckets.length - 1];

  // 卷头部（格式字段 + JSON 结构括号等）固定开销
  const PART_OVERHEAD = 600;

  const push = (kind: keyof Omit<ChunkBucket, 'bytes'>, row: unknown) => {
    const size = byteLen(JSON.stringify(row)) + 16;
    // 当前卷放不下（连头部开销）就开新卷；空卷即使单条超容也照收，保证任何大影像至少独占一卷
    if (cur().bytes > 0 && cur().bytes + size + PART_OVERHEAD > maxBytes) buckets.push(emptyBucket());
    (cur()[kind] as unknown[]).push(row);
    cur().bytes += size;
  };

  for (const s of specimens) push('specimens', s);
  for (const p of procedures) push('procedures', p);
  for (const s of supplies) push('supplies', s);
  for (const p of photos) push('photos', p);

  return buckets
    .filter((b) => b.specimens.length + b.procedures.length + b.supplies.length + b.photos.length > 0)
    .map((b) => ({ specimens: b.specimens, procedures: b.procedures, supplies: b.supplies, photos: b.photos }));
}

export interface BuildPacketOptions {
  side?: 'museum' | 'coop';
  deviceName?: string;
  maxBytesPerPart?: number;
}

/** 从本机库构建离线留痕包（可多分卷） */
export async function buildExportPacket(opts: BuildPacketOptions = {}): Promise<ExportBundle> {
  const [specimens, proceduresRaw, supplies, photosRaw] = await Promise.all([
    db.specimens.toArray(),
    db.procedures.toArray(),
    db.supplies.toArray(),
    db.photos.toArray(),
  ]);
  // 待核行未定稿，不进入留痕包；其挂接影像只随馆内版出包
  const conflictCoopIds = new Set(
    proceduresRaw.filter((p) => p.conflictId && p.conflictSide === 'coop').map((p) => p.id),
  );
  const procedures = proceduresRaw
    .filter((p) => !conflictCoopIds.has(p.id))
    .map((p) => ({ ...p, conflictId: undefined, conflictSide: undefined, conflictOtherRev: undefined }));
  const photos = photosRaw
    .filter((p) => !conflictCoopIds.has(p.procedureId)) // 仅排除挂在待核合作室行上的影像
    .map((p) => ({ ...p }))
    .sort((a, b) => a.capturedAt - b.capturedAt);

  const batchId = newId('pkt');
  const exportedAt = Date.now();
  const maxBytes = Math.max(20_000, opts.maxBytesPerPart ?? DEFAULT_PART_BYTES);

  const chunks = chunkEntities(specimens, procedures, supplies, photos, maxBytes);
  const total = chunks.length;
  const parts: SyncPacketPart[] = [];
  for (let i = 0; i < total; i += 1) {
    const part: SyncPacketPart = {
      format: PACKET_FORMAT,
      formatVersion: PACKET_FORMAT_VERSION,
      batchId,
      index: i + 1,
      total,
      exportedAt,
      exporter: { side: opts.side ?? 'museum', name: opts.deviceName ?? '馆内工作台' },
      specimens: chunks[i].specimens,
      procedures: chunks[i].procedures,
      supplies: chunks[i].supplies,
      photos: chunks[i].photos,
      checksum: '',
    };
    const { checksum, ...rest } = part;
    void checksum;
    part.checksum = await checksumOf(rest);
    parts.push(part);
  }
  return { batchId, exportedAt, parts };
}

/** 单卷落盘文件名 */
export function packetFileName(bundle: Pick<ExportBundle, 'batchId'>, index: number, total: number): string {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `gbfossilprep-trace_${stamp}_${bundle.batchId}_${index}-of-${total}.json`;
}

/** 浏览器端下载一卷（或单卷整包） */
export function downloadPart(part: SyncPacketPart, filename?: string): void {
  const blob = new Blob([JSON.stringify(part, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename ?? packetFileName({ batchId: part.batchId }, part.index, part.total);
  a.click();
  URL.revokeObjectURL(url);
}

export class PacketParseError extends Error {}

/** 解析单个 JSON 文本为分卷（先不验卷） */
function coerceParts(json: unknown): SyncPacketPart[] {
  const list: unknown[] = [];
  if (Array.isArray(json)) list.push(...json);
  else if (json && typeof json === 'object' && Array.isArray((json as { parts?: unknown[] }).parts)) {
    list.push(...(json as { parts: unknown[] }).parts);
  } else if (json) {
    list.push(json);
  }
  for (const item of list) {
    const p = item as Partial<SyncPacketPart>;
    if (p.format !== PACKET_FORMAT) {
      throw new PacketParseError('不是 gbfossilprep 留痕包文件（format 不匹配）');
    }
    if (p.formatVersion !== PACKET_FORMAT_VERSION) {
      throw new PacketParseError(`留痕包格式版本不受支持：收到 v${p.formatVersion}，本机需要 v${PACKET_FORMAT_VERSION}`);
    }
    if (!p.batchId || !p.checksum) throw new PacketParseError('留痕包分卷缺少批次号或校验和');
  }
  return list as SyncPacketPart[];
}

/** 读取并解析一个/多个留痕包文件，逐卷校验并按卷序拼回 */
export async function readPacketFiles(files: File[]): Promise<SyncPacketPart[]> {
  if (files.length === 0) throw new PacketParseError('未选择留痕包文件');
  const texts = await Promise.all(
    files.map(async (f) => {
      try {
        return await f.text();
      } catch {
        throw new PacketParseError(`无法读取文件：${f.name}`);
      }
    }),
  );

  const parts: SyncPacketPart[] = [];
  for (const text of texts) {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new PacketParseError('留痕包不是合法 JSON，文件可能已损坏');
    }
    parts.push(...coerceParts(json));
  }

  const batchIds = new Set(parts.map((p) => p.batchId));
  if (batchIds.size !== 1) {
    throw new PacketParseError(`选中文件属于 ${batchIds.size} 个不同批次，请按批次分别导入`);
  }

  // 逐卷校验和
  for (const p of parts) {
    const { checksum, ...rest } = p;
    const expect = await checksumOf(rest);
    if (expect !== checksum) {
      throw new PacketParseError(`第 ${p.index}/${p.total} 卷校验失败（内容可能损坏或被改动），整包未导入`);
    }
  }

  const total = parts[0].total;
  const byIndex = new Map(parts.map((p) => [p.index, p]));
  if (byIndex.size !== parts.length) throw new PacketParseError('存在重复卷号，请去掉重复文件后重试');
  const missing: number[] = [];
  for (let i = 1; i <= total; i += 1) if (!byIndex.has(i)) missing.push(i);
  if (missing.length > 0) {
    throw new PacketParseError(`留痕包缺少分卷：第 ${missing.join('、')} 卷（共 ${total} 卷），请补齐后再导入`);
  }
  if (parts.some((p) => p.total !== total)) throw new PacketParseError('各分卷声明的总卷数不一致');

  return Array.from({ length: total }, (_, i) => byIndex.get(i + 1) as SyncPacketPart);
}

/** 分卷内容的统计信息（导入预览用） */
export function summarizeParts(parts: SyncPacketPart[]): {
  specimens: number;
  procedures: number;
  supplies: number;
  photos: number;
  totalBytes: number;
  exporter: string;
  exportedAt: number;
  batchId: string;
} {
  return {
    specimens: parts.reduce((s, p) => s + p.specimens.length, 0),
    procedures: parts.reduce((s, p) => s + p.procedures.length, 0),
    supplies: parts.reduce((s, p) => s + p.supplies.length, 0),
    photos: parts.reduce((s, p) => s + p.photos.length, 0),
    totalBytes: parts.reduce((s, p) => s + byteLen(JSON.stringify(p)), 0),
    exporter: `${parts[0].exporter.name}（${parts[0].exporter.side === 'coop' ? '合作修复室' : '馆内'}）`,
    exportedAt: parts[0].exportedAt,
    batchId: parts[0].batchId,
  };
}
