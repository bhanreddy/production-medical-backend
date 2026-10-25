import { AppError } from "../lib/appError";
import { Money } from "../lib/money";
import { localMutate, queryOne, queryRaw } from "../lib/postgresDb";

/** Caller holds a PostgreSQL transaction; lock the party before allocating a receipt. */
export async function settleCloudBalance(input: {
  clinicId: string;
  userId: string;
  kind: "customer" | "supplier";
  partyId: string;
  amount: number;
  mode: string;
  note?: string;
}) {
  const table = input.kind === "customer" ? "customers" : "suppliers";
  const [identity] = await queryRaw(
    `SELECT id FROM ${table} WHERE (_local_id=? OR id::text=?) AND clinic_id=? AND deleted_at IS NULL`,
    [input.partyId, input.partyId, input.clinicId],
  );
  if (!identity) throw new AppError(404, "Account not found");
  const invoices =
    input.kind === "customer"
      ? await queryRaw(
          "SELECT * FROM sales WHERE clinic_id=? AND customer_id=? AND deleted_at IS NULL AND is_return=false AND balance_due>0 ORDER BY created_at, id FOR UPDATE",
          [input.clinicId, identity.id],
        )
      : await queryRaw(
          "SELECT * FROM purchases WHERE clinic_id=? AND supplier_id=? AND deleted_at IS NULL AND net_amount>paid_amount ORDER BY created_at, id FOR UPDATE",
          [input.clinicId, identity.id],
        );
  const party = await queryOne(table, "id=? AND clinic_id=?", [
    identity.id,
    input.clinicId,
  ]);
  if (!party)
    throw new AppError(
      404,
      `${input.kind === "customer" ? "Customer" : "Supplier"} not found`,
    );
  const amount = Money.round2(input.amount);
  const outstanding = Money.round2(Number(party.outstanding_balance || 0));
  if (!Number.isFinite(amount) || amount <= 0)
    throw new AppError(400, "A positive payment amount is required");
  if (amount > outstanding)
    throw new AppError(409, "Payment exceeds the outstanding balance");
  let remaining = amount;
  const allocations: { invoiceId: string; amount: number }[] = [];
  for (const invoice of invoices) {
    if (remaining <= 0) break;
    const due =
      input.kind === "customer"
        ? Number(invoice.balance_due)
        : Money.subtract(invoice.net_amount, invoice.paid_amount || 0);
    const allocated = Math.min(remaining, due);
    const balance = Money.subtract(due, allocated);
    await localMutate({
      table: input.kind === "customer" ? "sales" : "purchases",
      operation: "UPDATE",
      data: {
        _local_id: invoice._local_id || invoice.id,
        paid_amount: Money.add(invoice.paid_amount || 0, allocated),
        payment_status: balance > 0 ? "partial" : "paid",
        ...(input.kind === "customer" ? { balance_due: balance } : {}),
      },
    });
    allocations.push({ invoiceId: invoice.id, amount: allocated });
    remaining = Money.subtract(remaining, allocated);
  }
  const updated = await localMutate({
    table,
    operation: "UPDATE",
    data: {
      _local_id: party._local_id || party.id,
      outstanding_balance: Money.subtract(outstanding, amount),
    },
  });
  await localMutate({
    table: "audit_logs",
    operation: "INSERT",
    data: {
      clinic_id: input.clinicId,
      user_id: input.userId,
      record_id: party.id,
      table_name: table,
      action:
        input.kind === "customer" ? "PAYMENT_RECEIVED" : "PAYMENT_RECORDED",
      new_data: {
        amount,
        payment_mode: input.mode,
        note: input.note || null,
        allocations,
        legacy_balance_amount: remaining,
      },
    },
  });
  return updated;
}
