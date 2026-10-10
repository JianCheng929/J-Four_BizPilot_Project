import { openAgentChat, useActiveAgentTask } from '@/components/bizpilot/agentChat';
import { useState, type ReactNode } from 'react';
import {
  PanelLeftClose,
  PanelLeftOpen,
  LayoutDashboard,
  Sparkles,
  Boxes,
  Truck,
  Megaphone,
  Wallet,
  MessagesSquare,
  ShieldCheck,
  Settings as SettingsIcon,
  Bell,
  Compass,
  FileBarChart,
  Loader2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useBizPilot } from '@/lib/store';
import { AccountMenu, BusinessSwitcher } from './AccountMenu';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { fmtDateTime } from '@/lib/format';

export type PageKey =
  | 'dashboard'
  | 'command'
  | 'inventory'
  | 'supplychain'
  | 'marketing'
  | 'finance'
  | 'customers'
  | 'approvals'
  | 'reports'
  | 'settings';

const NAV: { key: PageKey; label: string; icon: typeof LayoutDashboard }[] = [
  { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { key: 'command', label: 'AI Command Centre', icon: Sparkles },
  { key: 'inventory', label: 'Inventory', icon: Boxes },
  { key: 'supplychain', label: 'Supply Chain', icon: Truck },
  { key: 'marketing', label: 'Marketing Studio', icon: Megaphone },
  { key: 'finance', label: 'Finance', icon: Wallet },
  { key: 'customers', label: 'Customers', icon: MessagesSquare },
  { key: 'approvals', label: 'Approvals', icon: ShieldCheck },
  { key: 'reports', label: 'Reports', icon: FileBarChart },
  { key: 'settings', label: 'Settings', icon: SettingsIcon },
];

export function AppShell({
  page,
  onNavigate,
  children,
}: {
  page: PageKey;
  onNavigate: (p: PageKey) => void;
  children: ReactNode;
}) {
  const { db, markAllNotificationsRead } = useBizPilot();
  const pendingApprovals = db.approvals.filter((a) => a.status === 'pending').length;
  const unread = db.notifications.filter((n) => !n.read).length;
  const working = useActiveAgentTask();
  // Collapsed sidebar shows icons only; remembered per browser.
  const [mini, setMini] = useState(() => { try { return localStorage.getItem('bp.sidebar') === 'mini'; } catch { return false; } });
  const toggleMini = () => setMini((m) => { try { localStorage.setItem('bp.sidebar', m ? 'full' : 'mini'); } catch { /* optional */ } return !m; });

  return (
    <div className="flex min-h-[100dvh] bg-[#f7f8f7] text-slate-900">
      {/* Sidebar */}
      <aside className={cn('fixed inset-y-0 left-0 z-30 flex flex-col border-r border-slate-200 bg-white transition-[width]', mini ? 'w-16' : 'w-60')}>
        <div className={cn('flex items-center gap-2.5 py-5', mini ? 'justify-center px-2' : 'px-5')}>
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-teal-700 text-white">
            <Compass className="h-5 w-5" />
          </div>
          <div className={cn(mini && 'hidden')}>
            <div className="text-[15px] font-semibold tracking-tight">BizPilot</div>
            <div className="text-[11px] text-slate-500">SME Operations Agent</div>
          </div>
        </div>

        <nav className={cn('mt-2 flex-1 space-y-0.5', mini ? 'px-2' : 'px-3')}>
          {NAV.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              onClick={() => onNavigate(key)}
              title={mini ? label : undefined}
              className={cn(
                'relative flex w-full items-center gap-2.5 rounded-lg py-2 text-[13.5px] font-medium transition-colors',
                mini ? 'justify-center px-0' : 'px-3',
                page === key
                  ? 'bg-teal-700/10 text-teal-800'
                  : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
              )}
            >
              <Icon className={cn('h-4 w-4', page === key ? 'text-teal-700' : 'text-slate-400')} />
              {!mini && <span className="flex-1 text-left">{label}</span>}
              {key === 'approvals' && pendingApprovals > 0 && (
                <span className={cn('flex h-5 min-w-5 items-center justify-center rounded-full bg-teal-700 px-1.5 text-[10px] font-semibold text-white', mini && 'absolute -right-0.5 -top-0.5')}>
                  {pendingApprovals}
                </span>
              )}
            </button>
          ))}
        </nav>

        <div className={cn('border-t border-slate-200 p-4', mini && 'hidden')}>
          <BusinessSwitcher />
        </div>
      </aside>

      {/* Main */}
      <div className={cn('flex min-w-0 flex-1 flex-col transition-[margin]', mini ? 'ml-16' : 'ml-60')}>
        <header className="sticky top-0 z-20 flex h-14 items-center justify-between border-b border-slate-200 bg-white/80 px-6 backdrop-blur">
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <Button variant="ghost" size="icon-sm" title={mini ? 'Expand menu' : 'Minimize menu'} onClick={toggleMini}>
              {mini ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
            </Button>
            {new Date().toLocaleDateString('en-MY', {
              weekday: 'long',
              day: 'numeric',
              month: 'long',
              year: 'numeric',
            })}
          </div>
          <div className="flex items-center gap-2">
            {working && (
              <button
                onClick={() => openAgentChat(working.conversationId || working.id)}
                className="flex max-w-[22rem] items-center gap-2 rounded-full border border-teal-200 bg-teal-50 px-3 py-1 text-xs font-medium text-teal-800 hover:bg-teal-100"
                title="Open what BizPilot is doing"
              >
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                <span className="truncate">BizPilot is working: {working.prompt.split('\n')[0].replace(/^BizPilot noticed this by itself[^:]*: /, '').slice(0, 70)}</span>
              </button>
            )}
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className="relative gap-2">
                  <Bell className="h-4 w-4" />
                  Alerts
                  {unread > 0 && (
                    <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[9px] font-bold text-white">
                      {unread}
                    </span>
                  )}
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-96 p-0">
                <div className="flex items-center justify-between border-b px-4 py-2.5">
                  <span className="text-sm font-semibold">Notifications</span>
                  <button
                    onClick={markAllNotificationsRead}
                    className="text-xs text-teal-700 hover:underline"
                  >
                    Mark all read
                  </button>
                </div>
                <div className="max-h-80 overflow-y-auto">
                  {db.notifications.map((n) => (
                    <div
                      key={n.id}
                      className={cn(
                        'border-b px-4 py-3 last:border-0',
                        !n.read && 'bg-teal-50/50',
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className={cn(
                            'h-1.5 w-1.5 rounded-full',
                            n.severity === 'critical'
                              ? 'bg-red-500'
                              : n.severity === 'warning'
                                ? 'bg-amber-500'
                                : 'bg-sky-500',
                          )}
                        />
                        <span className="text-[13px] font-medium">{n.title}</span>
                        <span className="ml-auto text-[10px] text-slate-400">
                          {fmtDateTime(n.at)}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-slate-600">{n.body}</p>
                    </div>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
            <AccountMenu onNavigate={onNavigate} />
          </div>
        </header>

        <main className="flex-1 px-6 py-6">{children}</main>
      </div>
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-slate-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
