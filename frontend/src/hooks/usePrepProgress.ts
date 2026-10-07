import { useMemo } from 'react';
import { useProcedureStore } from '../stores/procedureStore';
import type { PrepProcedure } from '../types/procedure';
import { findSeqGaps } from '../utils/id';

export interface PrepProgress {
  /** 全部节点（两版待核时两版都在，供时间线逐条展示） */
  list: PrepProcedure[];
  /** 核定口径：普通行 + 每个待核组取馆内版（完成度/跳号按此重算） */
  canonical: PrepProcedure[];
  total: number;
  done: number;
  rolledback: number;
  percent: number;
  /** 两版待核分组数 */
  conflictCount: number;
  /** 当前待办节点 */
  current: PrepProcedure | undefined;
  /** 跳号（应为空） */
  gaps: number[];
}

const bySeq = (a: PrepProcedure, b: PrepProcedure) => a.seq - b.seq || a.startedAt - b.startedAt;

/**
 * 计算某标本的工序完成度与当前待办节点。
 * 两版待核的工序只按馆内版计入一次，避免重复统计。
 * 被标本详情页、工序录入页与前后对照页消费。
 */
export function usePrepProgress(specimenId: string | undefined): PrepProgress {
  const items = useProcedureStore((s) => s.items);

  return useMemo<PrepProgress>(() => {
    const list = items.filter((it) => (specimenId ? it.specimenId === specimenId : true)).sort(bySeq);

    // 待核组去重：完成度按馆内版计一次；时间线仍通过 list 展示两版
    const seenConflict = new Set<string>();
    const canonical: PrepProcedure[] = [];
    let conflictCount = 0;
    for (const it of list) {
      if (!it.conflictId) {
        canonical.push(it);
        continue;
      }
      if (it.conflictSide === 'museum') {
        conflictCount += 1;
        canonical.push(it);
      }
      seenConflict.add(it.conflictId);
    }
    canonical.sort(bySeq);

    const done = canonical.filter((it) => it.state === 'done').length;
    const rolledback = canonical.filter((it) => it.state === 'rolledback').length;
    const percent = canonical.length === 0 ? 0 : Math.round((done / canonical.length) * 100);
    const current = canonical.find((it) => it.state !== 'done');
    const gaps = findSeqGaps(canonical.map((it) => it.seq));
    return { list, canonical, total: canonical.length, done, rolledback, percent, conflictCount, current, gaps };
  }, [items, specimenId]);
}
