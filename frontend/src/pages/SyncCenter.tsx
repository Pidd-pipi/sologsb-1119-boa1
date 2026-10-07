import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  LinearProgress,
  MenuItem,
  Paper,
  Snackbar,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import DownloadIcon from '@mui/icons-material/Download';
import RestoreIcon from '@mui/icons-material/Restore';
import PendingActionsIcon from '@mui/icons-material/PendingActions';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import { useSpecimenStore } from '../stores/specimenStore';
import { useProcedureStore } from '../stores/procedureStore';
import { useSupplyStore } from '../stores/supplyStore';
import {
  applyMergePlan,
  buildMergePlan,
  listConflicts,
  listPendingRollbacks,
  resolveConflict,
  rollbackByBatch,
  type ConflictView,
  type MergePlan,
} from '../utils/sync/merge';
import { buildExportPacket, downloadPart, packetFileName, readPacketFiles, summarizeParts } from '../utils/sync/packet';
import type { MergeReport } from '../types/sync';
import { PROCEDURE_LABELS } from '../types/procedure';

function fmtDateTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN');
}

function fmtField(name: string, value: unknown): string {
  if (value === undefined || value === null || value === '') return '—';
  if (name === 'tools') return Array.isArray(value) ? (value as string[]).join('、') || '—' : String(value);
  if (name === 'startedAt' || name === 'finishedAt') return typeof value === 'number' ? fmtDateTime(value) : '—';
  if (name === 'state') {
    return value === 'done' ? '已完成' : value === 'rolledback' ? '已回退' : '待办';
  }
  if (Array.isArray(value)) return value.join('、');
  return String(value);
}

