import { useMemo, useState } from 'react';
import { useSpecimenStore } from '../stores/specimenStore';
import type { Specimen, SpecimenStatus } from '../types/specimen';

export type SpecimenSortKey = 'createdAt' | 'specimenNo' | 'weight';

export interface SpecimenFilters {
  keyword: string;
  taxon: string;
  locality: string;
  status: SpecimenStatus | 'all';
  sortBy: SpecimenSortKey;
}

export const DEFAULT_SPECIMEN_FILTERS: SpecimenFilters = {
  keyword: '',
  taxon: 'all',
  locality: 'all',
  status: 'all',
  sortBy: 'createdAt',
};

/**
 * 按号、分类、产地、状态多条件过滤排序。
 * 被标本台账（/specimens）与前后对照页（/compare/:specimenId）消费。
 */
export function useSpecimenSearch(initial?: Partial<SpecimenFilters>) {
  const items = useSpecimenStore((s) => s.items);
  const loaded = useSpecimenStore((s) => s.loaded);
  const [filters, setFilters] = useState<SpecimenFilters>({
    ...DEFAULT_SPECIMEN_FILTERS,
    ...initial,
  });

  const options = useMemo(() => {
    const taxa = Array.from(new Set(items.map((it) => it.taxon))).filter(Boolean);
    const localities = Array.from(new Set(items.map((it) => it.locality))).filter(Boolean);
    return { taxa, localities };
  }, [items]);

  const result = useMemo<Specimen[]>(() => {
    const kw = filters.keyword.trim().toLowerCase();
    const filtered = items.filter((it) => {
      if (kw) {
        const hit =
          it.specimenNo.toLowerCase().includes(kw) ||
          it.taxon.toLowerCase().includes(kw) ||
          it.horizon.toLowerCase().includes(kw) ||
          it.storageBox.toLowerCase().includes(kw);
        if (!hit) return false;
      }
      if (filters.taxon !== 'all' && it.taxon !== filters.taxon) return false;
      if (filters.locality !== 'all' && it.locality !== filters.locality) return false;
      if (filters.status !== 'all' && it.status !== filters.status) return false;
      return true;
    });
    const sorted = [...filtered];
    sorted.sort((a, b) => {
      if (filters.sortBy === 'specimenNo') return a.specimenNo.localeCompare(b.specimenNo);
      if (filters.sortBy === 'weight') return b.weight - a.weight;
      return b.createdAt - a.createdAt;
    });
    return sorted;
  }, [items, filters]);

  const patchFilters = (patch: Partial<SpecimenFilters>) =>
    setFilters((prev) => ({ ...prev, ...patch }));

  return { filters, setFilters, patchFilters, reset: () => setFilters(DEFAULT_SPECIMEN_FILTERS), result, options, loaded };
}
