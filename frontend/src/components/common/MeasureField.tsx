import TextField from '@mui/material/TextField';
import InputAdornment from '@mui/material/InputAdornment';
import FormHelperText from '@mui/material/FormHelperText';
import Stack from '@mui/material/Stack';
import { inRange } from '../../utils/unitConvert';

export interface MeasureFieldProps {
  label: string;
  /** 单位文案，如 mm / g / ℃ / % */
  unit: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  /** 附加说明，例如换算结果 */
  hint?: string;
  step?: number;
  disabled?: boolean;
}

/**
 * 带单位与范围校验的数值输入，被工序表单、标本表单消费。
 */
export function MeasureField({
  label,
  unit,
  value,
  onChange,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
  hint,
  step = 0.1,
  disabled = false,
}: MeasureFieldProps) {
  const invalid = !inRange(value, min, max);
  return (
    <Stack spacing={0.5}>
      <TextField
        size="small"
        fullWidth
        disabled={disabled}
        label={label}
        type="number"
        value={Number.isFinite(value) ? value : ''}
        error={invalid}
        inputProps={{ min, max, step }}
        onChange={(e) => onChange(e.target.value === '' ? NaN : Number(e.target.value))}
        InputProps={{ endAdornment: <InputAdornment position="end">{unit}</InputAdornment> }}
      />
      <FormHelperText error={invalid} sx={{ m: 0 }}>
        {invalid ? `取值范围 ${min} ~ ${max} ${unit}` : (hint ?? `允许范围 ${min} ~ ${max} ${unit}`)}
      </FormHelperText>
    </Stack>
  );
}

export default MeasureField;
