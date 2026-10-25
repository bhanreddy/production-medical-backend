import { queryAll, queryRaw } from './postgresDb';
import { computeCogs } from './cogsQuery';

export interface AccountingSummaryResult {
  gross_revenue: number;
  total_returns: number;
  net_revenue: number;
  cogs: number;
  gross_profit: number;
  gross_margin_pct: number;
  total_expenses: number;
  net_profit: number;
  outstanding_receivable: number;
  outstanding_payable: number;
  net_cash_position: number;
  period: { from: string | null; to: string | null };
}

import { Money } from './money';

export async function buildAccountingSummary(
  clinicId: string,
  from?: string,
  to?: string,
): Promise<AccountingSummaryResult> {
  const salesConditions = ['deleted_at IS NULL', 'clinic_id = ?'];
  const expConditions = ['deleted_at IS NULL', 'clinic_id = ?'];
  const salesValues: unknown[] = [clinicId];
  const expValues: unknown[] = [clinicId];

  if (from) {
    salesConditions.push('created_at >= ?');
    salesValues.push(from);
    expConditions.push('expense_date >= ?');
    expValues.push(from);
  }
  if (to) {
    salesConditions.push('created_at <= ?');
    salesValues.push(to);
    expConditions.push('expense_date <= ?');
    expValues.push(to);
  }

  const sales = await queryRaw<{ net_amount: number; is_return: number | boolean }>(
    `SELECT net_amount, is_return FROM sales WHERE ${salesConditions.join(' AND ')}`,
    salesValues,
  );

  let gross_revenue = 0;
  let total_returns = 0;
  for (const s of sales) {
    if (s.is_return) total_returns = Money.add(total_returns, Math.abs(Number(s.net_amount || 0)));
    else gross_revenue = Money.add(gross_revenue, Number(s.net_amount || 0));
  }

  const net_revenue = Money.subtract(gross_revenue, total_returns);
  const cogs = Money.round2(await computeCogs(from, to, clinicId));
  const gross_profit = Money.subtract(net_revenue, cogs);
  const gross_margin_pct = net_revenue > 0 ? Money.round2((gross_profit / net_revenue) * 100) : 0;

  const expRows = await queryRaw<{ total: number | string | null }>(
    `SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE ${expConditions.join(' AND ')}`,
    expValues,
  );
  const total_expenses = Money.round2(Number(expRows[0]?.total ?? 0));
  const net_profit = Money.subtract(gross_profit, total_expenses);

  const customers = await queryAll('customers', 'clinic_id = ?', [clinicId]);
  const outstanding_receivable = customers.reduce(
    (acc: number, c: Record<string, unknown>) =>
      Money.add(acc, Number(c.outstanding_balance ?? c.credit_balance ?? 0)),
    0,
  );

  const suppliers = await queryAll('suppliers', 'clinic_id = ?', [clinicId]);
  const outstanding_payable = suppliers.reduce(
    (acc: number, s: Record<string, unknown>) => Money.add(acc, Number(s.outstanding_balance ?? 0)),
    0,
  );

  const net_cash_position = Money.subtract(Money.add(net_profit, outstanding_receivable), outstanding_payable);

  return {
    gross_revenue,
    total_returns,
    net_revenue,
    cogs,
    gross_profit,
    gross_margin_pct,
    total_expenses,
    net_profit,
    outstanding_receivable,
    outstanding_payable,
    net_cash_position,
    period: { from: from ?? null, to: to ?? null },
  };
}

/** Mobile-friendly camelCase aliases on top of snake_case summary. */
export function toAccountingSummaryPayload(summary: AccountingSummaryResult) {
  return {
    ...summary,
    totalRevenue: summary.gross_revenue,
    totalReturns: summary.total_returns,
    netRevenue: summary.net_revenue,
    totalPurchases: summary.cogs,
    totalExpenses: summary.total_expenses,
    netProfit: summary.net_profit,
    receivables: summary.outstanding_receivable,
    payables: summary.outstanding_payable,
    cashInHand: summary.net_cash_position,
    grossProfit: summary.gross_profit,
    grossMarginPct: summary.gross_margin_pct,
  };
}
