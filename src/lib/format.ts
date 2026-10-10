export function money(n: number, currency = 'RM'): string {
  const v = Math.abs(n).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n < -0.004 ? '−' : ''}${currency}${v}`;
}

export function moneyShort(n: number, currency = 'RM'): string {
  const sign = n < 0 ? '−' : '';
  if (Math.abs(n) >= 1000) return `${sign}${currency}${(Math.abs(n) / 1000).toFixed(1)}k`;
  return `${sign}${currency}${Math.abs(n).toFixed(0)}`;
}

export function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-MY', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-MY', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function relDay(iso: string): string {
  const diff = Math.round((new Date(iso).getTime() - Date.now()) / 86400000);
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  if (diff === -1) return 'yesterday';
  return diff > 0 ? `in ${diff}d` : `${-diff}d ago`;
}

export function pct(n: number, digits = 0): string {
  return `${n.toFixed(digits)}%`;
}
