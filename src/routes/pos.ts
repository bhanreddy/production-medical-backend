import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { POSSessionService } from '../services/posSession';
import { POSSearchService } from '../services/posSearch';
import { POSCartService } from '../services/posCart';
import { ParkedSalesService } from '../services/parkedSales';
import { SupervisorAuthService } from '../services/supervisorAuth';
import { ReturnsEngine } from '../services/returnsEngine';
import { DocumentNumberingService } from '../services/documentNumbering';
import { InventoryPositionService } from '../services/inventoryPosition';
import { CommercialEngine } from '../services/commercial/commercialEngine';
import { CouponEngine } from '../services/commercial/couponEngine';
import { LoyaltyEngine } from '../services/commercial/loyaltyEngine';
import { PromotionEngine } from '../services/commercial/promotionEngine';
import { Money } from '../lib/money';
import { PrescriptionService } from '../services/prescription/prescriptionService';
import { DispensingEngine } from '../services/prescription/dispensingEngine';
import { localDb } from '../local-db';
import { localMutate } from '../lib/localMutate';
import { v4 as uuidv4 } from 'uuid';
import { AppError } from '../lib/appError';

export const posRouter = Router();

// ── 1. GET /api/pos/session ──────────────────────────────────────────────────
posRouter.get('/session', requireAuth, async (req, res, next) => {
  try {
    const session = POSSessionService.resolveSession({
      userId: req.user!.id,
      clinicId: req.user!.clinic_id,
      requestedStoreId: (req.headers['x-store-id'] as string) || (req.query.store_id as string) || null,
      requestedCounterId: (req.headers['x-counter-id'] as string) || (req.query.counter_id as string) || null,
      requestedTerminalId: (req.headers['x-terminal-id'] as string) || (req.query.terminal_id as string) || null,
      deviceUuid: (req.headers['x-device-uuid'] as string) || null,
    });
    res.json({ data: session });
  } catch (err) {
    next(err);
  }
});

// ── 2. GET /api/pos/search ───────────────────────────────────────────────────
posRouter.get('/search', requireAuth, async (req, res, next) => {
  try {
    const session = POSSessionService.resolveSession({
      userId: req.user!.id,
      clinicId: req.user!.clinic_id,
      requestedStoreId: (req.headers['x-store-id'] as string) || (req.query.store_id as string) || null,
    });

    const query = (req.query.q as string) || '';
    const barcode = (req.query.barcode as string) || '';
    const limit = Math.max(1, Math.min(parseInt(req.query.limit as string) || 25, 100));

    const data = POSSearchService.search({
      query,
      barcode,
      organizationId: session.organizationId,
      storeId: session.storeId,
      limit,
    });

    res.json(data);
  } catch (err) {
    next(err);
  }
});

// ── 3. POST /api/pos/quote ───────────────────────────────────────────────────
posRouter.post('/quote', requireAuth, async (req, res, next) => {
  try {
    const session = POSSessionService.resolveSession({
      userId: req.user!.id,
      clinicId: req.user!.clinic_id,
      requestedStoreId: req.body.store_id || (req.headers['x-store-id'] as string) || null,
      requestedCounterId: req.body.counter_id || (req.headers['x-counter-id'] as string) || null,
      requestedTerminalId: req.body.terminal_id || (req.headers['x-terminal-id'] as string) || null,
    });

    const {
      items,
      customer_id,
      coupon_code,
      redeem_loyalty_credits,
      bill_discount,
      paid_amount,
      is_interstate,
      is_offline,
    } = req.body;

    const quote = POSCartService.generateQuote({
      items: items || [],
      organizationId: session.organizationId,
      storeId: session.storeId,
      counterId: session.counterId,
      terminalId: session.terminalId,
      customerId: customer_id || null,
      couponCode: coupon_code || null,
      redeemLoyaltyCredits: Number(redeem_loyalty_credits || 0),
      billDiscount: Number(bill_discount || 0),
      paidAmount: Number(paid_amount || 0),
      isInterstate: Boolean(is_interstate),
      isOffline: Boolean(is_offline),
    });

    res.json({ data: quote });
  } catch (err) {
    next(err);
  }
});

