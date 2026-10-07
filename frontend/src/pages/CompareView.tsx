import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Alert from '@mui/material/Alert';
import Snackbar from '@mui/material/Snackbar';
import DownloadIcon from '@mui/icons-material/Download';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { useSpecimenStore } from '../stores/specimenStore';
import { useProcedureStore } from '../stores/procedureStore';
import { useSpecimenSearch } from '../hooks/useSpecimenSearch';
import { usePrepProgress } from '../hooks/usePrepProgress';
import { BeforeAfterSlider } from '../components/common/BeforeAfterSlider';
import { db } from '../utils/db';
import { makeSketchDataUrl, PHOTO_STAGE_LABEL, type PrepPhoto } from '../types/photo';
import { hardnessLabel } from '../utils/unitConvert';

/** /compare/:specimenId 前后对照滑块联看 + 导出对照说明文本 */
export default function CompareView() {
  const { specimenId = '' } = useParams();
  const navigate = useNavigate();
  const specimens = useSpecimenStore((s) => s.items);
  const { result } = useSpecimenSearch();
  const procedures = useProcedureStore((s) => s.items);
  const progress = usePrepProgress(specimenId || undefined);

  const [photos, setPhotos] = useState<PrepPhoto[]>([]);
  const [beforeId, setBeforeId] = useState('');
  const [afterId, setAfterId] = useState('');
  const [toast, setToast] = useState('');

  const specimen = specimens.find((it) => it.id === specimenId);

  const loadPhotos = useCallback(async () => {
    if (!specimenId) return;
    const rows = await db.photos.where('specimenId').equals(specimenId).toArray();
    rows.sort((a, b) => a.capturedAt - b.capturedAt);
    setPhotos(rows);
    setBeforeId(rows.find((r) => r.stage === 'before')?.id ?? rows[0]?.id ?? '');
    setAfterId(rows.find((r) => r.stage === 'after')?.id ?? rows[rows.length - 1]?.id ?? '');
  }, [specimenId]);

  useEffect(() => {
    void loadPhotos();
  }, [loadPhotos]);

  const before = photos.find((p) => p.id === beforeId);
  const after = photos.find((p) => p.id === afterId);

  const markers = useMemo(
    () =>
      progress.list.slice(0, 4).map((node, index) => ({
        id: `M${index + 1}`,
        x: 18 + index * 20,
        y: 30 + (index % 2) * 26,
        text: `#${node.seq} ${node.stepType} · ${node.nodeName}`,
      })),
    [progress.list],
  );

  const statement = useMemo(() => {
    if (!specimen) return '';
    const lines: string[] = [];
    lines.push(`化石修复前后对照说明`);
    lines.push(`标本号：${specimen.specimenNo}`);
    lines.push(`分类鉴定：${specimen.taxon}`);
    lines.push(`层位/产地：${specimen.horizon} / ${specimen.locality}`);
    lines.push(`围岩：${specimen.lithology} · ${hardnessLabel(specimen.matrixHardness).label}`);
    lines.push(`尺寸/重量：${specimen.dimensions} mm / ${specimen.weight} g`);
    lines.push(`当前状态：${specimen.status}`);
    lines.push(`工序完成度：${progress.done}/${progress.total}（${progress.percent}%）`);
    const pendingConflicts = progress.list.filter((n) => (n.conflicts ?? []).some((c) => c.status === 'pending')).length;
    if (pendingConflicts > 0) {
      lines.push(`待核分叉：${pendingConflicts} 个工序存在两版待核，请到「离线合并」核定后再定稿`);
    }
    lines.push(
      `工序节点：${
        progress.list.length === 0
          ? '无'
          : progress.list.map((n) => `#${n.seq}${n.stepType}(${n.nodeName}·${n.state === 'done' ? '已完成' : n.state === 'rolledback' ? '已回退' : '待办'})`).join(' → ')
      }`,
    );
    lines.push(`修复前影像：${before ? `${PHOTO_STAGE_LABEL[before.stage]} · ${before.caption}` : '未选'}`);
    lines.push(`修复后影像：${after ? `${PHOTO_STAGE_LABEL[after.stage]} · ${after.caption}` : '未选'}`);
    lines.push(`对照标注：${markers.length === 0 ? '无' : markers.map((m) => `${m.id} ${m.text}`).join('；')}`);
    lines.push(`导出时间：${new Date().toLocaleString('zh-CN')}`);
    return lines.join('\n');
  }, [specimen, progress, before, after, markers]);

  const download = () => {
    const blob = new Blob([statement], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `对照说明_${specimen?.specimenNo ?? 'specimen'}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    setToast('对照说明已导出为 txt');
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(statement);
      setToast('对照说明已复制到剪贴板');
    } catch {
      setToast('浏览器未授权剪贴板，请手动复制下方文本');
    }
  };

  if (!specimen) {
    return (
      <Stack spacing={2}>
        <Alert severity="warning">未找到该标本，请在下方重新选择。</Alert>
        <TextField
          select
          size="small"
          label="选择标本"
          value=""
          onChange={(e) => navigate(`/compare/${e.target.value}`)}
          sx={{ maxWidth: 420 }}
        >
          {result.map((it) => (
            <MenuItem key={it.id} value={it.id}>
              {it.specimenNo} · {it.taxon}
            </MenuItem>
          ))}
        </TextField>
        <Button variant="outlined" onClick={() => navigate('/specimens')}>
          返回标本台账
        </Button>
      </Stack>
    );
  }

  return (
    <Stack spacing={2}>
      <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap">
        <Typography variant="h5" fontWeight={700}>
          修复前后对照 · {specimen.specimenNo}
        </Typography>
        <Chip size="small" label={`完成度 ${progress.percent}%`} />
        <Chip size="small" variant="outlined" label={`影像 ${photos.length} 张`} />
        <Box sx={{ flex: 1 }} />
        <TextField
          select
          size="small"
          label="切换标本"
          value={specimen.id}
          onChange={(e) => navigate(`/compare/${e.target.value}`)}
          sx={{ minWidth: 260 }}
        >
          {result.map((it) => (
            <MenuItem key={it.id} value={it.id}>
              {it.specimenNo} · {it.taxon}
            </MenuItem>
          ))}
        </TextField>
      </Stack>

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 380px' }, gap: 2 }}>
        <Paper variant="outlined" sx={{ p: 2 }}>
          <BeforeAfterSlider
            beforeUrl={before?.dataUrl ?? makeSketchDataUrl('修复前 · 暂无影像', '#5a4a38')}
            afterUrl={after?.dataUrl ?? makeSketchDataUrl('修复后 · 暂无影像', '#33473c')}
            beforeCaption={before ? `${PHOTO_STAGE_LABEL[before.stage]} · ${before.caption}` : '修复前（缺影像）'}
            afterCaption={after ? `${PHOTO_STAGE_LABEL[after.stage]} · ${after.caption}` : '修复后（缺影像）'}
            markers={markers}
          />
          <Stack direction="row" spacing={1.5} sx={{ mt: 2 }}>
            <TextField
              select
              size="small"
              fullWidth
              label="对照左图（修复前）"
              value={beforeId}
              onChange={(e) => setBeforeId(e.target.value)}
            >
              {photos.map((p) => (
                <MenuItem key={p.id} value={p.id}>
                  {PHOTO_STAGE_LABEL[p.stage]} · {p.caption}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              select
              size="small"
              fullWidth
              label="对照右图（修复后）"
              value={afterId}
              onChange={(e) => setAfterId(e.target.value)}
            >
              {photos.map((p) => (
                <MenuItem key={p.id} value={p.id}>
                  {PHOTO_STAGE_LABEL[p.stage]} · {p.caption}
                </MenuItem>
              ))}
            </TextField>
          </Stack>
          {photos.length === 0 ? (
            <Alert severity="info" sx={{ mt: 1.5 }}>
              该标本暂无影像条目，可到「新建工序节点」勾选挂接留痕影像。
            </Alert>
          ) : null}
        </Paper>

        <Stack spacing={2}>
          <Paper variant="outlined" sx={{ p: 2 }}>
            <Typography variant="subtitle1" fontWeight={700} gutterBottom>
              工序节点对照
            </Typography>
            {progress.list.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                暂无工序节点。
              </Typography>
            ) : (
              <Stack spacing={0.5}>
                {progress.list.map((n) => (
                  <Stack key={n.id} direction="row" spacing={1} alignItems="center">
                    <Typography variant="body2">
                      #{n.seq} {n.stepType} · {n.nodeName}
                    </Typography>
                    <Chip
                      size="small"
                      label={n.state === 'done' ? '已完成' : n.state === 'rolledback' ? '已回退' : '待办'}
                      color={n.state === 'done' ? 'success' : n.state === 'rolledback' ? 'error' : 'default'}
                    />
                  </Stack>
                ))}
              </Stack>
            )}
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
              另有 {procedures.filter((p) => p.specimenId !== specimen.id).length} 条工序属于其它标本。
            </Typography>
          </Paper>

          <Paper variant="outlined" sx={{ p: 2 }}>
            <Stack direction="row" spacing={1} sx={{ mb: 1 }}>
              <Typography variant="subtitle1" fontWeight={700} sx={{ flex: 1 }}>
                对照说明文本
              </Typography>
              <Button size="small" startIcon={<ContentCopyIcon />} onClick={copy}>
                复制
              </Button>
              <Button size="small" variant="contained" startIcon={<DownloadIcon />} onClick={download}>
                导出
              </Button>
            </Stack>
            <TextField
              multiline
              minRows={12}
              fullWidth
              value={statement}
              inputProps={{ readOnly: true, 'data-testid': 'compare-statement' }}
            />
          </Paper>
        </Stack>
      </Box>

      <Snackbar open={!!toast} autoHideDuration={2400} onClose={() => setToast('')} message={toast} />
    </Stack>
  );
}
