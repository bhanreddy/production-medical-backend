const escapeInvoiceHtml = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
import { resolveCloudStoreContext } from "../services/cloudStoreContext";
import { transactionalRoute } from "../lib/transactionalRoute";
import {
  afterPostgresCommit,
  localMutate,
  localInsertMany,
  queryAll,
  queryOne,
  queryRaw,
  queryCount,
} from "../lib/postgresDb";
import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { requireRole } from "../middleware/rbac";
import { createSaleSchema, saleReturnSchema } from "../schemas/sale.schema";
import { AppError } from "../lib/appError";
import { enforcePlan } from "../middleware/planEnforcement";
import { Money } from "../lib/money";
import { DailySalesSummaryService } from "../services/dailySalesSummary";
import { cloudDocumentNumber } from "../services/cloudDocumentNumber";
import { InventoryPositionService } from "../services/inventoryPosition";
import { loadSaleReferences } from "../services/saleReferences";

export const salesRouter = Router();

// GET /api/sales
salesRouter.get("/", requireAuth, async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.max(
      1,
      Math.min(parseInt(req.query.limit as string) || 20, 100),
    );
    const customer_id = req.query.customer_id as string;
    const medicine_id = req.query.medicine_id as string;
    const store_id = req.query.store_id as string;
    const from = req.query.from as string;
    const to = req.query.to as string;
    const payment_status = req.query.payment_status as string;
    const search = typeof req.query.q === "string" ? req.query.q.trim() : "";

    const clinicId = req.user!.clinic_id!;
    const conditions: string[] = ["clinic_id=?"];
    const values: any[] = [clinicId];

    if (store_id) {
      conditions.push("store_id=?");
      values.push(store_id);
    }
    if (medicine_id) {
      const med = await queryOne(
        "medicines",
        "(_local_id=? OR id=?) AND clinic_id=?",
        [medicine_id, medicine_id, clinicId],
      );
      const resolvedMedicineId = med ? (med as any).id : medicine_id;
      conditions.push(
        "id IN (SELECT sale_id FROM sale_items WHERE _deleted=0 AND medicine_id=?)",
      );
      values.push(resolvedMedicineId);
    }
    if (customer_id) {
      conditions.push("customer_id=?");
      values.push(customer_id);
    }
    if (payment_status) {
      conditions.push("payment_status=?");
      values.push(payment_status);
    }
    if (from) {
      conditions.push("created_at>=?");
      values.push(from);
    }
    if (to) {
      conditions.push("created_at<=?");
      values.push(to);
    }

    if (search) {
      conditions.push(`(invoice_number ILIKE ? OR payment_mode ILIKE ? OR EXISTS (
        SELECT 1 FROM customers c WHERE c.clinic_id = sales.clinic_id AND c._deleted = 0
          AND (c.id = sales.customer_id OR c._local_id = sales.customer_id) AND c.name ILIKE ?
      ))`);
      const pattern = `%${search.replace(/[\\%_]/g, "\\$&")}%`;
      values.push(pattern, pattern, pattern);
    }

    const where = conditions.length > 0 ? conditions.join(" AND ") : "";
    const offset = (page - 1) * limit;

    let queryStr = `SELECT * FROM sales WHERE _deleted = 0`;
    if (where) {
      queryStr += ` AND (${where})`;
    }
    queryStr += ` ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`;

    const [total, data] = await Promise.all([
      queryCount("sales", where, values),
      queryRaw(queryStr, [...values, limit, offset]),
    ]);

    // Attach customer name (in batch)
    const customerIds = [
      ...new Set(data.map((sale: any) => sale.customer_id).filter(Boolean)),
    ];
    if (customerIds.length > 0) {
      const placeholders = customerIds.map(() => "?").join(",");
      const customers = await queryRaw(
        `SELECT id, _local_id, name FROM customers WHERE (_local_id IN (${placeholders}) OR id IN (${placeholders})) AND clinic_id = ? AND _deleted = 0`,
        [...customerIds, ...customerIds, clinicId],
      );
      const customerMap = new Map();
      for (const cust of customers) {
        customerMap.set(cust.id, cust);
        customerMap.set(cust._local_id, cust);
      }
      for (const sale of data) {
        if (sale.customer_id) {
          const cust = customerMap.get(sale.customer_id);
          sale.customers = { name: cust?.name ?? "" };
        } else {
          sale.customers = { name: "" };
        }
      }
    } else {
      for (const sale of data) {
        sale.customers = { name: "" };
      }
    }

    res.json({
      data,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/sales/:id
salesRouter.get("/:id", requireAuth, async (req, res, next) => {
  if (req.params.id === "returns") return next();
  try {
    const clinicId = req.user!.clinic_id!;
    const sale = await queryOne(
      "sales",
      "(_local_id=? OR id=?) AND clinic_id=?",
      [req.params.id, req.params.id, clinicId],
    );
    if (!sale) return res.status(404).json({ error: "Sale not found" });

    const saleId = (sale as any).id;
    const saleItems = await queryAll("sale_items", "sale_id=?", [saleId]);

    // Attach medicine names and batch numbers (in batch)
    const medicineIds = saleItems
      .map((item: any) => item.medicine_id)
      .filter(Boolean);
    const batchIds = saleItems
      .map((item: any) => item.batch_id)
      .filter(Boolean);

    let medicineMap = new Map();
    if (medicineIds.length > 0) {
      const placeholders = medicineIds.map(() => "?").join(",");
      const medicines = await queryRaw(
        `SELECT id, _local_id, name FROM medicines WHERE (_local_id IN (${placeholders}) OR id IN (${placeholders})) AND _deleted = 0`,
        [...medicineIds, ...medicineIds],
      );
      for (const med of medicines) {
        medicineMap.set(med.id, med);
        medicineMap.set(med._local_id, med);
      }
    }

    let batchMap = new Map();
    if (batchIds.length > 0) {
      const placeholders = batchIds.map(() => "?").join(",");
      const batches = await queryRaw(
        `SELECT id, _local_id, batch_number, expiry_date FROM medicine_batches WHERE (_local_id IN (${placeholders}) OR id IN (${placeholders})) AND _deleted = 0`,
        [...batchIds, ...batchIds],
      );
      for (const b of batches) {
        batchMap.set(b.id, b);
        batchMap.set(b._local_id, b);
      }
    }

    for (const item of saleItems) {
      if (item.medicine_id) {
        const med = medicineMap.get(item.medicine_id);
        item.medicines = { name: med?.name ?? "" };
      } else {
        item.medicines = { name: "" };
      }
      if (item.batch_id) {
        const batch = batchMap.get(item.batch_id);
        item.medicine_batches = {
          batch_number: batch?.batch_number ?? "",
          expiry_date: batch?.expiry_date ?? "",
        };
      } else {
        item.medicine_batches = { batch_number: "", expiry_date: "" };
      }
    }

    res.json({ data: { ...sale, sale_items: saleItems } });
  } catch (err) {
    next(err);
  }
});

// POST /api/sales
salesRouter.post(
  "/",
  requireAuth,
  requireRole("PHARMACIST", "CASHIER", "OWNER"),
  enforcePlan,
  transactionalRoute(async (req, res, next) => {
    try {
      const parsed = createSaleSchema.parse(req.body);
      const clinicId = req.user!.clinic_id!;

      const { organizationId, storeId, counterId, terminalId } =
        await resolveCloudStoreContext(clinicId, parsed);

      // Stock Validation & ID Resolution Map
      const references = await loadSaleReferences(parsed.items, clinicId);
      const resolvedIdsMap = new Map<
        string,
        {
          resolvedMedicineId: string;
          resolvedBatchId: string;
          batchLocalId: string;
          currentStock: number;
        }
      >();
      const reservedQuantities = new Map<string, number>();
      for (const item of parsed.items) {
        const batch = references.batches.get(item.batch_id);
        if (!batch)
          throw new AppError(
            404,
            `Batch not found: ${item.batch_id}`,
            "BATCH_NOT_FOUND",
          );
        if (
          (batch as any).is_disposed === true ||
          (batch as any).is_disposed === 1
        ) {
          throw new AppError(
            400,
            `Batch is disposed and cannot be sold: ${item.batch_id}`,
            "BATCH_DISPOSED",
          );
        }

        // Expired batch check
        const expiry = (batch as any).expiry_date
          ? new Date((batch as any).expiry_date).toISOString().split("T")[0]
          : "";
        const today = new Date().toISOString().split("T")[0];
        if (expiry && expiry < today) {
          throw new AppError(
            400,
            `Batch ${(batch as any).batch_number || item.batch_id} is expired (${expiry}) and cannot be sold.`,
            "EXPIRED_BATCH",
          );
        }

        const med = references.medicines.get(item.medicine_id);
        if (!med)
          throw new AppError(
            404,
            `Medicine not found: ${item.medicine_id}`,
            "MEDICINE_NOT_FOUND",
          );

        if (batch.medicine_id !== med.id && batch.medicine_id !== med._local_id)
          throw new AppError(
            400,
            "Selected batch does not belong to the selected medicine",
            "BATCH_MEDICINE_MISMATCH",
          );
        const stockRemaining = Number((batch as any).quantity_remaining ?? 0);
        const batchKey = String(batch.id || batch._local_id);
        const requestedQuantity =
          (reservedQuantities.get(batchKey) || 0) + item.quantity;
        reservedQuantities.set(batchKey, requestedQuantity);
        if (stockRemaining < requestedQuantity) {
          throw new AppError(
            409,
            `Insufficient stock for ${(med as any).name}. Available: ${stockRemaining}, Requested: ${item.quantity}`,
            "INSUFFICIENT_STOCK",
          );
        }

        resolvedIdsMap.set(`${item.medicine_id}:${item.batch_id}`, {
          resolvedMedicineId: (med as any).id,
          resolvedBatchId: (batch as any).id,
          batchLocalId: (batch as any)._local_id || (batch as any).id,
          currentStock: stockRemaining,
        });
      }

      // Money Calculations using Canonical Engine
      const calculatedItems = parsed.items.map((item) => {
        const lineCalc = Money.calculateLineItem({
          quantity: item.quantity,
          unitPrice: item.mrp,
          discountPct: item.discount_pct,
          gstRate: item.gst_rate,
          isInterstate: false,
          priceIncludesTax: parsed.price_includes_tax,
        });
        const resolved = resolvedIdsMap.get(
          `${item.medicine_id}:${item.batch_id}`,
        )!;
        return {
          item,
          lineCalc,
          resolved,
        };
      });

      const grandCalc = Money.calculateGrandTotal({
        items: parsed.items.map((i) => ({
          quantity: i.quantity,
          unitPrice: i.mrp,
          discountPct: i.discount_pct,
          gstRate: i.gst_rate,
        })),
        billDiscount: parsed.discount,
        paidAmount: parsed.paid_amount,
        priceIncludesTax: parsed.price_includes_tax,
        isInterstate: false,
      });

      // Resolve customer_id
      let customerId = null;
      let customerObj: any = null;
      if (parsed.customer_id) {
        const cust = await queryOne(
          "customers",
          "(_local_id=? OR id=?) AND clinic_id=?",
          [parsed.customer_id, parsed.customer_id, clinicId],
        );
        if (cust) {
          customerId = (cust as any).id;
          customerObj = cust;
        }
      }

      if (
        customerObj &&
        Number(customerObj.credit_limit) > 0 &&
        Number(customerObj.outstanding_balance || 0) + grandCalc.balanceDue >
          Number(customerObj.credit_limit)
      )
        throw new AppError(
          409,
          "Customer credit limit would be exceeded",
          "CREDIT_LIMIT_EXCEEDED",
        );

      // Generate Concurrency-Safe Invoice Number
      const invoiceNumber = await cloudDocumentNumber(clinicId);

      // Insert Sale locally
      const sale = await localMutate({
        table: "sales",
        operation: "INSERT",
        data: {
          organization_id: organizationId,
          store_id: storeId,
          counter_id: counterId,
          terminal_id: terminalId,
          clinic_id: clinicId,
          customer_id: customerId,
          invoice_number: invoiceNumber,
          price_includes_tax: parsed.price_includes_tax,
          subtotal: grandCalc.subtotal,
          discount: grandCalc.totalDiscount,
          gst_amount: grandCalc.totalGst,
          net_amount: grandCalc.grandTotal,
          grand_total: grandCalc.grandTotal,
          payment_mode: parsed.payment_mode,
          payment_status:
            grandCalc.balanceDue > 0
              ? grandCalc.paidAmount > 0
                ? "partial"
                : "credit"
              : "paid",
          paid_amount: grandCalc.paidAmount,
          balance_due: grandCalc.balanceDue,
          served_by: req.user!.id,
          _local_id: parsed._local_id,
        },
      });

      // Insert Sale Items + Deduct Batch Stock + Adjust Inventory Position + Record Stock Ledger
      const itemRows: Record<string, any>[] = [];
      const ledgerRows: Record<string, any>[] = [];
      const stockUpdates = new Map<string, number>();
      for (const calcEntry of calculatedItems) {
        const { item, lineCalc, resolved } = calcEntry;
        const saleItemData = {
          organization_id: organizationId,
          store_id: storeId,
          clinic_id: clinicId,
          sale_id: sale.id,
          medicine_id: resolved.resolvedMedicineId,
          batch_id: resolved.resolvedBatchId,
          quantity: item.quantity,
          unit_price: item.mrp,
          discount_pct: item.discount_pct,
          gst_rate: item.gst_rate,
          total: lineCalc.total,
          _local_id: item._local_id,
        };

        itemRows.push(saleItemData);

        // Deduct stock atomically
        const newQuantity = resolved.currentStock - item.quantity;
        for (const entry of resolvedIdsMap.values())
          if (entry.resolvedBatchId === resolved.resolvedBatchId)
            entry.currentStock = newQuantity;
        stockUpdates.set(resolved.resolvedBatchId, newQuantity);

        // Adjust Enterprise Inventory Position
        afterPostgresCommit(() => {
          if (storeId && organizationId) {
            try {
              InventoryPositionService.adjustStock({
                organizationId,
                medicineId: resolved.resolvedMedicineId,
                batchId: resolved.resolvedBatchId,
                locationType: "STORE",
                storeId,
                quantityDelta: -item.quantity,
              });
            } catch {
              // If position not yet initialized, create on the fly
              InventoryPositionService.getOrCreatePosition({
                organizationId,
                medicineId: resolved.resolvedMedicineId,
                batchId: resolved.resolvedBatchId,
                locationType: "STORE",
                storeId,
                initialStock: newQuantity,
              });
            }
          }
        });

        // Insert Immutable Stock Ledger Movement
        ledgerRows.push({
            organization_id: organizationId,
            store_id: storeId,
            counter_id: counterId,
            terminal_id: terminalId,
            clinic_id: clinicId,
            medicine_id: resolved.resolvedMedicineId,
            batch_id: resolved.resolvedBatchId,
            movement_type: "SALE",
            quantity_delta: -item.quantity,
            balance_after: newQuantity,
            reference_id: sale.id,
            performed_by: req.user!.id,
        });
      }

      // The reference loader holds row locks until commit. Persist all line
      // items, final stock balances and ledger movements in three round trips.
      const finalItems = await localInsertMany("sale_items", itemRows);
      await queryRaw(
        `UPDATE medicine_batches AS b SET quantity_remaining = u.quantity, updated_at = ?
         FROM jsonb_to_recordset(?::text::jsonb) AS u(id uuid, quantity integer)
         WHERE b.id = u.id AND b.clinic_id = ? AND b.deleted_at IS NULL`,
        [new Date().toISOString(), JSON.stringify([...stockUpdates].map(([id, quantity]) => ({ id, quantity }))), clinicId],
      );
      await localInsertMany("stock_ledger", ledgerRows);

      // Update Customer Outstanding Balance if credit/unpaid
      if (customerId && grandCalc.balanceDue > 0 && customerObj) {
        const updatedBalance = Money.add(
          customerObj.outstanding_balance || 0,
          grandCalc.balanceDue,
        );
        await localMutate({
          table: "customers",
          operation: "UPDATE",
          data: {
            _local_id: customerObj._local_id || customerObj.id,
            outstanding_balance: updatedBalance,
          },
        });
      }

      // Refresh Daily Sales Summary in background
      afterPostgresCommit(() => {
        void DailySalesSummaryService.refresh();
      });

      res.status(201).json({ data: { ...sale, sale_items: finalItems } });
    } catch (err) {
      next(err);
    }
  }),
);

// POST /api/sales/returns
salesRouter.post(
  "/returns",
  requireAuth,
  requireRole("PHARMACIST", "OWNER"),
  transactionalRoute(async (req, res, next) => {
    try {
      const parsed = saleReturnSchema.parse(req.body);
      const clinicId = req.user!.clinic_id!;

      // Resolve original_sale_id
      let returnOfId = null;
      let originalSale: any = null;
      if (parsed.original_sale_id) {
        const [origSale] = await queryRaw(
          "SELECT * FROM sales WHERE (_local_id = ? OR id = ?) AND clinic_id = ? AND deleted_at IS NULL FOR UPDATE",
          [parsed.original_sale_id, parsed.original_sale_id, clinicId],
        );
        if (origSale) {
          returnOfId = (origSale as any).id;
          originalSale = origSale;
        }
      }

      if (!originalSale || originalSale.is_return)
        throw new AppError(404, "Original sale not found", "SALE_NOT_FOUND");
      const organizationId = originalSale.organization_id || null;
      const storeId = parsed.store_id || originalSale?.store_id || null;
      const counterId = parsed.counter_id || originalSale?.counter_id || null;
      const terminalId =
        parsed.terminal_id || originalSale?.terminal_id || null;

      let totalRefundAmount = 0;

      // Generate Return Document Number
      const returnDocNumber = await cloudDocumentNumber(clinicId, "RET");

      // Insert return sale locally
      const returnSale = await localMutate({
        table: "sales",
        operation: "INSERT",
        data: {
          organization_id: organizationId,
          store_id: storeId,
          counter_id: counterId,
          terminal_id: terminalId,
          clinic_id: clinicId,
          invoice_number: returnDocNumber,
          is_return: true,
          return_of: returnOfId,
          payment_status: "returned",
          served_by: req.user!.id,
          _local_id: parsed._local_id,
        },
      });

      // Insert return items + restore stock + adjust inventory position + record stock ledger
      for (const retItem of parsed.items) {
        const origItem = (await queryOne("sale_items", "_local_id=? OR id=?", [
          retItem.sale_item_id,
          retItem.sale_item_id,
        ])) as any;
        if (!origItem) {
          throw new AppError(
            404,
            `Original sale item ${retItem.sale_item_id} not found`,
            "SALE_ITEM_NOT_FOUND",
          );
        }

        const parentSale = await queryOne("sales", "id=? AND clinic_id=?", [
          origItem.sale_id,
          clinicId,
        ]);
        if (!parentSale) {
          throw new AppError(
            404,
            `Original sale item ${retItem.sale_item_id} not found for this clinic`,
            "SALE_ITEM_NOT_FOUND",
          );
        }

        if (origItem.sale_id !== originalSale.id)
          throw new AppError(
            400,
            "Return item does not belong to the original sale",
          );
        const [returned] = await queryRaw<{ quantity: number }>(
          `SELECT COALESCE(SUM(ri.quantity), 0)::int AS quantity FROM sale_items ri JOIN sales rs ON rs.id = ri.sale_id WHERE ri.clinic_id = ? AND ri.sale_item_id = ? AND ri.deleted_at IS NULL AND rs.deleted_at IS NULL AND rs.is_return = true`,
          [clinicId, origItem.id],
        );
        if (retItem.quantity + Number(returned.quantity) > origItem.quantity) {
          throw new AppError(
            400,
            `Return quantity (${retItem.quantity}) exceeds sold quantity (${origItem.quantity})`,
            "INVALID_RETURN_QUANTITY",
          );
        }

        const itemUnitPrice = Number(origItem.unit_price || origItem.mrp || 0);
        const itemDisc = Number(origItem.discount_pct || 0);
        const itemGst = Number(origItem.gst_rate || 0);
        const itemCalc = Money.calculateLineItem({
          quantity: retItem.quantity,
          unitPrice: itemUnitPrice,
          discountPct: itemDisc,
          gstRate: itemGst,
          priceIncludesTax: Boolean(originalSale.price_includes_tax),
        });

        totalRefundAmount = Money.add(totalRefundAmount, itemCalc.total);

        await localMutate({
          table: "sale_items",
          operation: "INSERT",
          data: {
            organization_id: organizationId,
            store_id: storeId,
            clinic_id: clinicId,
            sale_id: returnSale.id,
            sale_item_id: origItem.id,
            medicine_id: origItem.medicine_id,
            batch_id: origItem.batch_id,
            quantity: retItem.quantity,
            unit_price: itemUnitPrice,
            total: itemCalc.total,
            reason: retItem.reason || "Customer return",
            _local_id: retItem._local_id,
          },
        });

        // Restore batch stock atomically
        if (origItem.batch_id) {
          const batch = (await queryOne(
            "medicine_batches",
            "(_local_id=? OR id=?) AND clinic_id=?",
            [origItem.batch_id, origItem.batch_id, clinicId],
          )) as any;
          if (batch) {
            const restoredQty =
              Number(batch.quantity_remaining || 0) + retItem.quantity;
            await localMutate({
              table: "medicine_batches",
              operation: "UPDATE",
              data: {
                _local_id: batch._local_id || batch.id,
                quantity_remaining: restoredQty,
              },
            });

            // Adjust Inventory Position
            afterPostgresCommit(() => {
              if (storeId && organizationId) {
                try {
                  InventoryPositionService.adjustStock({
                    organizationId,
                    medicineId: origItem.medicine_id,
                    batchId: origItem.batch_id,
                    locationType: "STORE",
                    storeId,
                    quantityDelta: retItem.quantity,
                  });
                } catch {
                  InventoryPositionService.getOrCreatePosition({
                    organizationId,
                    medicineId: origItem.medicine_id,
                    batchId: origItem.batch_id,
                    locationType: "STORE",
                    storeId,
                    initialStock: restoredQty,
                  });
                }
              }
            });

            // Insert Immutable Stock Ledger Movement
            await localMutate({
              table: "stock_ledger",
              operation: "INSERT",
              data: {
                organization_id: organizationId,
                store_id: storeId,
                counter_id: counterId,
                terminal_id: terminalId,
                clinic_id: clinicId,
                medicine_id: origItem.medicine_id,
                batch_id: origItem.batch_id,
                movement_type: "SALE_RETURN",
                quantity_delta: retItem.quantity,
                balance_after: restoredQty,
                reference_id: returnSale.id,
                notes: retItem.reason || "Customer return",
                performed_by: req.user!.id,
              },
            });
          }
        }
      }

      // Update return sale with calculated refund totals
      const updatedReturn = await localMutate({
        table: "sales",
        operation: "UPDATE",
        data: {
          _local_id: returnSale._local_id || returnSale.id,
          net_amount: totalRefundAmount,
          grand_total: totalRefundAmount,
        },
      });

      let creditReduction = 0;
      // If customer had an outstanding balance on original sale, reduce it
      if (
        originalSale &&
        originalSale.customer_id &&
        Number(originalSale.balance_due) > 0
      ) {
        const cust = (await queryOne("customers", "id=? AND clinic_id=?", [
          originalSale.customer_id,
          clinicId,
        ])) as any;
        if (cust) {
          const reduction = Math.min(
            Number(originalSale.balance_due || 0),
            Number(cust.outstanding_balance || 0),
            totalRefundAmount,
          );
          creditReduction = reduction;
          await localMutate({
            table: "sales",
            operation: "UPDATE",
            data: {
              _local_id: originalSale._local_id || originalSale.id,
              balance_due: Money.subtract(
                originalSale.balance_due || 0,
                reduction,
              ),
            },
          });
          const newBalance = Money.subtract(
            cust.outstanding_balance || 0,
            reduction,
          );
          await localMutate({
            table: "customers",
            operation: "UPDATE",
            data: {
              _local_id: cust._local_id || cust.id,
              outstanding_balance: Math.max(0, newBalance),
            },
          });
        }
      }

      // Refresh Daily Sales Summary in background
      afterPostgresCommit(() => {
        void DailySalesSummaryService.refresh();
      });

      const refund = await localMutate({
        table: "sales",
        operation: "UPDATE",
        data: {
          _local_id: returnSale._local_id || returnSale.id,
          paid_amount: Money.subtract(totalRefundAmount, creditReduction),
          balance_due: 0,
        },
      });
      res.json({ data: { ...updatedReturn, ...refund } });
    } catch (err) {
      next(err);
    }
  }),
);

// GET /api/sales/:id/invoice
salesRouter.get("/:id/invoice", requireAuth, async (req, res, next) => {
  try {
    const sale = (await queryOne(
      "sales",
      "(_local_id=? OR id=?) AND clinic_id=?",
      [req.params.id, req.params.id, req.user!.clinic_id!],
    )) as any;
    if (!sale) return res.status(404).json({ error: "Sale not found" });

    const saleItems = await queryAll(
      "sale_items",
      "sale_id=? AND clinic_id=?",
      [sale.id, req.user!.clinic_id!],
    );
    const clinic = (await queryOne("clinics", "id=?", [
      req.user!.clinic_id!,
    ])) as any;

    // Attach medicine names
    for (const item of saleItems) {
      if ((item as any).medicine_id) {
        const med = await queryOne("medicines", "_local_id=? OR id=?", [
          (item as any).medicine_id,
          (item as any).medicine_id,
        ]);
        (item as any).medicines = { name: (med as any)?.name ?? "" };
      }
      if ((item as any).batch_id) {
        const batch = await queryOne(
          "medicine_batches",
          "_local_id=? OR id=?",
          [(item as any).batch_id, (item as any).batch_id],
        );
        (item as any).medicine_batches = {
          batch_number: (batch as any)?.batch_number ?? "",
          expiry_date: (batch as any)?.expiry_date ?? "",
        };
      }
    }

    let customerName = "Walk-in";
    if (sale.customer_id) {
      const cust = await queryOne("customers", "_local_id=? OR id=?", [
        sale.customer_id,
        sale.customer_id,
      ]);
      customerName = (cust as any)?.name ?? "Walk-in";
    }

    const html = `
      <html>
        <head>
          <style>
            body { font-family: 'Helvetica', sans-serif; padding: 20px; }
            table { width: 100%; border-collapse: collapse; margin-top: 20px; }
            th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
            .right { text-align: right; }
          </style>
        </head>
        <body>
          <h2>${escapeInvoiceHtml(clinic?.name ?? "Medical Store")}</h2>
          <p>${escapeInvoiceHtml(clinic?.address || "")}<br/>GSTIN: ${escapeInvoiceHtml(clinic?.gstin || "N/A")}<br/>DL No: ${escapeInvoiceHtml(clinic?.drug_licence_number || "N/A")}</p>
          <hr />
          <h3>Invoice #${escapeInvoiceHtml(sale.invoice_number)}</h3>
          <p>Date: ${escapeInvoiceHtml(sale.created_at)}<br/>
             Customer: ${escapeInvoiceHtml(customerName)}</p>
          <table>
             <tr><th>Item</th><th>Batch/Exp</th><th>Qty</th><th>MRP</th><th>Total</th></tr>
             ${(saleItems as any[])
               .map(
                 (i) => `
                <tr>
                  <td>${escapeInvoiceHtml(i.medicines?.name ?? "")}</td>
                  <td>${escapeInvoiceHtml(i.medicine_batches?.batch_number ?? "")} / ${escapeInvoiceHtml(i.medicine_batches?.expiry_date ?? "")}</td>
                  <td>${escapeInvoiceHtml(i.quantity)}</td>
                  <td>${escapeInvoiceHtml(i.mrp)}</td>
                  <td class="right">${escapeInvoiceHtml(i.total)}</td>
                </tr>
             `,
               )
               .join("")}
             <tr><th colspan="4" class="right">Subtotal</th><th class="right">${escapeInvoiceHtml(sale.subtotal)}</th></tr>
             <tr><th colspan="4" class="right">Discount</th><th class="right">${escapeInvoiceHtml(sale.discount)}</th></tr>
             <tr><th colspan="4" class="right">GST</th><th class="right">${escapeInvoiceHtml(sale.gst_amount)}</th></tr>
             <tr><th colspan="4" class="right"><strong>Grand Total</strong></th><th class="right"><strong>${escapeInvoiceHtml(sale.net_amount)}</strong></th></tr>
          </table>
          <p style="margin-top:20px; font-size:12px;">${escapeInvoiceHtml(clinic?.invoice_footer || "")}</p>
        </body>
      </html>
    `;

    res.json({
      data: { html, sale: { ...sale, sale_items: saleItems }, clinic },
    });
  } catch (err) {
    next(err);
  }
});

export default salesRouter;
