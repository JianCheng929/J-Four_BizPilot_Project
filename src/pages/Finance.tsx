import { AgentPanel } from '@/components/bizpilot/AgentPanel';
import { useEffect, useRef, useState } from 'react';
import { useBizPilot } from '@/lib/store';
import * as ops from '@/lib/ops';
import { cashPosition, salesLastNDays, upcomingBills } from '@/lib/metrics';
import { money } from '@/lib/format';
import { CapitalButton } from '@/components/bizpilot/CapitalDialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PageHeader } from '@/components/layout/AppShell';
import { SalesTab } from '@/components/bizpilot/finance/SalesTab';
import { ExpensesTab } from '@/components/bizpilot/finance/ExpensesTab';
import { InvoicesTab } from '@/components/bizpilot/finance/InvoicesTab';
import { QuotationsTab } from '@/components/bizpilot/finance/QuotationsTab';
import { AgeingTab } from '@/components/bizpilot/finance/AgeingTab';
import { receivablesAgeing } from '@/lib/metrics';
import { PnLTab } from '@/components/bizpilot/finance/PnLTab';
import { CashFlowTab } from '@/components/bizpilot/finance/CashFlowTab';
import { BudgetTab } from '@/components/bizpilot/finance/BudgetTab';
import { MarginCheck } from '@/components/bizpilot/MarginCheck';
import { PricingCalculator } from '@/components/bizpilot/PricingCalculator';

const DAY = 86400000;

export function Finance() {
  const { db, run } = useBizPilot();
  const [tab, setTab] = useState('sales');
  const [viewInvoice, setViewInvoice] = useState<string | null>(null);
  const checked = useRef(false);

  // Move issued invoices past their due date to "overdue" once per visit.
  useEffect(() => {
    if (checked.current) return;
    checked.current = true;
    const wouldChange = db.invoices.some((i) => i.status === 'issued' && new Date(i.dueDate).getTime() < Date.now() - DAY);
    const quotesExpire = (db.quotations ?? []).some((q) => (q.status === 'draft' || q.status === 'sent') && new Date(q.validUntil).getTime() < Date.now() - DAY);
    if (wouldChange || quotesExpire) run((d) => { ops.refreshOverdue(d); ops.refreshExpiredQuotations(d); });
  }, [db.invoices, db.quotations, run]);

  const week = salesLastNDays(db, 7);
  const bills = upcomingBills(db, 7);

  return (
    <div>
      <PageHeader
        title="Finance"
        subtitle={
          `Money available: ${money(cashPosition(db).balance)}${db.settings.openingCashDate ? '' : ' (starting capital not set yet)'}` +
          (db.salesOrders.length || db.expenses.length
            ? ` · Last 7 days: ${money(week.revenue)} from ${week.orders} order(s)${bills.length ? ` · ${bills.length} bill(s) due within 7 days` : ''}`
            : '')
        }
        actions={<CapitalButton />}
      />
      <AgentPanel page="finance" className="mb-4" />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="sales">Sales</TabsTrigger>
          <TabsTrigger value="expenses">Expenses</TabsTrigger>
          <TabsTrigger value="quotes">Quotations</TabsTrigger>
          <TabsTrigger value="invoices">Invoices</TabsTrigger>
          <TabsTrigger value="ageing">Who owes what{receivablesAgeing(db).overdue > 0 ? ' •' : ''}</TabsTrigger>
          <TabsTrigger value="pnl">P&amp;L</TabsTrigger>
          <TabsTrigger value="cash">Cash flow</TabsTrigger>
          <TabsTrigger value="budget">Budget</TabsTrigger>
          <TabsTrigger value="pricing">Pricing</TabsTrigger>
        </TabsList>
        <TabsContent value="sales" className="mt-4">
          <SalesTab
            onOpenInvoice={(id) => {
              setViewInvoice(id);
              setTab('invoices');
            }}
          />
        </TabsContent>
        <TabsContent value="expenses" className="mt-4">
          <ExpensesTab />
        </TabsContent>
        <TabsContent value="quotes" className="mt-4">
          <QuotationsTab
            onOpenInvoice={(id) => {
              setViewInvoice(id);
              setTab('invoices');
            }}
          />
        </TabsContent>
        <TabsContent value="ageing" className="mt-4">
          <AgeingTab />
        </TabsContent>
        <TabsContent value="invoices" className="mt-4">
          <InvoicesTab viewId={viewInvoice} onView={setViewInvoice} />
        </TabsContent>
        <TabsContent value="pnl" className="mt-4">
          <PnLTab onGoToSales={() => setTab('sales')} />
        </TabsContent>
        <TabsContent value="cash" className="mt-4">
          <CashFlowTab />
        </TabsContent>
        <TabsContent value="budget" className="mt-4">
          <BudgetTab />
        </TabsContent>
        <TabsContent value="pricing" className="mt-4 space-y-4">
          <MarginCheck />
          <PricingCalculator />
        </TabsContent>
      </Tabs>
    </div>
  );
}