// ── 4. POST /api/pos/checkout ────────────────────────────────────────────────
posRouter.post('/checkout', requireAuth, requireRole('CASHIER', 'PHARMACIST', 'OWNER', 'SUPER_ADMIN'), async (req, res, next) => {
  try {
    const idempotencyKey = (req.headers['x-idempotency-key'] as string) || req.body.idempotency_key || req.body._local_id;

    // Idempotency Check: return original sale if repeated
    if (idempotencyKey) {
      const existingSale: any = localDb
        .prepare('SELECT * FROM sales WHERE (idempotency_key = ? OR _local_id = ?) AND _deleted = 0')
        .get(idempotencyKey, idempotencyKey);

      if (existingSale) {
        const saleItems = localDb.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(existingSale.id || existingSale._local_id);
        const paymentTxs = localDb.prepare('SELECT * FROM payment_transactions WHERE sale_id = ?').all(existingSale.id || existingSale._local_id);
        const snapshot = localDb.prepare('SELECT * FROM sale_commercial_snapshots WHERE sale_id = ?').get(existingSale.id || existingSale._local_id);
        return res.json({
          data: {
            ...existingSale,
            sale_items: saleItems,
            payment_transactions: paymentTxs,
            commercial_snapshot: snapshot,
            is_idempotent_replay: true,
          },
        });
      }
    }

    const session = POSSessionService.resolveSession({
      userId: req.user!.id,
      clinicId: req.user!.clinic_id,
      requestedStoreId: req.body.store_id || (req.headers['x-store-id'] as string) || null,
      requestedCounterId: req.body.counter_id || (req.headers['x-counter-id'] as string) || null,
      requestedTerminalId: req.body.terminal_id || (req.headers['x-terminal-id'] as string) || null,
      deviceUuid: (req.headers['x-device-uuid'] as string) || null,
    });

    const {
      items,
      customer_id,
      doctor_name,
      doctor_registration_number,
      prescription_number,
      prescription_image_url,
      prescription_id,
      coupon_code,
      redeem_loyalty_credits = 0,
      bill_discount = 0,
      payments = [],
      park_id,
      is_interstate = false,
      is_offline = false,
      supervisor_auth_id,
    } = req.body;

    if (!items || items.length === 0) {
      throw new AppError(400, 'Cart is empty. Add at least one product.', 'EMPTY_CART');
    }

    // 1. Generate Authoritative Server Quote
    const quote = POSCartService.generateQuote({
      items,
      organizationId: session.organizationId,
      storeId: session.storeId,
      counterId: session.counterId,
      terminalId: session.terminalId,
      customerId: customer_id || null,
      couponCode: coupon_code || null,
      redeemLoyaltyCredits: Number(redeem_loyalty_credits || 0),
      billDiscount: Number(bill_discount || 0),
      isInterstate: Boolean(is_interstate),
      isOffline: Boolean(is_offline),
    });

    if (quote.requiresSupervisorApproval && !supervisor_auth_id) {
      throw new AppError(403, `Supervisor authorization required: ${quote.approvalReasons.join(', ')}`, 'SUPERVISOR_APPROVAL_REQUIRED');
    }

    // 1b. Prescription Gating Verification for Rx-Required Cart Items
    const rxLinksMap = new Map<string, { rxId: string; rxItemId: string }>();
    if (quote.hasPrescriptionMedication) {
      for (const line of quote.lines) {
        if (line.prescriptionRequired) {
          let matchedRx: any = null;
          let matchedItem: any = null;

          if (prescription_id) {
            matchedRx = localDb
              .prepare('SELECT * FROM prescriptions WHERE (id = ? OR _local_id = ?) AND _deleted = 0')
              .get(prescription_id, prescription_id);
            if (matchedRx) {
              matchedItem = localDb
                .prepare('SELECT * FROM prescription_items WHERE prescription_id = ? AND (matched_product_id = ? OR prescribed_name = ?) AND _deleted = 0')
                .get(matchedRx.id || matchedRx._local_id, line.medicineId, line.medicineName);
            }
          }

          if (!matchedItem && customer_id) {
            const rxRow: any = localDb
              .prepare(
                `SELECT p.id as rx_id, pi.id as rx_item_id, p.verification_status, p.status 
                 FROM prescriptions p 
                 JOIN prescription_items pi ON (p.id = pi.prescription_id OR p._local_id = pi.prescription_id)
                 WHERE p.patient_id = ? AND (pi.matched_product_id = ? OR pi.prescribed_name = ?) 
                   AND p.verification_status = 'VERIFIED' AND p._deleted = 0 AND pi._deleted = 0
                 ORDER BY p.created_at DESC LIMIT 1`
              )
              .get(customer_id, line.medicineId, line.medicineName);

            if (rxRow) {
              matchedRx = { id: rxRow.rx_id, verification_status: rxRow.verification_status };
              matchedItem = { id: rxRow.rx_item_id };
            }
          }

          if (!matchedRx || matchedRx.verification_status !== 'VERIFIED' || !matchedItem) {
            throw new AppError(
              400,
              `Verified prescription required for '${line.medicineName}'. Please upload and verify prescription before dispensing.`,
              'PRESCRIPTION_REQUIRED'
            );
          }

          rxLinksMap.set(line.medicineId, {
            rxId: matchedRx.id || matchedRx._local_id,
            rxItemId: matchedItem.id || matchedItem._local_id,
          });
        }
      }
    }

    // 2. Validate Payment Tender Totals
    let totalTenderedPaise = 0;
    const paymentTxsInput: any[] = Array.isArray(payments) && payments.length > 0
      ? payments
      : [{ tender_type: req.body.payment_mode || 'CASH', amount: quote.grandTotal }];

    for (const p of paymentTxsInput) {
      const amt = Number(p.amount || 0);
      if (amt < 0) throw new AppError(400, 'Payment amount cannot be negative', 'INVALID_PAYMENT_AMOUNT');
      totalTenderedPaise += Money.toPaise(amt);
    }

    const totalTendered = Money.toRupees(totalTenderedPaise);
    const balanceDuePaise = Math.max(0, quote.grandTotalPaise - totalTenderedPaise);
    const changeReturnedPaise = Math.max(0, totalTenderedPaise - quote.grandTotalPaise);
    const changeReturned = Money.toRupees(changeReturnedPaise);

    // If balance due > 0 and not marked as credit with customer
    if (balanceDuePaise > 0 && !customer_id && !paymentTxsInput.some(p => p.tender_type === 'CREDIT')) {
      throw new AppError(
        400,
        `Payment total (₹${totalTendered}) is less than grand total (₹${quote.grandTotal}). Anonymous credit sales are prohibited.`,
        'INCOMPLETE_PAYMENT'
      );
    }

    // 3. Atomic Database Transaction Execution
    const executeCheckoutTx = localDb.transaction(() => {
      const saleId = uuidv4();
      const invoiceNumber = DocumentNumberingService.generate({
        organizationId: session.organizationId,
        storeId: session.storeId,
        documentType: 'SALE_INVOICE',
      });

      // Insert Sale Master
      const saleRecord = localMutate({
        table: 'sales',
        operation: 'INSERT',
        data: {
          id: saleId,
          _local_id: saleId,
          organization_id: session.organizationId,
          store_id: session.storeId,
          counter_id: session.counterId,
          terminal_id: session.terminalId,
          clinic_id: req.user!.clinic_id || 'default-clinic',
          customer_id: customer_id || null,
          invoice_number: invoiceNumber,
          doctor_name: doctor_name || null,
          doctor_registration_number: doctor_registration_number || null,
          prescription_number: prescription_number || null,
          prescription_image_url: prescription_image_url || null,
          prescription_required: quote.hasPrescriptionMedication ? 1 : 0,
          idempotency_key: idempotencyKey || null,
          subtotal: quote.subtotal,
          discount: quote.totalDiscount,
          gst_amount: quote.totalGst,
          net_amount: quote.grandTotal,
          grand_total: quote.grandTotal,
          paid_amount: Money.toRupees(Math.min(totalTenderedPaise, quote.grandTotalPaise)),
          balance_due: Money.toRupees(balanceDuePaise),
          payment_mode: paymentTxsInput.length === 1 ? paymentTxsInput[0].tender_type.toLowerCase() : 'mixed',
          payment_status: balanceDuePaise === 0 ? 'paid' : (totalTenderedPaise > 0 ? 'partial' : 'credit'),
          served_by: session.userId,
        },
      });

      // Insert Sale Items, Batch Allocations, Stock Ledger & Deduct Positions
      const insertedItems: any[] = [];
      const insertedAllocations: any[] = [];

      for (const line of quote.lines) {
        const saleItemId = uuidv4();
        const primaryBatchId = line.batchAllocations[0]?.batchId || null;

        const saleItem = localMutate({
          table: 'sale_items',
          operation: 'INSERT',
          data: {
            id: saleItemId,
            _local_id: saleItemId,
            organization_id: session.organizationId,
            store_id: session.storeId,
            clinic_id: req.user!.clinic_id || 'default-clinic',
            sale_id: saleId,
            medicine_id: line.medicineId,
            batch_id: primaryBatchId,
            quantity: line.requestedQuantity,
            unit_type: line.unitType,
            conversion_factor: line.conversionFactor,
            base_quantity: line.baseQuantity,
            mrp_paise: line.pricing.mrpPaise,
            unit_price_paise: line.pricing.unitSellingPricePaise,
            discount_amount_paise: line.pricing.discountAmountPaise,
            taxable_amount_paise: line.pricing.taxableAmountPaise,
            tax_amount_paise: line.pricing.taxAmountPaise,
            schedule_type: line.scheduleClassification,
            is_prescription_required: line.prescriptionRequired ? 1 : 0,
            unit_price: line.pricing.unitSellingPrice,
            mrp: line.pricing.mrp,
            discount_pct: line.pricing.discountPct,
            gst_rate: line.pricing.gstRate,
            total: line.pricing.lineTotal,
          },
        });
        insertedItems.push(saleItem);

        // Process fine-grained FEFO Batch Allocations
        for (const alloc of line.batchAllocations) {
          const allocId = uuidv4();
          const allocRecord = localMutate({
            table: 'sale_batch_allocations',
            operation: 'INSERT',
            data: {
              id: allocId,
              _local_id: allocId,
              organization_id: session.organizationId,
              store_id: session.storeId,
              sale_id: saleId,
              sale_item_id: saleItemId,
              medicine_id: line.medicineId,
              batch_id: alloc.batchId,
              allocated_quantity: alloc.allocatedQuantity,
              base_quantity: alloc.allocatedQuantity,
              unit_type: line.unitType,
              unit_price: alloc.mrp,
              cost_price: alloc.purchasePrice,
            },
          });
          insertedAllocations.push(allocRecord);

          // Atomic deduction from medicine_batches
          const batchRow: any = localDb
            .prepare('SELECT quantity_remaining FROM medicine_batches WHERE id = ? OR _local_id = ?')
            .get(alloc.batchId, alloc.batchId);

          const currentStock = Number(batchRow?.quantity_remaining || 0);
          if (currentStock < alloc.allocatedQuantity) {
            throw new AppError(
              409,
              `Stock conflict during checkout: Batch ${alloc.batchNumber} has only ${currentStock} remaining, attempted to sell ${alloc.allocatedQuantity}`,
              'STOCK_CHECKOUT_RACE_CONFLICT'
            );
          }

          const newStock = currentStock - alloc.allocatedQuantity;
          localDb
            .prepare('UPDATE medicine_batches SET quantity_remaining = ? WHERE id = ? OR _local_id = ?')
            .run(newStock, alloc.batchId, alloc.batchId);

          // Deduct Inventory Position
          try {
            InventoryPositionService.adjustStock({
              organizationId: session.organizationId,
              medicineId: line.medicineId,
              batchId: alloc.batchId,
              locationType: 'STORE',
              storeId: session.storeId,
              quantityDelta: -alloc.allocatedQuantity,
            });
          } catch {
            InventoryPositionService.getOrCreatePosition({
              organizationId: session.organizationId,
              medicineId: line.medicineId,
              batchId: alloc.batchId,
              locationType: 'STORE',
              storeId: session.storeId,
              initialStock: newStock,
            });
          }

          // Write Stock Ledger
          localMutate({
            table: 'stock_ledger',
            operation: 'INSERT',
            data: {
              id: uuidv4(),
              organization_id: session.organizationId,
              store_id: session.storeId,
              counter_id: session.counterId,
              terminal_id: session.terminalId,
              clinic_id: req.user!.clinic_id || 'default-clinic',
              medicine_id: line.medicineId,
              batch_id: alloc.batchId,
              movement_type: 'SALE',
              quantity_delta: -alloc.allocatedQuantity,
              balance_after: newStock,
              reference_id: saleId,
              performed_by: session.userId,
            },
          });

          // Record Dispensing Event if Rx-Required
          if (line.prescriptionRequired && rxLinksMap.has(line.medicineId)) {
            const rxInfo = rxLinksMap.get(line.medicineId)!;
            DispensingEngine.recordDispensing({
              organizationId: session.organizationId,
              storeId: session.storeId,
              terminalId: session.terminalId,
              prescriptionId: rxInfo.rxId,
              prescriptionItemId: rxInfo.rxItemId,
              saleId,
              saleItemId,
              productId: line.medicineId,
              batchId: alloc.batchId,
              quantityDispensed: alloc.allocatedQuantity,
              dispensedBy: session.userId,
            });
          }
        }
      }

      // Process Payment Transactions
      const insertedPayments: any[] = [];
      for (const p of paymentTxsInput) {
        const txId = uuidv4();
        const tenderType = (p.tender_type || 'CASH').toUpperCase();
        const amt = Number(p.amount || 0);
        const pRecord = localMutate({
          table: 'payment_transactions',
          operation: 'INSERT',
          data: {
            id: txId,
            _local_id: txId,
            organization_id: session.organizationId,
            store_id: session.storeId,
            terminal_id: session.terminalId,
            sale_id: saleId,
            tender_type: tenderType,
            amount: amt,
            amount_paise: Money.toPaise(amt),
            reference_number: p.reference_number || null,
            status: 'COMPLETED',
            provider: p.provider || 'MANUAL_CONFIRMED',
            change_returned_paise: tenderType === 'CASH' ? changeReturnedPaise : 0,
          },
        });
        insertedPayments.push(pRecord);
      }

      // Insert Authoritative Commercial Snapshot
      const snapshotId = uuidv4();
      const commercialSnapshot = localMutate({
        table: 'sale_commercial_snapshots',
        operation: 'INSERT',
        data: {
          id: snapshotId,
          _local_id: snapshotId,
          organization_id: session.organizationId,
          store_id: session.storeId,
          sale_id: saleId,
          mrp_total_paise: quote.mrpTotalPaise,
          base_total_paise: quote.basePriceTotalPaise,
          promo_discount_paise: quote.promotionDiscountPaise,
          coupon_discount_paise: quote.couponDiscountPaise,
          member_discount_paise: quote.membershipDiscountPaise,
          manual_discount_paise: quote.manualDiscountPaise,
          loyalty_redeemed_paise: quote.loyaltyRedeemedPaise,
          loyalty_earned_credits: quote.loyaltyCreditsEarnable,
          total_savings_paise: quote.totalSavingsPaise,
          gross_margin_paise: quote.overallGrossMarginPaise,
          gross_margin_pct: quote.overallGrossMarginPct,
          applied_rules_json: JSON.stringify({
            appliedPromotions: quote.appliedPromotions,
            couponValidation: quote.couponValidation,
            customerMembership: quote.customerMembership,
            customerGroupName: quote.customerGroupName,
          }),
        },
      });

      // Record Applied Promotions
      if (quote.appliedPromotions && quote.appliedPromotions.length > 0) {
        PromotionEngine.recordApplications({
          organizationId: session.organizationId,
          storeId: session.storeId,
          saleId,
          applications: quote.appliedPromotions,
        });
      }

      // Atomically Consume Coupon
      if (quote.couponValidation?.isValid && quote.couponValidation.coupon) {
        const cpnId = quote.couponValidation.coupon.id || quote.couponValidation.coupon._local_id!;
        CouponEngine.redeemCoupon({
          organizationId: session.organizationId,
          couponId: cpnId,
          customerId: customer_id || null,
          saleId,
          discountAmountPaise: quote.couponDiscountPaise,
        });
      }

      // Record Loyalty Points Redemption
      if (quote.loyaltyCreditsRedeemed > 0 && customer_id) {
        LoyaltyEngine.recordTransaction({
          organizationId: session.organizationId,
          customerId: customer_id,
          transactionType: 'REDEEM',
          credits: -quote.loyaltyCreditsRedeemed,
          monetaryValuePaise: quote.loyaltyRedeemedPaise,
          saleId,
          notes: `Redemption of ${quote.loyaltyCreditsRedeemed} credits on sale invoice #${invoiceNumber}`,
          idempotencyKey: `redeem_${saleId}`,
        });
      }

      // Update Customer Receivables if credit balance remains
      if (customer_id && balanceDuePaise > 0) {
        localDb
          .prepare('UPDATE customers SET outstanding_balance = outstanding_balance + ? WHERE id = ? OR _local_id = ?')
          .run(Money.toRupees(balanceDuePaise), customer_id, customer_id);
      }

      // Complete parked sale if resumed from hold
      if (park_id) {
        localMutate({
          table: 'parked_sales',
          operation: 'UPDATE',
          data: {
            _local_id: park_id,
            status: 'COMPLETED',
          },
        });
      }

      return {
        sale: saleRecord,
        items: insertedItems,
        batch_allocations: insertedAllocations,
        payment_transactions: insertedPayments,
        commercial_snapshot: commercialSnapshot,
        change_returned: changeReturned,
        balance_due: Money.toRupees(balanceDuePaise),
      };
    });

    const result = executeCheckoutTx();

    // 4. Post-sale loyalty credit earning (idempotent)
    if (customer_id && quote.loyaltyCreditsEarnable > 0) {
      try {
        LoyaltyEngine.recordTransaction({
          organizationId: session.organizationId,
          customerId: customer_id,
          transactionType: 'EARN',
          credits: quote.loyaltyCreditsEarnable,
          monetaryValuePaise: quote.grandTotalPaise,
          saleId: result.sale.id || result.sale._local_id,
          notes: `Earned ${quote.loyaltyCreditsEarnable} credits on sale #${result.sale.invoice_number}`,
          idempotencyKey: `earn_${result.sale.id || result.sale._local_id}`,
        });
      } catch (earnErr) {
        console.warn('Loyalty earning record warning:', earnErr);
      }
    }

    res.status(201).json({ data: result });
  } catch (err) {
    console.error('CHECKOUT_ERR:', err);
    next(err);
  }
});

