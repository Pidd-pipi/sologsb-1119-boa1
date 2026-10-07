import { useState } from 'react';
import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import Slider from '@mui/material/Slider';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Chip from '@mui/material/Chip';
import ZoomInIcon from '@mui/icons-material/ZoomIn';
import ZoomOutIcon from '@mui/icons-material/ZoomOut';
import RestartAltIcon from '@mui/icons-material/RestartAlt';

export interface BeforeAfterSliderProps {
  beforeUrl: string;
  afterUrl: string;
  beforeCaption?: string;
  afterCaption?: string;
  /** 标注泡点（相对百分比 0-100） */
  markers?: { id: string; x: number; y: number; text: string }[];
}

/**
 * 前后影像滑块对照，支持缩放与标注泡点，被对照页消费。
 */
export function BeforeAfterSlider({
  beforeUrl,
  afterUrl,
  beforeCaption = '修复前',
  afterCaption = '修复后',
  markers = [],
}: BeforeAfterSliderProps) {
  const [pos, setPos] = useState(50);
  const [zoom, setZoom] = useState(1);
  const [showMarkers, setShowMarkers] = useState(true);

  return (
    <Stack spacing={1.5}>
      <Stack direction="row" spacing={1} alignItems="center">
        <Chip size="small" color="warning" label={beforeCaption} />
        <Typography variant="body2" color="text.secondary">
          拖动滑块对照修复前后
        </Typography>
        <Box sx={{ flex: 1 }} />
        <Tooltip title="切换标注泡点">
          <Chip
            size="small"
            label={`标注 ${markers.length}`}
            variant={showMarkers ? 'filled' : 'outlined'}
            onClick={() => setShowMarkers((v) => !v)}
          />
        </Tooltip>
        <IconButton size="small" onClick={() => setZoom((z) => Math.max(1, Math.round((z - 0.2) * 10) / 10))}>
          <ZoomOutIcon fontSize="small" />
        </IconButton>
        <Typography variant="caption" sx={{ width: 42, textAlign: 'center' }}>
          {Math.round(zoom * 100)}%
        </Typography>
        <IconButton size="small" onClick={() => setZoom((z) => Math.min(3, Math.round((z + 0.2) * 10) / 10))}>
          <ZoomInIcon fontSize="small" />
        </IconButton>
        <IconButton
          size="small"
          onClick={() => {
            setZoom(1);
            setPos(50);
          }}
        >
          <RestartAltIcon fontSize="small" />
        </IconButton>
      </Stack>

      <Paper variant="outlined" sx={{ position: 'relative', overflow: 'hidden', bgcolor: '#1d1a16' }}>
        <Box
          sx={{
            position: 'relative',
            transform: `scale(${zoom})`,
            transformOrigin: 'center center',
            transition: 'transform 0.15s',
            aspectRatio: '3 / 2',
          }}
        >
          <Box
            component="img"
            src={afterUrl}
            alt={afterCaption}
            data-testid="slider-after"
            sx={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
          />
          <Box
            component="img"
            src={beforeUrl}
            alt={beforeCaption}
            data-testid="slider-before"
            sx={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              clipPath: `inset(0 ${100 - pos}% 0 0)`,
            }}
          />
          <Box
            sx={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              left: `${pos}%`,
              width: '2px',
              bgcolor: '#ffb300',
              boxShadow: '0 0 6px rgba(0,0,0,0.6)',
              pointerEvents: 'none',
            }}
          />
          {showMarkers
            ? markers.map((m) => (
                <Box
                  key={m.id}
                  title={m.text}
                  sx={{
                    position: 'absolute',
                    left: `${m.x}%`,
                    top: `${m.y}%`,
                    transform: 'translate(-50%, -50%)',
                    width: 22,
                    height: 22,
                    borderRadius: '50%',
                    bgcolor: 'rgba(255,179,0,0.85)',
                    border: '2px solid #fff',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 11,
                    fontWeight: 700,
                    color: '#3a2a00',
                  }}
                >
                  {m.id.slice(-1)}
                </Box>
              ))
            : null}
        </Box>
      </Paper>

      <Slider
        value={pos}
        onChange={(_, v) => setPos(v as number)}
        min={0}
        max={100}
        valueLabelDisplay="auto"
        aria-label="前后对照滑块"
      />
      <Stack direction="row" justifyContent="space-between">
        <Typography variant="caption" color="text.secondary">
          {beforeCaption}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {afterCaption}
        </Typography>
      </Stack>
      {markers.length > 0 ? (
        <Stack spacing={0.5}>
          {markers.map((m) => (
            <Typography key={m.id} variant="caption" color="text.secondary">
              标注 {m.id}：{m.text}
            </Typography>
          ))}
        </Stack>
      ) : null}
    </Stack>
  );
}

export default BeforeAfterSlider;
