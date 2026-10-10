import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import type { SalesSource } from '@/lib/db/types';

/** Shared building blocks for the BizPilot operational screens. */

export const NONE = '__none__';

export const primaryBtn = 'bg-teal-700 hover:bg-teal-800 text-white';
export const dialogWide = 'max-h-[90vh] overflow-y-auto sm:max-w-2xl';
export const dialogXL = 'max-h-[90vh] overflow-y-auto sm:max-w-4xl';

export function Field({
  label,
  hint,
  error,
  className,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn('grid min-w-0 gap-1.5', className)}>
      <Label className="text-xs text-slate-600">{label}</Label>
      {children}
      {error ? (
        <span className="text-[11px] text-red-600">{error}</span>
      ) : hint ? (
        <span className="text-[11px] text-slate-400">{hint}</span>
      ) : null}
    </div>
  );
}

export interface Option {
  value: string;
  label: string;
}

/** Wrapper over the shadcn Select. Use NONE for an empty choice (Radix forbids ''). */
export function SimpleSelect({
  value,
  onChange,
  options,
  placeholder,
  className,
  size,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Option[];
  placeholder?: string;
  className?: string;
  size?: 'sm' | 'default';
}) {
  return (
    <Select value={value || undefined} onValueChange={onChange}>
      <SelectTrigger className={cn('w-full min-w-0', className)} size={size}>
        {/* Long names are cut with … instead of pushing the field out of its box */}
        <span className="min-w-0 flex-1 truncate text-left"><SelectValue placeholder={placeholder ?? 'Select…'} /></span>
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  body,
  actionLabel,
  onAction,
  children,
}: {
  icon: LucideIcon;
  title: string;
  body?: string;
  actionLabel?: string;
  onAction?: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-slate-300 bg-white px-6 py-10 text-center">
      <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-teal-700/10 text-teal-700">
        <Icon className="h-5 w-5" />
      </div>
      <div className="text-sm font-semibold text-slate-800">{title}</div>
      {body && <p className="mt-1 max-w-md text-xs text-slate-500">{body}</p>}
      {actionLabel && onAction && (
        <Button size="sm" className={cn('mt-4', primaryBtn)} onClick={onAction}>
          {actionLabel}
        </Button>
      )}
      {children}
    </div>
  );
}

export function Kpi({
  icon: Icon,
  label,
  value,
  hint,
  tone = 'teal',
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  hint?: string;
  tone?: 'teal' | 'amber' | 'red' | 'slate';
  onClick?: () => void;
}) {
  const toneCls = {
    teal: 'bg-teal-700/10 text-teal-700',
    amber: 'bg-amber-500/15 text-amber-700',
    red: 'bg-red-500/10 text-red-600',
    slate: 'bg-slate-100 text-slate-600',
  }[tone];
  return (
    <Card
      className={cn('border-slate-200 py-0 shadow-none', onClick && 'cursor-pointer transition-colors hover:bg-slate-50')}
      onClick={onClick}
    >
      <CardContent className="flex items-start gap-3 p-4">
        <div className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg', toneCls)}>
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <div className="text-xs text-slate-500">{label}</div>
          <div className="truncate text-lg font-semibold tracking-tight">{value}</div>
          {hint && <div className="truncate text-[11px] text-slate-400">{hint}</div>}
        </div>
      </CardContent>
    </Card>
  );
}

const toneMap: Record<string, string> = {
  green: 'bg-teal-100 text-teal-800 border-transparent',
  amber: 'bg-amber-100 text-amber-800 border-transparent',
  red: 'bg-red-100 text-red-700 border-transparent',
  blue: 'bg-sky-100 text-sky-800 border-transparent',
  slate: 'bg-slate-100 text-slate-600 border-transparent',
  violet: 'bg-violet-100 text-violet-800 border-transparent',
};

export function Pill({ tone = 'slate', children, className }: { tone?: keyof typeof toneMap | string; children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium capitalize',
        toneMap[tone] ?? toneMap.slate,
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Tone for any status string used across entities. */
export function statusTone(status: string | null | undefined): string {
  switch (status) {
    case 'paid':
    case 'received':
    case 'fulfilled':
    case 'published':
    case 'valid':
    case 'resolved':
    case 'responded':
    case 'approved':
    case 'succeeded':
    case 'active':
    case 'delivered':
    case 'positive':
      return 'green';
    case 'pending':
    case 'pending_approval':
    case 'awaiting_fulfilment':
    case 'in_review':
    case 'issued':
    case 'submitted':
    case 'in_progress':
    case 'partially_received':
    case 'paused':
    case 'neutral':
    case 'medium':
      return 'amber';
    case 'overdue':
    case 'failed':
    case 'invalid':
    case 'error':
    case 'escalated':
    case 'rejected':
    case 'negative':
    case 'high':
    case 'refunded':
    case 'declined':
      return 'red';
    case 'ordered':
    case 'scheduled':
    case 'booked':
    case 'in_transit':
    case 'open':
    case 'new':
      return 'blue';
    default:
      return 'slate';
  }
}

export function StatusPill({ status, label }: { status: string | null | undefined; label?: string }) {
  return <Pill tone={statusTone(status)}>{label ?? (status ?? 'unknown').replace(/_/g, ' ')}</Pill>;
}

export const SOURCE_LABEL: Record<SalesSource, string> = {
  manual: 'Manual',
  pos: 'POS',
  shopee: 'Shopee',
  lazada: 'Lazada',
  tiktok_shop: 'TikTok Shop',
  website: 'Own website',
};

const SOURCE_CLS: Record<SalesSource, string> = {
  manual: 'bg-slate-100 text-slate-700',
  pos: 'bg-amber-100 text-amber-800',
  shopee: 'bg-orange-100 text-orange-700',
  lazada: 'bg-indigo-100 text-indigo-700',
  tiktok_shop: 'bg-zinc-800 text-white',
  website: 'bg-teal-100 text-teal-800',
};

export function SourceBadge({ source }: { source: SalesSource }) {
  return (
    <span className={cn('inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium', SOURCE_CLS[source] ?? SOURCE_CLS.manual)}>
      {SOURCE_LABEL[source] ?? source}
    </span>
  );
}

export const MARKETPLACES: { id: 'shopee' | 'lazada' | 'tiktok_shop'; label: string }[] = [
  { id: 'shopee', label: 'Shopee' },
  { id: 'lazada', label: 'Lazada' },
  { id: 'tiktok_shop', label: 'TikTok Shop' },
];

/** Parse a form string into a number; returns NaN for blank input. */
export function num(v: string): number {
  if (v === undefined || v === null || String(v).trim() === '') return NaN;
  return Number(v);
}

/** yyyy-mm-dd for <input type="date"> from an ISO string (local time). */
export function toDateInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - off).toISOString().slice(0, 10);
}

/** ISO string from a yyyy-mm-dd input (start of that local day, 09:00 to avoid TZ edge cases). */
export function fromDateInput(v: string): string {
  return new Date(`${v}T09:00:00`).toISOString();
}

/** yyyy-mm-ddThh:mm for <input type="datetime-local">. */
export function toDateTimeInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - off).toISOString().slice(0, 16);
}

export function fromDateTimeInput(v: string): string {
  return new Date(v).toISOString();
}

export const todayInput = () => toDateInput(new Date().toISOString());

export function SectionCard({
  title,
  description,
  actions,
  children,
  className,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn('gap-0 border-slate-200 py-0 shadow-none', className)}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
        <div>
          <div className="text-sm font-semibold">{title}</div>
          {description && <div className="text-xs text-slate-500">{description}</div>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      <div className="p-4">{children}</div>
    </Card>
  );
}