// ── 5. POST /api/pos/park ────────────────────────────────────────────────────
posRouter.post('/park', requireAuth, async (req, res, next) => {
  try {
    const session = POSSessionService.resolveSession({
      userId: req.user!.id,
      clinicId: req.user!.clinic_id,
      requestedStoreId: req.body.store_id || (req.headers['x-store-id'] as string) || null,
      requestedCounterId: req.body.counter_id || (req.headers['x-counter-id'] as string) || null,
      requestedTerminalId: req.body.terminal_id || (req.headers['x-terminal-id'] as string) || null,
    });

    const { cart, customer, totals, notes, expires_in_minutes } = req.body;

    const parked = ParkedSalesService.parkSale({
      organizationId: session.organizationId,
      storeId: session.storeId,
      counterId: session.counterId,
      terminalId: session.terminalId,
      cashierId: session.userId,
      customerId: customer?.id || null,
      cartSnapshot: cart || [],
      customerSnapshot: customer || {},
      totalsSnapshot: totals || {},
      notes: notes || '',
      expiresInMinutes: expires_in_minutes,
    });

    res.status(201).json({ data: parked });
  } catch (err) {
    next(err);
  }
});

// ── 6. GET /api/pos/parked ───────────────────────────────────────────────────
posRouter.get('/parked', requireAuth, async (req, res, next) => {
  try {
    const session = POSSessionService.resolveSession({
      userId: req.user!.id,
      clinicId: req.user!.clinic_id,
      requestedStoreId: (req.headers['x-store-id'] as string) || (req.query.store_id as string) || null,
    });

    const list = ParkedSalesService.listParked(session.storeId);
    res.json({ data: list });
  } catch (err) {
    next(err);
  }
});