/** /sync 离线留痕包：导出分批、回包合并、回滚、待核修订核定 */
export default function SyncCenter() {
  const fileRef = useRef<HTMLInputElement>(null);
  const specimens = useSpecimenStore((s) => s.items);
  const loadSpecimens = useSpecimenStore((s) => s.load);
  const loadProcedures = useProcedureStore((s) => s.load);
  const loadSupplies = useSupplyStore((s) => s.load);

  const [deviceName, setDeviceName] = useState('馆内工作台');
  const [maxMb, setMaxMb] = useState(4);
  const [exporting, setExporting] = useState(false);
  const [exportInfo, setExportInfo] = useState('');

  const [parseError, setParseError] = useState('');
  const [plan, setPlan] = useState<MergePlan | null>(null);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [report, setReport] = useState<MergeReport | null>(null);
  const [toast, setToast] = useState('');

  const [conflicts, setConflicts] = useState<ConflictView[]>([]);
  const [activeConflict, setActiveConflict] = useState<ConflictView | null>(null);
  const [pendingRollbacks, setPendingRollbacks] = useState<Array<{ batchId: string; count: number }>>([]);

  const specimenNo = useCallback(
    (id: string) => specimens.find((s) => s.id === id)?.specimenNo ?? id,
    [specimens],
  );

  const refreshConflicts = useCallback(async () => {
    setConflicts(await listConflicts());
    setPendingRollbacks(await listPendingRollbacks());
  }, []);

  useEffect(() => {
    void refreshConflicts();
  }, [refreshConflicts, report]);

  const reloadAll = useCallback(async () => {
    await Promise.all([loadSpecimens(), loadProcedures(), loadSupplies()]);
    await refreshConflicts();
  }, [loadSpecimens, loadProcedures, loadSupplies, refreshConflicts]);

  // ---------- 导出 ----------
  const handleExport = async () => {
    setExporting(true);
    setExportInfo('');
    try {
      const bundle = await buildExportPacket({ side: 'museum', deviceName: deviceName.trim() || '馆内工作台', maxBytesPerPart: maxMb * 1_000_000 });
      // 分卷之间稍作停顿，避免浏览器拦截连续下载
      for (let i = 0; i < bundle.parts.length; i += 1) {
        const part = bundle.parts[i];
        downloadPart(part, packetFileName(bundle, part.index, part.total));
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 250));
      }
      setExportInfo(`已生成 ${bundle.parts.length} 个分卷（批次 ${bundle.batchId}），请随标本一起交合作修复室。`);
    } catch (err) {
      setExportInfo(`导出失败：${(err as Error).message}`);
    } finally {
      setExporting(false);
    }
  };

  // ---------- 选择回包文件 ----------
  const handleFiles = async (files: FileList | null) => {
    setParseError('');
    setPlan(null);
    setReport(null);
    if (!files || files.length === 0) return;
    try {
      const parts = await readPacketFiles(Array.from(files));
      const nextPlan = await buildMergePlan(parts);
      setPlan(nextPlan);
    } catch (err) {
      setParseError((err as Error).message);
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const summary = useMemo(() => (plan ? summarizeParts(plan.parts) : null), [plan]);

  // ---------- 确认导入（分批写入） ----------
  const handleImport = async () => {
    if (!plan) return;
    setImporting(true);
    setProgress({ done: 0, total: plan.ops.length });
    try {
      const result = await applyMergePlan(plan, (done, total) => setProgress({ done, total }));
      setReport(result);
      setPlan(null);
      setToast('留痕包已分批写入并完成合并');
      await reloadAll();
    } catch (err) {
      setParseError(`写入失败，已按回滚日志恢复到导入前状态，可修正后重新导入：${(err as Error).message}`);
      await refreshConflicts();
    } finally {
      setImporting(false);
      setProgress(null);
    }
  };

  const handleRollback = async (batchId: string) => {
    await rollbackByBatch(batchId);
    setToast(`批次 ${batchId} 已回滚，可重新导入`);
    await reloadAll();
  };

  const handleResolve = async (chosen: 'museum' | 'coop') => {
    if (!activeConflict) return;
    await resolveConflict(activeConflict.conflictId, chosen);
    setToast(chosen === 'museum' ? '已核定：采用馆内版本' : '已核定：采用合作修复室版本');
    setActiveConflict(null);
    await reloadAll();
  };

  return (
    <Stack spacing={2}>
      <Stack direction="row" alignItems="center" spacing={1}>
        <Typography variant="h5" fontWeight={700}>
          离线合并
        </Typography>
        <Chip size="small" color="warning" icon={<PendingActionsIcon />} label={`待核修订 ${conflicts.length} 处`} />
        <Box sx={{ flex: 1 }} />
        <Button startIcon={<RestoreIcon />} onClick={() => void refreshConflicts()}>
          刷新状态
        </Button>
      </Stack>

      {pendingRollbacks.length > 0 ? (
        <Alert
          severity="error"
          action={
            <Button color="inherit" size="small" onClick={() => void handleRollback(pendingRollbacks[0].batchId)}>
              立即回滚
            </Button>
          }
        >
          检测到 {pendingRollbacks.length} 个批次的导入中途失败（{pendingRollbacks.map((p) => `${p.batchId.slice(-6)}·${p.count}行`).join('，')}），
          日志保留了导入前数据，回滚后可重新导入。
        </Alert>
      ) : null}

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 2 }}>
        {/* 导出 */}
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography variant="subtitle1" fontWeight={700} gutterBottom>
            ① 导出离线留痕包（交合作修复室）
          </Typography>
          <Stack spacing={1.5}>
            <TextField
              size="small"
              label="导出设备名称"
              value={deviceName}
              onChange={(e) => setDeviceName(e.target.value)}
            />
            <TextField
              select
              size="small"
              label="单卷容量上限"
              value={maxMb}
              onChange={(e) => setMaxMb(Number(e.target.value))}
              helperText="整包超容量时自动分批写入多个分卷文件，导入时需全部选上"
            >
              {[1, 2, 4, 8, 16].map((m) => (
                <MenuItem key={m} value={m}>
                  约 {m} MB / 卷
                </MenuItem>
              ))}
            </TextField>
            <Stack direction="row" spacing={1}>
              <Button variant="contained" startIcon={<DownloadIcon />} disabled={exporting} onClick={() => void handleExport()}>
                {exporting ? '正在生成分卷…' : '生成并下载留痕包'}
              </Button>
            </Stack>
            {exportInfo ? <Typography variant="body2" color="text.secondary">{exportInfo}</Typography> : null}
            <Typography variant="caption" color="text.secondary">
              待核未定稿的两版工序不会出馆；影像按拍摄时间排序后随包导出，每卷带 sha-256 校验和。
            </Typography>
          </Stack>
        </Paper>

        {/* 导入 */}
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography variant="subtitle1" fontWeight={700} gutterBottom>
            ② 导入合作修复室送回的留痕包
          </Typography>
          <Stack spacing={1.5}>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => void handleFiles(e.target.files)}
              data-testid="sync-file-input"
            />
            <Button variant="outlined" startIcon={<UploadFileIcon />} onClick={() => fileRef.current?.click()} disabled={importing}>
              选择留痕包分卷（可多选，按批次整包导入）
            </Button>
            {parseError ? <Alert severity="error" data-testid="sync-parse-error">{parseError}</Alert> : null}
            {importing && progress ? (
              <Box>
                <LinearProgress variant="determinate" value={progress.total ? (progress.done / progress.total) * 100 : 0} />
                <Typography variant="caption" color="text.secondary">
                  正在分批写入 {progress.done}/{progress.total} 行…（任一批失败自动回滚）
                </Typography>
              </Box>
            ) : null}
            <Typography variant="caption" color="text.secondary">
              一边新改直接并入；两边都动过的工序留两版待核；影像按时间和阶段归并、重复只留一条。
            </Typography>
          </Stack>
        </Paper>
      </Box>

      {/* 导入预览 */}
      {plan && summary ? (
        <Paper variant="outlined" sx={{ p: 2 }} data-testid="sync-preview">
          <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
            <Typography variant="subtitle1" fontWeight={700}>
              ③ 合并预览 · 批次 {summary.batchId}
            </Typography>
            <Chip size="small" label={`${plan.parts.length} 卷`} />
            <Chip size="small" label={`${(summary.totalBytes / 1_000_000).toFixed(2)} MB`} />
            {plan.isStalePacket ? <Chip size="small" color="warning" label="旧留痕包：本机工序已改动" /> : null}
            {plan.alreadyImported ? <Chip size="small" color="info" label="该批次曾导入" /> : null}
          </Stack>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            来自 {summary.exporter}，导出时间 {fmtDateTime(summary.exportedAt)}；包含标本 {summary.specimens}、工序 {summary.procedures}、
            材料 {summary.supplies}、影像 {summary.photos}。
          </Typography>
          <ReportTable report={plan.report} />
          {plan.report.notes.length > 0 ? (
            <Box sx={{ mt: 1 }}>
              {plan.report.notes.map((n, i) => (
                <Alert key={i} severity={n.includes('请人工核对') ? 'warning' : 'info'} sx={{ mb: 0.5 }}>
                  {n}
                </Alert>
              ))}
            </Box>
          ) : null}
          <Stack direction="row" spacing={1} sx={{ mt: 1.5 }}>
            <Button variant="contained" disabled={importing} onClick={() => void handleImport()} data-testid="sync-confirm-import">
              确认合并并分批写入
            </Button>
            <Button
              disabled={importing}
              onClick={() => {
                setPlan(null);
              }}
            >
              取消
            </Button>
          </Stack>
        </Paper>
      ) : null}

      {/* 合并结果 */}
      {report ? (
        <Paper variant="outlined" sx={{ p: 2 }} data-testid="sync-report">
          <Typography variant="subtitle1" fontWeight={700} gutterBottom>
            合并完成 · {fmtDateTime(report.importedAt)}
          </Typography>
          <ReportTable report={report} />
        </Paper>
      ) : null}

      {/* 待核修订 */}
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Typography variant="subtitle1" fontWeight={700} gutterBottom>
          两版待核工序（{conflicts.length}）
        </Typography>
        {conflicts.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            没有待核工序。合并后完成度、材料余量与前后对照说明已随合并结果自动重算。
          </Typography>
        ) : (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>标本</TableCell>
                <TableCell>序号 / 节点</TableCell>
                <TableCell>差异字段</TableCell>
                <TableCell>馆内版 rev</TableCell>
                <TableCell>合作室版 rev</TableCell>
                <TableCell align="right">操作</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {conflicts.map((c) => (
                <TableRow key={c.conflictId} hover>
                  <TableCell>{specimenNo(c.specimenId)}</TableCell>
                  <TableCell>
                    #{c.museum.seq} {c.museum.stepType} · {c.museum.nodeName}
                  </TableCell>
                  <TableCell>
                    <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                      {c.diffFields.map((f) => (
                        <Chip key={f} size="small" variant="outlined" label={PROCEDURE_LABELS[f] ?? f} />
                      ))}
                    </Stack>
                  </TableCell>
                  <TableCell>r{c.museum.rev ?? 1}</TableCell>
                  <TableCell>r{c.coop.rev ?? 1}</TableCell>
                  <TableCell align="right">
                    <Button size="small" onClick={() => setActiveConflict(c)} data-testid={`open-conflict-${c.conflictId}`}>
                      逐版核对
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Paper>

      <ConflictDialog
        conflict={activeConflict}
        specimenNoText={activeConflict ? specimenNo(activeConflict.specimenId) : ''}
        onClose={() => setActiveConflict(null)}
        onResolve={(side) => void handleResolve(side)}
      />

      <Snackbar open={!!toast} autoHideDuration={2600} onClose={() => setToast('')} message={toast} />
    </Stack>
  );
}

function ReportTable({ report }: { report: MergeReport }) {
  const rows: Array<[string, string | number, string?]> = [
    ['标本新增', report.specimensAdded],
    ['标本并入更新', report.specimensUpdated],
    ['工序新增（合作室单边）', report.proceduresAdded],
    ['工序并入更新（单边新改）', report.proceduresUpdated],
    ['两版待核（两边都动过）', report.conflictsCreated, 'warning'],
    ['旧待核被回包刷新', report.conflictsRefreshed],
    ['内容一致自动核定', report.conflictsResolved, 'success'],
    ['旧包拦截改待核', report.staleTakeoversBlocked, 'warning'],
    ['影像归并新增', report.photosAdded, 'success'],
    ['影像重复去重', report.photosDeduped],
    ['材料批次新增', report.suppliesAdded],
    ['材料批次更新', report.suppliesUpdated],
    ['领用明细合并', report.supplyIssuesMerged],
  ];
  return (
    <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
      {rows
        .filter(([, v]) => (v as number) > 0)
        .map(([label, v, tone]) => (
          <Chip
            key={label}
            size="small"
            variant={tone === 'warning' ? 'filled' : 'outlined'}
            color={tone === 'warning' ? 'warning' : tone === 'success' ? 'success' : 'default'}
            label={`${label} ${v}`}
          />
        ))}
      {rows.every(([, v]) => (v as number) === 0) ? (
        <Typography variant="body2" color="text.secondary">
          回包内容与本机一致，无实际变更。
        </Typography>
      ) : null}
    </Box>
  );
}

function ConflictDialog({
  conflict,
  specimenNoText,
  onClose,
  onResolve,
}: {
  conflict: ConflictView | null;
  specimenNoText: string;
  onClose: () => void;
  onResolve: (side: 'museum' | 'coop') => void;
}) {
  return (
    <Dialog open={!!conflict} onClose={onClose} maxWidth="lg" fullWidth>
      <DialogTitle>
        逐版核对 · {specimenNoText} · #{conflict?.museum.seq} {conflict?.museum.stepType} · {conflict?.museum.nodeName}
      </DialogTitle>
      <DialogContent>
        {conflict ? (
          <Stack spacing={1}>
            <Alert severity="info">
              同一工序两边都动过，已各留一版。核定一版后另一版删除，其独有影像会按拍摄时间并入定稿版本，重复影像只留一条。
            </Alert>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>字段</TableCell>
                  <TableCell>
                    馆内版 <Chip size="small" label={`rev ${conflict.museum.rev ?? 1}`} />
                  </TableCell>
                  <TableCell>
                    合作修复室版 <Chip size="small" color="primary" variant="outlined" label={`rev ${conflict.coop.rev ?? 1}`} />
                  </TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {conflict.diffFields.map((f) => {
                  const mv = (conflict.museum as unknown as Record<string, unknown>)[f];
                  const cv = (conflict.coop as unknown as Record<string, unknown>)[f];
                  return (
                    <TableRow key={f}>
                      <TableCell sx={{ whiteSpace: 'nowrap' }}>{PROCEDURE_LABELS[f] ?? f}</TableCell>
                      <TableCell>{fmtField(f, mv)}</TableCell>
                      <TableCell>{fmtField(f, cv)}</TableCell>
                    </TableRow>
                  );
                })}
                <TableRow>
                  <TableCell>影像挂接</TableCell>
                  <TableCell>
                    前 {conflict.museum.photoBeforeIds.length} / 后 {conflict.museum.photoAfterIds.length}
                  </TableCell>
                  <TableCell>
                    前 {conflict.coop.photoBeforeIds.length} / 后 {conflict.coop.photoAfterIds.length}
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </Stack>
        ) : null}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>再看看</Button>
        <Divider orientation="vertical" flexItem sx={{ mx: 1 }} />
        <Button
          variant="outlined"
          startIcon={<CheckCircleIcon />}
          onClick={() => onResolve('coop')}
          data-testid="resolve-coop"
        >
          采用合作室版
        </Button>
        <Button variant="contained" startIcon={<CheckCircleIcon />} onClick={() => onResolve('museum')} data-testid="resolve-museum">
          采用馆内版
        </Button>
      </DialogActions>
    </Dialog>
  );
}
