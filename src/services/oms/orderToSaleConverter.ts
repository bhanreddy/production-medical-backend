// orderToSaleConverter.ts — Atomic Order to Sale Conversion Pipeline
import { localDb } from '../../local-db';
import { localMutate } from '../../lib/localMutate';
import { v4 as uuidv4 } from 'uuid';
import { DocumentNumberingService } from '../documentNumbering';
import { InventoryPositionService } from '../inventoryPosition';
import { InventoryReservationService } from '../inventory/inventoryReservationService';
import { LoyaltyEngine } from '../commercial/loyaltyEngine';
import { DispensingEngine } from '../prescription/dispensingEngine';
import { OrderEventService } from './orderEventService';
import { Money } from '../../lib/money';
import { AppError } from '../../lib/appError';

export interface ConvertOrderToSaleParams {
  orderId: string;
  organizationId: string;
  storeId?: string | null;
  counterId?: string | null;
  terminalId?: string | null;
  servedByUserId: string;
  payments?: Array<{
    tender_type: string;
    amount: number;
    reference_number?: string;
  }>;
}

export class OrderToSaleConverter {
  /**
   * Convert fulfilled order into final canonical Sale
   */
  static convertToSale(params: ConvertOrderToSaleParams): { saleId: string; invoiceNumber: string; sale: any } {
    const {
      orderId,
      organizationId,
      storeId = null,
      counterId = null,
      terminalId = null,
      servedByUserId,
      payments = [],
    } = params;

    const order: any = localDb
      .prepare('SELECT * FROM orders WHERE (id = ? OR _local_id = ?) AND organization_id = ?')
      .get(orderId, orderId, organizationId);

    if (!order) {
      throw new AppError(404, 'Order not found', 'ORDER_NOT_FOUND');
    }

    // Idempotency: If order already converted to sale, return existing sale
    if (order.sale_id) {
      const existingSale: any = localDb
        .prepare('SELECT * FROM sales WHERE id = ? OR _local_id = ?')
        .get(order.sale_id, order.sale_id);
      if (existingSale) {
        return {
          saleId: existingSale.id,
          invoiceNumber: existingSale.invoice_number,
          sale: existingSale,
        };
      }
    }

    if (order.status === 'CANCELLED') {
      throw new AppError(400, 'Cannot convert cancelled order to sale', 'ORDER_CANCELLED');
    }

    const effectiveStoreId = storeId || order.fulfilment_store_id || order.requested_store_id;
    if (!effectiveStoreId) {
      throw new AppError(400, 'Store ID required for sale conversion', 'STORE_REQUIRED');
    }

    const orderItems: any[] = localDb
      .prepare("SELECT * FROM order_items WHERE order_id = ? AND _deleted = 0 AND status != 'CANCELLED'")
      .all(order.id);

    if (orderItems.length === 0) {
      throw new AppError(400, 'No active items in order to convert to sale', 'EMPTY_ORDER_ITEMS');
    }

    // Retrieve fulfilment batch allocations
    const fulfilmentItems: any[] = localDb
      .prepare('SELECT * FROM order_fulfilment_items WHERE order_id = ? AND _deleted = 0')
      .all(order.id);

    let saleResult: any = null;

    // Atomic Checkout Transaction
    const executeConversionTx = localDb.transaction(() => {
      const saleId = uuidv4();
      const invoiceNumber = DocumentNumberingService.generate({
        organizationId,
        storeId: effectiveStoreId,
        documentType: 'SALE_INVOICE',
      });

      const nowIso = new Date().toISOString();
      const grandTotal = Number(order.grand_total || 0);
      const grandTotalPaise = Number(order.grand_total_paise || Math.round(grandTotal * 100));

      // Resolve payments: Check existing payment_transactions linked to order or passed payments
      const existingPaymentTxs: any[] = localDb
        .prepare("SELECT * FROM payment_transactions WHERE order_id = ? AND status = 'COMPLETED'")
        .all(order.id);

      let totalPaidPaise = 0;
      for (const p of existingPaymentTxs) {
        totalPaidPaise += Number(p.amount_paise || Math.round(p.amount * 100));
      }

      // If additional counter payments provided
      if (payments && payments.length > 0) {
        for (const p of payments) {
          const amtPaise = Money.toPaise(Number(p.amount || 0));
          totalPaidPaise += amtPaise;

          const pTxId = uuidv4();
          localMutate({
            table: 'payment_transactions',
            operation: 'INSERT',
            data: {
              id: pTxId,
              _local_id: pTxId,
              organization_id: organizationId,
              store_id: effectiveStoreId,
              terminal_id: terminalId,
              sale_id: saleId,
              order_id: order.id,
              tender_type: (p.tender_type || 'CASH').toUpperCase(),
              amount: Money.toRupees(amtPaise),
              amount_paise: amtPaise,
              currency: 'INR',
              reference_number: p.reference_number || null,
              status: 'COMPLETED',
              created_at: nowIso,
            },
          });
        }
      } else if (existingPaymentTxs.length > 0) {
        // Link existing payment transactions to the new sale_id
        localDb
          .prepare('UPDATE payment_transactions SET sale_id = ?, updated_at = ?, _updated_at = ? WHERE order_id = ?')
          .run(saleId, nowIso, nowIso, order.id);
      } else {
        // Default to CASH payment at counter
        const pTxId = uuidv4();
        totalPaidPaise = grandTotalPaise;
        localMutate({
          table: 'payment_transactions',
          operation: 'INSERT',
          data: {
            id: pTxId,
            _local_id: pTxId,
            organization_id: organizationId,
            store_id: effectiveStoreId,
            terminal_id: terminalId,
            sale_id: saleId,
            order_id: order.id,
            tender_type: 'CASH',
            amount: grandTotal,
            amount_paise: grandTotalPaise,
            currency: 'INR',
            status: 'COMPLETED',
            created_at: nowIso,
          },
        });
      }

      const balanceDuePaise = Math.max(0, grandTotalPaise - totalPaidPaise);

      // Insert Sale Master
      const saleRecord = localMutate({
        table: 'sales',
        operation: 'INSERT',
        data: {
          id: saleId,
          _local_id: saleId,
          organization_id: organizationId,
          store_id: effectiveStoreId,
          counter_id: counterId,
          terminal_id: terminalId,
          customer_id: order.customer_id,
          order_id: order.id,
          invoice_number: invoiceNumber,
          prescription_required: order.prescription_status !== 'NOT_REQUIRED' ? 1 : 0,
          subtotal: Number(order.subtotal || 0),
          discount: Number(order.discount_total || 0),
          gst_amount: Number(order.tax_total || 0),
          net_amount: grandTotal,
          grand_total: grandTotal,
          paid_amount: Money.toRupees(Math.min(totalPaidPaise, grandTotalPaise)),
          balance_due: Money.toRupees(balanceDuePaise),
          payment_mode: existingPaymentTxs.length > 0 ? 'prepaid' : 'cash',
          payment_status: balanceDuePaise === 0 ? 'paid' : 'partial',
          status: 'COMPLETED',
          served_by: servedByUserId,
          created_at: nowIso,
        },
      });

      // Insert Sale Items and Deduct Inventory
      for (const item of orderItems) {
        const saleItemId = uuidv4();
        const allocsForItem = fulfilmentItems.filter(fi => fi.order_item_id === item.id);
        const primaryBatchId = allocsForItem[0]?.batch_id || null;

        const qty = Number(item.fulfilled_quantity || item.requested_quantity || 1);

        localMutate({
          table: 'sale_items',
          operation: 'INSERT',
          data: {
            id: saleItemId,
            _local_id: saleItemId,
            organization_id: organizationId,
            store_id: effectiveStoreId,
            sale_id: saleId,
            medicine_id: item.medicine_id,
            batch_id: primaryBatchId,
            quantity: qty,
            unit_type: item.requested_unit || 'STRIP',
            conversion_factor: Number(item.conversion_factor || 1.0),
            base_quantity: Number(item.base_quantity || qty),
            mrp_paise: Number(item.mrp_paise || 0),
            unit_price_paise: Number(item.unit_price_paise || 0),
            discount_amount_paise: Number(item.discount_amount_paise || 0),
            taxable_amount_paise: Number(item.taxable_amount_paise || 0),
            tax_amount_paise: Number(item.tax_amount_paise || 0),
            unit_price: Number(item.unit_price_paise || 0) / 100,
            mrp: Number(item.mrp_paise || 0) / 100,
            gst_rate: Number(item.gst_rate || 12.0),
            total: Number(item.line_total_paise || 0) / 100,
            is_prescription_required: item.prescription_required ? 1 : 0,
            created_at: nowIso,
          },
        });

        // Deduct inventory & Consume Reservations for each allocated batch
        for (const alloc of allocsForItem) {
          const allocQty = Number(alloc.quantity_picked || alloc.quantity_allocated || qty);
          const targetBatchId = alloc.batch_id || primaryBatchId;

          if (targetBatchId) {
            // Deduct physical batch stock
            const batchRow: any = localDb
              .prepare('SELECT quantity_remaining, mrp, purchase_price FROM medicine_batches WHERE id = ? OR _local_id = ?')
              .get(targetBatchId, targetBatchId);

            if (batchRow) {
              const newRemaining = Math.max(0, Number(batchRow.quantity_remaining || 0) - allocQty);
              localDb
                .prepare('UPDATE medicine_batches SET quantity_remaining = ? WHERE id = ? OR _local_id = ?')
                .run(newRemaining, targetBatchId, targetBatchId);

              // Record sale batch allocation
              const allocId = uuidv4();
              localMutate({
                table: 'sale_batch_allocations',
                operation: 'INSERT',
                data: {
                  id: allocId,
                  _local_id: allocId,
                  organization_id: organizationId,
                  store_id: effectiveStoreId,
                  sale_id: saleId,
                  sale_item_id: saleItemId,
                  medicine_id: item.medicine_id,
                  batch_id: targetBatchId,
                  allocated_quantity: allocQty,
                  base_quantity: allocQty,
                  unit_type: item.requested_unit || 'STRIP',
                  unit_price: batchRow.mrp || 0,
                  cost_price: batchRow.purchase_price || 0,
                  created_at: nowIso,
                },
              });
            }

            // Consume Inventory Reservation
            if (alloc.reservation_id) {
              InventoryReservationService.consumeReservation(alloc.reservation_id);
            }

            // Deduct store Inventory Position
            try {
              InventoryPositionService.adjustStock({
                organizationId,
                medicineId: item.medicine_id,
                batchId: targetBatchId,
                locationType: 'STORE',
                storeId: effectiveStoreId,
                quantityDelta: -allocQty,
              });
            } catch {
              // fallback
            }

            // Write Immutable Stock Ledger entry
            const ledgerId = uuidv4();
            localMutate({
              table: 'stock_ledger',
              operation: 'INSERT',
              data: {
                id: ledgerId,
                _local_id: ledgerId,
                organization_id: organizationId,
                store_id: effectiveStoreId,
                location_type: 'STORE',
                medicine_id: item.medicine_id,
                batch_id: targetBatchId,
                movement_type: 'SALE',
                quantity_delta: -allocQty,
                unit_cost_paise: Number(item.unit_price_paise || 0),
                reference_type: 'ORDER_CONVERTED_SALE',
                reference_id: saleId,
                notes: `Sale completed from Order #${order.order_number}`,
                created_by: servedByUserId,
                created_at: nowIso,
              },
            });

            // Prescription Dispensing Event
            if (item.prescription_id || item.prescription_item_id) {
              const dispEventId = uuidv4();
              localMutate({
                table: 'dispensing_events',
                operation: 'INSERT',
                data: {
                  id: dispEventId,
                  _local_id: dispEventId,
                  organization_id: organizationId,
                  store_id: effectiveStoreId,
                  terminal_id: terminalId,
                  prescription_id: item.prescription_id || 'UNKNOWN_RX',
                  prescription_item_id: item.prescription_item_id || 'UNKNOWN_RX_ITEM',
                  sale_id: saleId,
                  sale_item_id: saleItemId,
                  product_id: item.medicine_id,
                  batch_id: targetBatchId,
                  quantity_dispensed: allocQty,
                  base_unit_quantity: allocQty,
                  dispensed_by: servedByUserId,
                  dispensed_at: nowIso,
                  created_at: nowIso,
                },
              });
            }
          }
        }
      }

      // Settle Loyalty Earning
      if (order.customer_id) {
        try {
          const earnCalc = LoyaltyEngine.calculateEarning({
            organizationId,
            customerId: order.customer_id,
            eligibleSpendPaise: grandTotalPaise,
          });

          if (earnCalc.creditsEarned > 0) {
            LoyaltyEngine.recordTransaction({
              organizationId,
              customerId: order.customer_id,
              transactionType: 'EARN',
              credits: earnCalc.creditsEarned,
              monetaryValuePaise: grandTotalPaise,
              saleId,
              notes: `Loyalty earned on Sale #${invoiceNumber}`,
            });
          }
        } catch {
          // non-blocking
        }
      }

      // Update Order Status to COMPLETED and link sale_id
      localMutate({
        table: 'orders',
        operation: 'UPDATE',
        data: {
          id: order.id,
          sale_id: saleId,
          status: 'COMPLETED',
          fulfilment_status: 'HANDED_OVER',
          payment_status: 'PAID',
          completed_at: nowIso,
          updated_at: nowIso,
        },
      });

      localDb
        .prepare("UPDATE order_fulfilments SET status = 'HANDED_OVER', completed_at = ?, updated_at = ?, _updated_at = ? WHERE order_id = ?")
        .run(nowIso, nowIso, nowIso, order.id);

      OrderEventService.logEvent({
        orderId: order.id,
        organizationId,
        eventType: 'COMPLETED',
        fromStatus: order.status,
        toStatus: 'COMPLETED',
        actorId: servedByUserId,
        details: {
          saleId,
          invoiceNumber,
          grandTotal,
        },
        notes: `Order #${order.order_number} completed and converted to Invoice #${invoiceNumber}`,
      });

      saleResult = { saleId, invoiceNumber, sale: saleRecord };
    });

    executeConversionTx();
    return saleResult;
  }
}
