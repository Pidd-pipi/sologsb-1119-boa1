/** 工序类型 */
export type StepType = '清修' | '加固' | '粘接' | '补配' | '翻模';

export const STEP_TYPES: StepType[] = ['清修', '加固', '粘接', '补配', '翻模'];

/** 各工序类型适用的工具、磨料、胶种候选（表单动态字段用） */
export const STEP_FIELD_MAP: Record<
  StepType,
  { tools: string[]; abrasives: string[]; adhesives: string[]; needConc: boolean }
> = {
  清修: {
    tools: ['气动笔', '剔针', '超声波清洗机', '软毛刷'],
    abrasives: ['400 目', '800 目', '1200 目'],
    adhesives: [],
    needConc: false,
  },
  加固: {
    tools: ['渗透滴管', '真空浸渗罐', '加热台'],
    abrasives: [],
    adhesives: ['Paraloid B-72', '氰基丙烯酸酯', '环氧树脂 E44'],
    needConc: true,
  },
  粘接: {
    tools: ['点胶针', '夹持架', '热风枪'],
    abrasives: [],
    adhesives: ['Paraloid B-72', '氰基丙烯酸酯', '动物胶'],
    needConc: true,
  },
  补配: {
    tools: ['刮刀', '雕刻刀', '石膏模'],
    abrasives: ['600 目', '1000 目'],
    adhesives: ['环氧树脂 E44', 'Paraloid B-72'],
    needConc: true,
  },
  翻模: {
    tools: ['硅胶模具', '真空脱泡机', '石膏桶'],
    abrasives: [],
    adhesives: ['硅橡胶', '石膏浆料'],
    needConc: false,
  },
};

/** 工序节点状态 */
export type ProcedureState = 'pending' | 'done' | 'rolledback';

/** 修订来源 */
export type RevisionSide = 'museum' | 'coop';

/** 修复工序（v3 起带修订号；两版待核时各存一行） */
export interface PrepProcedure {
  id: string;
  specimenId: string;
  stepType: StepType;
  /** 节点名称 */
  nodeName: string;
  /** 序号，不得跳号 */
  seq: number;
  /** 工具 */
  tools: string[];
  /** 磨料目数 */
  abrasive: string;
  /** 胶种 */
  adhesive: string;
  /** 胶液浓度 % */
  adhesiveConc: number;
  /** 耗时 min */
  durationMin: number;
  /** 环境温度 ℃ */
  tempC: number;
  /** 相对湿度 % */
  rh: number;
  photoBeforeIds: string[];
  photoAfterIds: string[];
  operator: string;
  startedAt: number;
  state: ProcedureState;
  finishedAt?: number;
  /** 修订号：本机每次修改 +1；老数据（v1/v2）按当前值回填为 1 */
  rev?: number;
  /** 本次修订时间 */
  updatedAt?: number;
  /** 两版待核时，冲突双方共享同一分组 id；为空表示已核定的正常节点 */
  conflictId?: string;
  /** 该行修订的来源侧（仅 conflictId 非空时有意义） */
  conflictSide?: RevisionSide;
  /** 对侧修订号（仅两版待核行使用，便于核对） */
  conflictOtherRev?: number;
}

export type PrepProcedureDraft = Omit<PrepProcedure, 'id'>;

/** 两版待核分组（供待核 UI 使用） */
export interface ProcedureConflict {
  conflictId: string;
  specimenId: string;
  museum?: PrepProcedure;
  coop?: PrepProcedure;
}

/** 参与修订比较 / 归并的字段（不含 id、修订元数据与影像挂接数组） */
export const PROCEDURE_BUSINESS_FIELDS: (keyof PrepProcedure)[] = [
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

export const PROCEDURE_LABELS: Record<string, string> = {
  specimenId: '所属标本',
  stepType: '工序类型',
  nodeName: '节点名称',
  seq: '序号',
  tools: '工具',
  abrasive: '磨料',
  adhesive: '胶种',
  adhesiveConc: '胶液浓度(%)',
  durationMin: '耗时(min)',
  tempC: '环境温度(℃)',
  rh: '相对湿度(%)',
  operator: '责任人',
  startedAt: '开始时间',
  state: '状态',
  finishedAt: '完成时间',
};
