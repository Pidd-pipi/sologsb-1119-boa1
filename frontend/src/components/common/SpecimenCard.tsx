import Card from '@mui/material/Card';
import CardActionArea from '@mui/material/CardActionArea';
import CardContent from '@mui/material/CardContent';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import Box from '@mui/material/Box';
import type { ReactNode } from 'react';
import type { Specimen } from '../../types/specimen';
import { hardnessLabel, mmToInch } from '../../utils/unitConvert';

export interface SpecimenCardProps {
  item: Specimen;
  onOpen?: (id: string) => void;
  /** 底部附加信息，例如工序进度 */
  footer?: ReactNode;
  selected?: boolean;
}

const STATUS_TONE: Record<string, 'default' | 'info' | 'warning' | 'success'> = {
  待清修: 'default',
  修复中: 'info',
  已加固: 'warning',
  待交付: 'warning',
  已交付: 'success',
};

/**
 * 标本摘要卡（号、分类、层位、匣位），被标本台账、详情页消费。
 */
export function SpecimenCard({ item, onOpen, footer, selected = false }: SpecimenCardProps) {
  const hardness = hardnessLabel(item.matrixHardness);
  const body = (
    <CardContent>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.5 }}>
        <Typography variant="subtitle1" fontWeight={700}>
          {item.specimenNo}
        </Typography>
        <Chip size="small" label={item.status} color={STATUS_TONE[item.status] ?? 'default'} />
        <Chip size="small" variant="outlined" label={hardness.label} />
      </Stack>
      <Typography variant="body2" color="text.secondary" noWrap title={item.taxon}>
        分类：{item.taxon}
      </Typography>
      <Typography variant="body2" color="text.secondary">
        层位：{item.horizon} · 产地：{item.locality}
      </Typography>
      <Typography variant="body2" color="text.secondary">
        匣位：{item.storageBox} · 尺寸 {item.dimensions} mm（{mmToInch(Number(item.dimensions.split('×')[0]) || 0)} in） · {item.weight} g
      </Typography>
      <Typography variant="body2" color="text.secondary">
        岩性：{item.lithology}
      </Typography>
      {footer ? <Box sx={{ mt: 1 }}>{footer}</Box> : null}
    </CardContent>
  );

  if (!onOpen) {
    return (
      <Card variant="outlined" sx={{ borderColor: selected ? 'primary.main' : undefined, height: '100%' }}>
        {body}
      </Card>
    );
  }
  return (
    <Card variant="outlined" sx={{ borderColor: selected ? 'primary.main' : undefined, height: '100%' }}>
      <CardActionArea onClick={() => onOpen(item.id)} sx={{ height: '100%' }}>
        {body}
      </CardActionArea>
    </Card>
  );
}

export default SpecimenCard;
