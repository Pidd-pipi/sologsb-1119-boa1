import React from 'react';
import ReactDOM from 'react-dom/client';
import CssBaseline from '@mui/material/CssBaseline';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import AppRouter from './router';

const theme = createTheme({
  palette: {
    mode: 'light',
    primary: { main: '#5b4636' },
    secondary: { main: '#7a8b6f' },
    background: { default: '#faf7f2' },
  },
  shape: { borderRadius: 8 },
  typography: {
    fontFamily:
      '"Noto Sans SC", "PingFang SC", "Microsoft YaHei", system-ui, -apple-system, "Segoe UI", sans-serif',
  },
});

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <AppRouter />
    </ThemeProvider>
  </React.StrictMode>,
);
