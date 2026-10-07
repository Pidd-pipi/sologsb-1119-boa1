/** 生成本地唯一 id */
export function newId(prefix = 'id'): string {
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${stamp}${rand}`;
}

/** 排序用序号生成：返回当前节点数 + 1 */
export function nextSeq(existing: number[]): number {
  if (existing.length === 0) return 1;
  return Math.max(...existing) + 1;
}

/** 检查序号是否跳号，返回缺失的序号列表 */
export function findSeqGaps(seqs: number[]): number[] {
  if (seqs.length === 0) return [];
  const max = Math.max(...seqs);
  const set = new Set(seqs);
  const gaps: number[] = [];
  for (let i = 1; i <= max; i += 1) {
    if (!set.has(i)) gaps.push(i);
  }
  return gaps;
}
