import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import MenuItem from '@mui/material/MenuItem';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Alert from '@mui/material/Alert';
import Snackbar from '@mui/material/Snackbar';
import Chip from '@mui/material/Chip';
import AddIcon from '@mui/icons-material/Add';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import { useSpecimenStore } from '../stores/specimenStore';
import { useProcedureStore } from '../stores/procedureStore';
import { useSpecimenSearch } from '../hooks/useSpecimenSearch';
import { SpecimenCard } from '../components/common/SpecimenCard';
import { MeasureField } from '../components/common/MeasureField';
import { SPECIMEN_STATUSES, type SpecimenDraft, type SpecimenStatus } from '../types/specimen';
import { hardnessLabel, mmToInch } from '../utils/unitConvert';

const EMPTY_DRAFT: SpecimenDraft = {
  specimenNo: '',
  taxon: '',
  horizon: '',
  locality: '',
  lithology: '',
  matrixHardness: 3,
  dimensions: '200×150×80',
  weight: 1500,
  storageBox: 'A 区 1 匣',
  status: '待清修',
};

/** /specimens 标本台账：按号/分类/产地筛选、状态分栏 */
export default function SpecimenList() {
  const navigate = useNavigate();
  const items = useSpecimenStore((s) => s.items);
  const addSpecimen = useSpecimenStore((s) => s.add);
  const procedures = useProcedureStore((s) => s.items);
  const { filters, patchFilters, reset, result, options } = useSpecimenSearch();

  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<SpecimenDraft>(EMPTY_DRAFT);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');

  const columns = useMemo(() => {
    return SPECIMEN_STATUSES.map((status) => ({
      status,
      rows: result.filter((it) => it.status === status),
    }));
  }, [result]);

  const progressOf = (specimenId: string) => {
    const list = procedures.filter((p) => p.specimenId === specimenId);
    const done = list.filter((p) => p.state === 'done').length;
    return { total: list.length, done };
  };

  const submit = async () => {
    if (!draft.specimenNo.trim()) {
      setError('标本号必填');
      return;
    }
    if (items.some((it) => it.specimenNo === draft.specimenNo.trim())) {
      setError('标本号已存在，请更换');
      return;
    }
    const created = await addSpecimen({ ...draft, specimenNo: draft.specimenNo.trim() });
    setError('');
    setOpen(false);
    setDraft(EMPTY_DRAFT);
    setToast(`已登记标本「${created.specimenNo}」`);
  };

  return (
    <Stack spacing={2}>
      <Stack direction="row" alignItems="center" spacing={1}>
        <Typography variant="h5" fontWeight={700}>
          标本台账
        </Typography>
        <Chip size="small" label={`共 ${items.length} 件`} />
        <Chip size="small" variant="outlined" label={`当前筛选命中 ${result.length} 件`} />
        <Box sx={{ flex: 1 }} />
        <Button variant="contained" startIcon={<AddIcon />} onClick={() => setOpen(true)}>
          登记标本
        </Button>
      </Stack>

      <Paper variant="outlined" sx={{ p: 1.5 }}>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} flexWrap="wrap" useFlexGap>
          <TextField
            size="small"
            label="标本号 / 分类 / 层位"
            value={filters.keyword}
            onChange={(e) => patchFilters({ keyword: e.target.value })}
            sx={{ minWidth: 220 }}
          />
          <TextField
            select
            size="small"
            label="分类鉴定"
            value={filters.taxon}
            onChange={(e) => patchFilters({ taxon: e.target.value })}
            sx={{ minWidth: 180 }}
          >
            <MenuItem value="all">全部</MenuItem>
            {options.taxa.map((t) => (
              <MenuItem key={t} value={t}>
                {t}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            select
            size="small"
            label="产地"
            value={filters.locality}
            onChange={(e) => patchFilters({ locality: e.target.value })}
            sx={{ minWidth: 140 }}
          >
            <MenuItem value="all">全部</MenuItem>
            {options.localities.map((t) => (
              <MenuItem key={t} value={t}>
                {t}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            select
            size="small"
            label="状态"
            value={filters.status}
            onChange={(e) => patchFilters({ status: e.target.value as SpecimenStatus | 'all' })}
            sx={{ minWidth: 140 }}
          >
            <MenuItem value="all">全部</MenuItem>
            {SPECIMEN_STATUSES.map((s) => (
              <MenuItem key={s} value={s}>
                {s}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            select
            size="small"
            label="排序"
            value={filters.sortBy}
            onChange={(e) => patchFilters({ sortBy: e.target.value as typeof filters.sortBy })}
            sx={{ minWidth: 140 }}
          >
            <MenuItem value="createdAt">按登记时间</MenuItem>
            <MenuItem value="specimenNo">按标本号</MenuItem>
            <MenuItem value="weight">按重量</MenuItem>
          </TextField>
          <Button startIcon={<RestartAltIcon />} onClick={reset}>
            重置
          </Button>
        </Stack>
      </Paper>

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(5, minmax(0, 1fr))' }, gap: 1.5 }}>
        {columns.map((col) => (
          <Stack key={col.status} spacing={1} sx={{ minWidth: 0 }}>
            <Stack direction="row" alignItems="center" spacing={0.5}>
              <Typography variant="subtitle2" fontWeight={700}>
                {col.status}
              </Typography>
              <Chip size="small" label={col.rows.length} />
            </Stack>
            {col.rows.map((item) => {
              const p = progressOf(item.id);
              return (
                <SpecimenCard
                  key={item.id}
                  item={item}
                  onOpen={(id) => navigate(`/specimens/${id}`)}
                  footer={
                    <Typography variant="caption" color="text.secondary">
                      工序 {p.done}/{p.total} · {hardnessLabel(item.matrixHardness).label}
                    </Typography>
                  }
                />
              );
            })}
            {col.rows.length === 0 ? (
              <Paper variant="outlined" sx={{ p: 1.5 }}>
                <Typography variant="caption" color="text.secondary">
                  暂无
                </Typography>
              </Paper>
            ) : null}
          </Stack>
        ))}
      </Box>

      <Dialog open={open} onClose={() => setOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>登记标本</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={1.5} sx={{ mt: 0.5 }}>
            {error ? <Alert severity="error">{error}</Alert> : null}
            <TextField
              size="small"
              label="标本号"
              required
              value={draft.specimenNo}
              onChange={(e) => setDraft({ ...draft, specimenNo: e.target.value })}
            />
            <TextField
              size="small"
              label="分类鉴定"
              value={draft.taxon}
              onChange={(e) => setDraft({ ...draft, taxon: e.target.value })}
            />
            <Stack direction="row" spacing={1.5}>
              <TextField
                size="small"
                fullWidth
                label="层位"
                value={draft.horizon}
                onChange={(e) => setDraft({ ...draft, horizon: e.target.value })}
              />
              <TextField
                size="small"
                fullWidth
                label="产地"
                value={draft.locality}
                onChange={(e) => setDraft({ ...draft, locality: e.target.value })}
              />
            </Stack>
            <Stack direction="row" spacing={1.5}>
              <TextField
                size="small"
                fullWidth
                label="围岩岩性"
                value={draft.lithology}
                onChange={(e) => setDraft({ ...draft, lithology: e.target.value })}
              />
              <TextField
                size="small"
                fullWidth
                label="匣位"
                value={draft.storageBox}
                onChange={(e) => setDraft({ ...draft, storageBox: e.target.value })}
              />
            </Stack>
            <Stack direction="row" spacing={1.5}>
              <Box sx={{ flex: 1 }}>
                <MeasureField
                  label="围岩莫氏硬度"
                  unit="Mohs"
                  min={0.5}
                  max={10}
                  step={0.1}
                  value={draft.matrixHardness}
                  onChange={(v) => setDraft({ ...draft, matrixHardness: v })}
                  hint={hardnessLabel(draft.matrixHardness).label}
                />
              </Box>
              <Box sx={{ flex: 1 }}>
                <MeasureField
                  label="重量"
                  unit="g"
                  min={1}
                  max={200000}
                  step={1}
                  value={draft.weight}
                  onChange={(v) => setDraft({ ...draft, weight: v })}
                />
              </Box>
            </Stack>
            <TextField
              size="small"
              label="尺寸（mm，长×宽×高）"
              value={draft.dimensions}
              onChange={(e) => setDraft({ ...draft, dimensions: e.target.value })}
              helperText={`换算约 ${mmToInch(Number(draft.dimensions.split('×')[0]) || 0)} inch（首边）`}
            />
            <TextField
              select
              size="small"
              label="状态"
              value={draft.status}
              onChange={(e) => setDraft({ ...draft, status: e.target.value as SpecimenStatus })}
            >
              {SPECIMEN_STATUSES.map((s) => (
                <MenuItem key={s} value={s}>
                  {s}
                </MenuItem>
              ))}
            </TextField>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)}>取消</Button>
          <Button variant="contained" onClick={submit}>
            保存登记
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar open={!!toast} autoHideDuration={2600} onClose={() => setToast('')} message={toast} />
    </Stack>
  );
}
