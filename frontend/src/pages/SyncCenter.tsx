import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import Alert from '@mui/material/Alert';
import Snackbar from '@mui/material/Snackbar';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import DownloadIcon from '@mui/icons-material/Download';
import GavelIcon from '@mui/icons-material/Gavel';
import { useSpecimenStore } from '../stores/specimenStore';
import { useProcedureStore } from '../stores/procedureStore';
import { useSupplyStore } from '../stores/supplyStore';
import { db, DB_VERSION } from '../utils/db';
import {
  applyTracePackets,
  buildTracePackets,
  downloadTextFile,
  getLastMergeReport,
  PacketStaleError,
  PacketValidationError,
  parseTracePacket,
  readDirtySince,
} from '../utils/tracePacket';
import type { MergeReport, TracePacket } from '../types/trace';
import type { PrepProcedure } from '../types/procedure';
import { PHOTO_STAGE_LABEL } from '../types/photo';

function fmt(ts?: number): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('zh-CN');
}

/** /sync 离线留痕：导出留痕包、导入三方合并、两版待核裁决、重算结果回显 */
export default function SyncCenter() {
  const navigate = useNavigate();
  const specimens = useSpecimenStore((s) => s.items);
  const procedures = useProcedureStore((s) => s.items);
  const supplies = useSupplyStore((s) => s.items);
  const loadSpecimens = useSpecimenStore((s) => s.load);
  const loadProcedures = useProcedureStore((s) => s.load);
  const loadSupplies = useSupplyStore((s) => s.load);
  const hydrateSpecimens = useSpecimenStore((s) => s.hydrate);
  const hydrateProcedures = useProcedureStore((s) => s.hydrate);
  const hydrateSupplies = useSupplyStore((s) => s.hydrate);
  const resolveConflict = useProcedureStore((s) => s.resolveConflict);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const [toast, setToast] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<MergeReport | null>(() => getLastMergeReport());
  const [dirtySince, setDirtySince] = useState(0);

  useEffect(() => {
    setDirtySince(readDirtySince());
  }, []);

  const specimenById = useMemo(
    () => new Map(specimens.map((s) => [s.id, s])),
    [specimens],
  );

  const conflictedProcedures = useMemo(
    () => procedures.filter((p) => (p.conflicts ?? []).some((c) => c.status === 'pending')),
    [procedures],
  );

  const refreshAll = useCallback(async () => {
    const [sp, pr, su] = await Promise.all([
      db.specimens.toArray(),
      db.procedures.toArray(),
      db.supplies.toArray(),
    ]);
    hydrateSpecimens(sp);
    hydrateProcedures(pr);
    hydrateSupplies(su);
    setDirtySince(readDirtySince());
  }, [hydrateSpecimens, hydrateProcedures, hydrateSupplies]);

  const handleExport = useCallback(async () => {
    setError('');
    try {
      const photos = await db.photos.toArray();
      const bundle = buildTracePackets(
        { specimens, procedures, supplies, photos },
        { source: '本馆回馆机', schemaVersion: DB_VERSION },
      );
      bundle.files.forEach((f) => downloadTextFile(f.name, f.content));
      setToast(`已导出留痕包 ${bundle.manifest.partCount} 个分片（批次 ${bundle.manifest.batchId}）`);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [specimens, procedures, supplies]);

  const handleFiles = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      setError('');
      setBusy(true);
      try {
        const packets: TracePacket[] = [];
        for (const file of Array.from(files)) {
          const text = await file.text();
          packets.push(parseTracePacket(text));
        }
        const { report: result, alreadyImported } = await applyTracePackets(packets);
        await refreshAll();
        setReport(result);
        setToast(
          alreadyImported
            ? `批次 ${result.batchId} 此前已导入，已按当前档案完成幂等对账。`
            : `留痕包合并完成：新增工序 ${result.counts.procedures.added}，并入 ${result.counts.procedures.updated}，待核 ${result.counts.procedures.conflict}。`,
        );
      } catch (e) {
        if (e instanceof PacketStaleError || e instanceof PacketValidationError) {
          setError(e.message);
        } else {
          // 事务已整体回滚，库里仍是导入前状态，可修正后重导
          setError(`合并失败，已整体回滚、未写入任何数据，可重新导入：${(e as Error).message}`);
        }
      } finally {
        setBusy(false);
        if (fileRef.current) fileRef.current.value = '';
      }
    },
    [refreshAll],
  );

  const handleResolve = useCallback(
    async (procId: string, side: 'local' | 'remote') => {
      await resolveConflict(procId, side);
      await loadProcedures();
      setToast(side === 'local' ? '已核定采用本机版' : '已核定采用留痕包版');
    },
    [loadProcedures, resolveConflict],
  );

  const progressRows = useMemo(() => {
    if (!report) return [];
    return report.affectedSpecimenIds
      .map((sid) => ({ sid, specimen: specimenById.get(sid), prog: report.progressBySpecimen[sid] }))
      .filter((r) => !!r.prog)
      .map((r) => ({ sid: r.sid, specimen: r.specimen, ...r.prog }));
  }, [report, specimenById]);

  const balanceRows = useMemo(() => {
    if (!report) return [];
    return report.affectedSupplyIds
      .map((id) => ({ lot: supplies.find((s) => s.id === id), balance: report.supplyBalance[id] }))
      .filter((r) => r.lot && r.balance);
  }, [report, supplies]);

  return (
    <Stack spacing={2}>
      <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap">
        <Typography variant="h5" fontWeight={700}>
          离线留痕合并
        </Typography>
        <Chip size="small" variant="outlined" label={`结构 v${DB_VERSION}`} />
        {dirtySince > 0 ? (
          <Chip size="small" color="warning" variant="outlined" label={`本机工序最近改动 ${fmt(dirtySince)}，此前导出的旧包失效`} />
        ) : (
          <Chip size="small" color="success" variant="outlined" label="本机工序尚未产生改动" />
        )}
      </Stack>

      <Alert severity="info">
        合作修复室送回的留痕包在此三方合并：只有一边新改的记录直接并入；同一工序两边都动过则保留两版待核；
        影像按拍摄时间与阶段归挂到工序修订，同标本、同拍摄时间、同内容的重复影像只留一条。
        合并后完成度、材料余量、对照说明自动重算；整包在单个事务内写入，失败自动回滚，可重新导入。
      </Alert>

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 2 }}>
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography variant="subtitle1" fontWeight={700} gutterBottom>
            导出留痕包（发给合作修复室）
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            当前档案：标本 {specimens.length} 件 · 工序 {procedures.length} 条 · 材料批次 {supplies.length} 个。
            包体超容量时自动分批写入为多个 JSON 分片，回导时需同批分片选齐。
          </Typography>
          <Button variant="outlined" startIcon={<DownloadIcon />} onClick={() => void handleExport()}>
            导出全量留痕包
          </Button>
        </Paper>

        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography variant="subtitle1" fontWeight={700} gutterBottom>
            导入留痕包（修复室送回）
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            可一次选择同批的 1～N 个分片；旧数据无修订号时按当前值回填。本机工序改动后、导出早于改动点的旧包将被拒绝。
          </Typography>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            multiple
            hidden
            onChange={(e) => void handleFiles(e.target.files)}
          />
          <Button
            variant="contained"
            startIcon={<UploadFileIcon />}
            disabled={busy}
            onClick={() => fileRef.current?.click()}
          >
            {busy ? '合并写入中…' : '选择留痕包并合并'}
          </Button>
        </Paper>
      </Box>

      {error ? <Alert severity="error" data-testid="sync-error">{error}</Alert> : null}

      {/* 两版待核 */}
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1.5 }}>
          <GavelIcon color="warning" />
          <Typography variant="subtitle1" fontWeight={700}>
            两版待核工序
          </Typography>
          <Chip size="small" color={conflictedProcedures.length > 0 ? 'warning' : 'default'} label={`${conflictedProcedures.length} 条待核`} />
        </Stack>
        {conflictedProcedures.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            没有待核分叉。
          </Typography>
        ) : (
          <Stack spacing={2}>
            {conflictedProcedures.map((proc) => (
              <ConflictCard
                key={proc.id}
                proc={proc}
                specimenNo={specimenById.get(proc.specimenId)?.specimenNo ?? proc.specimenId}
                onResolve={(side) => void handleResolve(proc.id, side)}
              />
            ))}
          </Stack>
        )}
      </Paper>

      {/* 最近一次合并报告 */}
      {report ? (
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography variant="subtitle1" fontWeight={700} gutterBottom>
            最近合并报告
          </Typography>
          <Typography variant="body2" color="text.secondary">
            来源：{report.source || '未注明'} · 批次 {report.batchId} · 合并时间 {fmt(report.importedAt)}
          </Typography>

          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 2, mt: 2 }}>
            <Box>
              <Typography variant="subtitle2" gutterBottom>合并计数</Typography>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>表</TableCell>
                    <TableCell align="right">新增</TableCell>
                    <TableCell align="right">并入</TableCell>
                    <TableCell align="right">未变</TableCell>
                    <TableCell align="right">待核/去重</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  <TableRow>
                    <TableCell>标本</TableCell>
                    <TableCell align="right">{report.counts.specimens.added}</TableCell>
                    <TableCell align="right">{report.counts.specimens.updated}</TableCell>
                    <TableCell align="right">{report.counts.specimens.unchanged}</TableCell>
                    <TableCell align="right">{report.counts.specimens.conflict}</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell>工序</TableCell>
                    <TableCell align="right">{report.counts.procedures.added}</TableCell>
                    <TableCell align="right">{report.counts.procedures.updated}</TableCell>
                    <TableCell align="right">{report.counts.procedures.unchanged}</TableCell>
                    <TableCell align="right">{report.counts.procedures.conflict}</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell>材料批次</TableCell>
                    <TableCell align="right">{report.counts.supplies.added}</TableCell>
                    <TableCell align="right">{report.counts.supplies.updated}</TableCell>
                    <TableCell align="right">{report.counts.supplies.unchanged}</TableCell>
                    <TableCell align="right">{report.counts.supplies.conflict}</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell>影像</TableCell>
                    <TableCell align="right">{report.counts.photos.added}</TableCell>
                    <TableCell align="right" colSpan={2}>归挂 {report.counts.photos.relinked}</TableCell>
                    <TableCell align="right">去重 {report.counts.photos.deduped}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </Box>

            <Box>
              <Typography variant="subtitle2" gutterBottom>合并后重算 · 完成度</Typography>
              {progressRows.length === 0 ? (
                <Typography variant="body2" color="text.secondary">本次合并未影响标本工序。</Typography>
              ) : (
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>标本</TableCell>
                      <TableCell align="right">完成/总数</TableCell>
                      <TableCell align="right">完成度</TableCell>
                      <TableCell align="right">操作</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {progressRows.map((r) => (
                      <TableRow key={r.sid}>
                        <TableCell>{r.specimen?.specimenNo ?? r.sid}</TableCell>
                        <TableCell align="right">{r.done}/{r.total}</TableCell>
                        <TableCell align="right">{r.percent}%</TableCell>
                        <TableCell align="right">
                          <Button size="small" onClick={() => navigate(`/specimens/${r.sid}`)}>详情</Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}

              <Typography variant="subtitle2" sx={{ mt: 2 }} gutterBottom>合并后重算 · 材料余量</Typography>
              {balanceRows.length === 0 ? (
                <Typography variant="body2" color="text.secondary">本次合并未影响材料批次。</Typography>
              ) : (
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>批次</TableCell>
                      <TableCell align="right">在库余量</TableCell>
                      <TableCell align="right">累计领用</TableCell>
                      <TableCell align="right">状态</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {balanceRows.map((r) => (
                      <TableRow key={r.lot!.id}>
                        <TableCell>{r.lot!.name} · {r.lot!.lotNo}</TableCell>
                        <TableCell align="right">{r.balance.qty} {r.lot!.unit}</TableCell>
                        <TableCell align="right">{r.balance.issuedTotal} {r.lot!.unit}</TableCell>
                        <TableCell align="right">
                          {r.balance.low ? <Chip size="small" color="error" label="低量" /> : <Chip size="small" variant="outlined" label="正常" />}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </Box>
          </Box>

          <Divider sx={{ my: 2 }} />
          <Typography variant="subtitle2" gutterBottom>对照说明（随合并重算）</Typography>
          {report.compareNotes.length === 0 ? (
            <Typography variant="body2" color="text.secondary">无。</Typography>
          ) : (
            <Stack spacing={1}>
              {report.compareNotes.map((note, i) => (
                <Paper key={i} variant="outlined" sx={{ p: 1, bgcolor: 'grey.50' }}>
                  <Typography variant="caption" component="pre" sx={{ whiteSpace: 'pre-wrap', m: 0, fontFamily: 'inherit' }}>
                    {note}
                  </Typography>
                </Paper>
              ))}
            </Stack>
          )}

          {report.warnings.length > 0 ? (
            <>
              <Typography variant="subtitle2" sx={{ mt: 2 }} gutterBottom>告警</Typography>
              <Stack spacing={0.5}>
                {report.warnings.map((w, i) => (
                  <Alert key={i} severity="warning">{w}</Alert>
                ))}
              </Stack>
            </>
          ) : null}
        </Paper>
      ) : null}

      <Snackbar open={!!toast} autoHideDuration={3000} onClose={() => setToast('')} message={toast} />
    </Stack>
  );
}

function ConflictCard({
  proc,
  specimenNo,
  onResolve,
}: {
  proc: PrepProcedure;
  specimenNo: string;
  onResolve: (side: 'local' | 'remote') => void;
}) {
  const pending = (proc.conflicts ?? []).filter((c) => c.status === 'pending');
  const local = pending.find((c) => c.side === 'local')?.snapshot;
  const remote = pending.find((c) => c.side === 'remote')?.snapshot;

  return (
    <Paper variant="outlined" sx={{ p: 1.5 }} data-testid="conflict-card">
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
        <Chip size="small" label={`#${proc.seq}`} />
        <Typography variant="subtitle2" fontWeight={700}>
          {proc.stepType} · {proc.nodeName}
        </Typography>
        <Typography variant="caption" color="text.secondary">{specimenNo}</Typography>
      </Stack>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 1.5, mt: 1 }}>
        {[
          { label: '本机版', data: local, side: 'local' as const, tone: 'primary.main' },
          { label: '留痕包版', data: remote, side: 'remote' as const, tone: 'warning.main' },
        ].map(({ label, data, side, tone }) => (
          <Paper key={side} variant="outlined" sx={{ p: 1.25 }}>
            <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.5 }}>
              <Typography variant="body2" fontWeight={700} sx={{ color: tone }}>{label}</Typography>
              <Chip size="small" variant="outlined" label={`rev ${data?.rev ?? '?'}`} />
              <Chip size="small" variant="outlined" label={`影像 ${PHOTO_STAGE_LABEL.before} ${data?.photoBeforeIds.length ?? 0} / ${PHOTO_STAGE_LABEL.after} ${data?.photoAfterIds.length ?? 0}`} />
            </Stack>
            {data ? (
              <Typography variant="caption" component="div" sx={{ whiteSpace: 'pre-wrap' }}>
                {[
                  `状态：${data.state === 'done' ? '已完成' : data.state === 'rolledback' ? '已回退' : '待办'}`,
                  `责任人：${data.operator}`,
                  `工具：${data.tools.join('、') || '—'}`,
                  `磨料：${data.abrasive || '—'}`,
                  `胶种：${data.adhesive || '—'}${data.adhesiveConc ? `（${data.adhesiveConc}%）` : ''}`,
                  `耗时：${data.durationMin} min`,
                  `环境：${data.tempC}℃ / RH ${data.rh}%`,
                  `开始：${fmt(data.startedAt)}`,
                ].join('\n')}
              </Typography>
            ) : (
              <Typography variant="caption" color="text.secondary">该版内容缺失</Typography>
            )}
            <Button size="small" variant={side === 'local' ? 'outlined' : 'contained'} sx={{ mt: 1 }} onClick={() => onResolve(side)}>
              核定采用{label}
            </Button>
          </Paper>
        ))}
      </Box>
    </Paper>
  );
}
