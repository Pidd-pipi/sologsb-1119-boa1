import { useMemo } from 'react';
import { useProcedureStore } from '../stores/procedureStore';
import type { PrepProcedure } from '../types/procedure';
import { findSeqGaps } from '../utils/id';

export interface PrepProgress {
  list: PrepProcedure[];
  total: number;
  done: number;
  rolledback: number;
  percent: number;
  /** 当前待办节点 */
  current: PrepProcedure | undefined;
  /** 跳号（应为空） */
  gaps: number[];
}

/**
 * 计算某标本的工序完成度与当前待办节点。
 * 被标本详情页与工序录入页消费。
 */
export function usePrepProgress(specimenId: string | undefined): PrepProgress {
  const items = useProcedureStore((s) => s.items);

  return useMemo<PrepProgress>(() => {
    const list = items
      .filter((it) => (specimenId ? it.specimenId === specimenId : true))
      .sort((a, b) => a.seq - b.seq);
    const done = list.filter((it) => it.state === 'done').length;
    const rolledback = list.filter((it) => it.state === 'rolledback').length;
    const percent = list.length === 0 ? 0 : Math.round((done / list.length) * 100);
    const current = list.find((it) => it.state !== 'done');
    const gaps = findSeqGaps(list.map((it) => it.seq));
    return { list, total: list.length, done, rolledback, percent, current, gaps };
  }, [items, specimenId]);
}
