import { useEffect, useMemo, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import AppBar from '@mui/material/AppBar';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import Container from '@mui/material/Container';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import CircularProgress from '@mui/material/CircularProgress';
import Chip from '@mui/material/Chip';
import { useSpecimenStore } from '../stores/specimenStore';
import { useProcedureStore } from '../stores/procedureStore';
import { useSupplyStore } from '../stores/supplyStore';
import { ensureSeedData, markDbVersion, readDbVersion } from '../utils/db';
import SpecimenList from '../pages/SpecimenList';
import SpecimenDetail from '../pages/SpecimenDetail';
import ProcedureForm from '../pages/ProcedureForm';
import SupplyList from '../pages/SupplyList';
import CompareView from '../pages/CompareView';
import SyncCenter from '../pages/SyncCenter';

function Shell() {
  const location = useLocation();
  const navigate = useNavigate();
  const specimens = useSpecimenStore((s) => s.items);
  const version = readDbVersion();

  const navItems = useMemo(() => {
    const firstId = specimens[0]?.id;
    return [
      { label: '标本台账', path: '/specimens' },
      { label: '工序录入', path: '/procedures/new' },
      { label: '材料台账', path: '/supplies' },
      { label: '前后对照', path: firstId ? `/compare/${firstId}` : '/specimens' },
      { label: '离线合并', path: '/sync' },
    ];
  }, [specimens]);

  const active = navItems.findIndex((item) => location.pathname.startsWith(item.path.split('/').slice(0, 2).join('/')));

  return (
    <Box sx={{ minHeight: '100vh', bgcolor: 'grey.50' }}>
      <AppBar position="static" color="default" elevation={1}>
        <Toolbar variant="dense">
          <Typography variant="h6" sx={{ fontWeight: 700, mr: 2 }}>
            化石修复工序档案
          </Typography>
          <Tabs
            value={active === -1 ? 0 : active}
            onChange={(_, idx) => navigate(navItems[idx].path)}
            textColor="primary"
            indicatorColor="primary"
          >
            {navItems.map((item) => (
              <Tab key={item.label} label={item.label} />
            ))}
          </Tabs>
          <Box sx={{ flex: 1 }} />
          <Chip size="small" variant="outlined" label={`本地结构版本 v${version}`} />
        </Toolbar>
      </AppBar>
      <Container maxWidth="xl" sx={{ py: 3 }}>
        <Routes>
          <Route path="/" element={<Navigate to="/specimens" replace />} />
          <Route path="/specimens" element={<SpecimenList />} />
          <Route path="/specimens/:id" element={<SpecimenDetail />} />
          <Route path="/procedures/new" element={<ProcedureForm />} />
          <Route path="/supplies" element={<SupplyList />} />
          <Route path="/compare/:specimenId" element={<CompareView />} />
          <Route path="/sync" element={<SyncCenter />} />
          <Route path="*" element={<Navigate to="/specimens" replace />} />
        </Routes>
      </Container>
    </Box>
  );
}

/** 应用路由 + 本地数据引导（IndexedDB 迁移 + 示范数据） */
export default function AppRouter() {
  const [ready, setReady] = useState(false);
  const loadSpecimens = useSpecimenStore((s) => s.load);
  const loadProcedures = useProcedureStore((s) => s.load);
  const loadSupplies = useSupplyStore((s) => s.load);

  useEffect(() => {
    let alive = true;
    (async () => {
      await ensureSeedData();
      await markDbVersion();
      await Promise.all([loadSpecimens(), loadProcedures(), loadSupplies()]);
      if (alive) setReady(true);
    })();
    return () => {
      alive = false;
    };
  }, [loadSpecimens, loadProcedures, loadSupplies]);

  if (!ready) {
    return (
      <Stack alignItems="center" justifyContent="center" sx={{ minHeight: '100vh' }} spacing={2}>
        <CircularProgress />
        <Typography variant="body2" color="text.secondary">
          正在打开本地档案库（IndexedDB）…
        </Typography>
      </Stack>
    );
  }

  return (
    <BrowserRouter>
      <Shell />
    </BrowserRouter>
  );
}
