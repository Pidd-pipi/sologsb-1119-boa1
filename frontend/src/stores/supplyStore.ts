import { create } from 'zustand';
import { db } from '../utils/db';
import { newId } from '../utils/id';
import type { SupplyIssue, SupplyLot, SupplyLotDraft } from '../types/supply';

interface SupplyState {
  items: SupplyLot[];
  loaded: boolean;
  load: () => Promise<void>;
  add: (draft: SupplyLotDraft) => Promise<SupplyLot>;
  issue: (id: string, payload: Omit<SupplyIssue, 'id' | 'issuedAt'>) => Promise<void>;
  trace: (lotNo: string) => SupplyLot[];
}

export const useSupplyStore = create<SupplyState>((set, get) => ({
  items: [],
  loaded: false,
  async load() {
    const items = await db.supplies.toArray();
    items.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
    set({ items, loaded: true });
  },
  async add(draft) {
    const record: SupplyLot = { ...draft, id: newId('sup'), issues: [] };
    await db.supplies.put(record);
    set({ items: [...get().items, record] });
    return record;
  },
  async issue(id, payload) {
    const target = get().items.find((it) => it.id === id);
    if (!target) return;
    const issue: SupplyIssue = { ...payload, id: newId('iss'), issuedAt: Date.now() };
    const next: SupplyLot = {
      ...target,
      qty: Math.max(0, target.qty - payload.qty),
      issues: [issue, ...target.issues],
    };
    await db.supplies.put(next);
    set({ items: get().items.map((it) => (it.id === id ? next : it)) });
  },
  trace(lotNo) {
    if (!lotNo) return get().items;
    return get().items.filter((it) => it.lotNo.includes(lotNo) || it.name.includes(lotNo));
  },
}));