// ── 7. POST /api/pos/parked/:id/resume ───────────────────────────────────────
posRouter.post('/parked/:id/resume', requireAuth, async (req, res, next) => {
  try {
    const session = POSSessionService.resolveSession({
      userId: req.user!.id,
      clinicId: req.user!.clinic_id,
      requestedStoreId: (req.headers['x-store-id'] as string) || (req.query.store_id as string) || null,
      requestedCounterId: (req.headers['x-counter-id'] as string) || null,
      requestedTerminalId: (req.headers['x-terminal-id'] as string) || null,
    });

    const resumed = ParkedSalesService.resumeParked({
      parkedId: req.params.id,
      storeId: session.storeId,
      resumingCounterId: session.counterId,
      resumingTerminalId: session.terminalId,
      resumingUserId: session.userId,
    });

    res.json({ data: resumed });
  } catch (err) {
    next(err);
  }
});

// ── 8. POST /api/pos/parked/:id/cancel ───────────────────────────────────────
posRouter.post('/parked/:id/cancel', requireAuth, async (req, res, next) => {
  try {
    const session = POSSessionService.resolveSession({
      userId: req.user!.id,
      clinicId: req.user!.clinic_id,
      requestedStoreId: (req.headers['x-store-id'] as string) || (req.query.store_id as string) || null,
    });

    const result = ParkedSalesService.cancelParked(req.params.id, session.storeId);
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
});

// ── 9. POST /api/pos/returns/quote ──────────────────────────────────────────
posRouter.post('/returns/quote', requireAuth, async (req, res, next) => {
  try {
    const { original_sale_id, items } = req.body;
    const quote = ReturnsEngine.quoteReturn({
      originalSaleId: original_sale_id,
      items: items || [],
    });
    res.json({ data: quote });
  } catch (err) {
    next(err);
  }
});

// ── 10. POST /api/pos/returns ───────────────────────────────────────────────
posRouter.post('/returns', requireAuth, requireRole('PHARMACIST', 'OWNER', 'SUPER_ADMIN'), async (req, res, next) => {
  try {
    const session = POSSessionService.resolveSession({
      userId: req.user!.id,
      clinicId: req.user!.clinic_id,
      requestedStoreId: req.body.store_id || (req.headers['x-store-id'] as string) || null,
      requestedCounterId: req.body.counter_id || (req.headers['x-counter-id'] as string) || null,
      requestedTerminalId: req.body.terminal_id || (req.headers['x-terminal-id'] as string) || null,
    });

    const { original_sale_id, items, refund_method, refund_reference, supervisor_auth_id } = req.body;

    const result = ReturnsEngine.processReturn({
      originalSaleId: original_sale_id,
      items: items || [],
      refundMethod: refund_method || 'CASH',
      refundReference: refund_reference,
      organizationId: session.organizationId,
      storeId: session.storeId,
      counterId: session.counterId,
      terminalId: session.terminalId,
      performedBy: session.userId,
      supervisorAuthId: supervisor_auth_id,
    });

    res.status(201).json({ data: result });
  } catch (err) {
    next(err);
  }
});

// ── 11. POST /api/pos/authorize ─────────────────────────────────────────────
posRouter.post('/authorize', requireAuth, async (req, res, next) => {
  try {
    const session = POSSessionService.resolveSession({
      userId: req.user!.id,
      clinicId: req.user!.clinic_id,
      requestedStoreId: req.body.store_id || (req.headers['x-store-id'] as string) || null,
      requestedCounterId: req.body.counter_id || (req.headers['x-counter-id'] as string) || null,
      requestedTerminalId: req.body.terminal_id || (req.headers['x-terminal-id'] as string) || null,
    });

    const { action_type, supervisor_pin, supervisor_user_id, entity_type, entity_id, reason, old_value, new_value } = req.body;

    const authResult = SupervisorAuthService.authorize({
      organizationId: session.organizationId,
      storeId: session.storeId,
      counterId: session.counterId,
      terminalId: session.terminalId,
      actionType: action_type,
      requestingUserId: session.userId,
      supervisorPin: supervisor_pin,
      supervisorUserId: supervisor_user_id,
      entityType: entity_type,
      entityId: entity_id,
      reason: reason || 'Operator requested override',
      oldValue: old_value,
      newValue: new_value,
    });

    res.json({ data: authResult });
  } catch (err) {
    next(err);
  }
});
