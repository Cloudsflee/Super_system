export function qualityStatusLabel(value: string) {
  return (
    (
      {
        not_started: '未启动',
        queued: '排队中',
        preparing: '准备中',
        checking: '确定性检查',
        reviewing: '模型建议',
        awaiting_human: '等待人工裁决',
        completed: '已完成',
        failed: '失败',
        cancelled: '已取消'
      } as Record<string, string>
    )[value] || value
  );
}

export function qualityStatusTone(status: string, stale?: boolean) {
  if (stale) return 'stale';
  if (status === 'completed') return 'completed';
  if (status === 'failed' || status === 'cancelled') return 'failed';
  if (status === 'awaiting_human') return 'awaiting';
  if (status === 'not_started') return 'idle';
  return 'active';
}

export function qualityStepTone(current: string, phase: string) {
  const order = ['queued', 'preparing', 'checking', 'reviewing', 'awaiting_human', 'completed'];
  return order.indexOf(current) >= order.indexOf(phase) ? 'done' : current === phase ? 'current' : '';
}

export function formatBytes(value: number) {
  if (!Number.isFinite(value) || value < 1024) return `${Math.max(0, Math.round(value || 0))} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let amount = value / 1024;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index += 1;
  }
  return `${amount.toFixed(amount >= 10 ? 0 : 1)} ${units[index]}`;
}

export function formatQualityReviewTime(value: string) {
  return new Date(value).toLocaleString();
}
