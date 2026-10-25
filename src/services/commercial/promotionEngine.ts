import { localDb } from '../../local-db';
import { localMutate } from '../../lib/localMutate';
import { Money } from '../../lib/money';
import { v4 as uuidv4 } from 'uuid';
import {
  Promotion,
  PromotionConfig,
  PromotionTarget,
  CommercialLineInput,
} from '../../domain/commercialTypes';

export interface EvaluatePromotionsContext {
  organizationId: string;
  storeId?: string | null;
  regionId?: string | null;
  customerId?: string | null;
  customerGroupId?: string | null;
  cartLines: Array<{
    medicineId: string;
    medicineName: string;
    category?: string;
    brandName?: string;
    manufacturer?: string;
    quantity: number;
    unitPricePaise: number;
    mrpPaise: number;
    basePricePaise: number;
    unitType: string;
    conversionFactor: number;
  }>;
  asOfDate?: Date;
  isOffline?: boolean;
}

export interface EvaluatedPromotionOutcome {
  promotionId: string;
  promotionCode: string;
  promotionName: string;
  promotionType: string;
  stackability: string;
  priority: number;
  totalDiscountPaise: number;
  lineDiscounts: Map<string, number>; // medicineId -> discountPaise
  freeItems: Array<{ medicineId: string; quantity: number }>;
  isApplicable: boolean;
  rejectionReason?: string;
}

export class PromotionEngine {
  /**
   * Evaluates all eligible promotions for a cart and returns optimal applied promotion set.
   */
  static evaluateCartPromotions(context: EvaluatePromotionsContext): {
    appliedPromotions: Array<{ id: string; code: string; name: string; discountPaise: number; freeQty: number }>;
    rejectedPromotions: Array<{ id: string; code: string; name: string; reason: string }>;
    lineDiscounts: Map<string, { discountPaise: number; promoId: string; promoCode: string; promoName: string; freeQty: number }>;
    totalPromoDiscountPaise: number;
    freeItems: Array<{ medicineId: string; quantity: number }>;
  } {
    const {
      organizationId,
      storeId,
      regionId,
      customerId,
      customerGroupId,
      cartLines,
      asOfDate = new Date(),
      isOffline = false,
    } = context;

    const lineDiscounts = new Map<string, { discountPaise: number; promoId: string; promoCode: string; promoName: string; freeQty: number }>();
    const appliedPromotions: Array<{ id: string; code: string; name: string; discountPaise: number; freeQty: number }> = [];
    const rejectedPromotions: Array<{ id: string; code: string; name: string; reason: string }> = [];
    const freeItems: Array<{ medicineId: string; quantity: number }> = [];

    if (!cartLines || cartLines.length === 0) {
      return {
        appliedPromotions: [],
        rejectedPromotions: [],
        lineDiscounts,
        totalPromoDiscountPaise: 0,
        freeItems: [],
      };
    }

    const nowIso = asOfDate.toISOString();

    // 1. Fetch active promotions for organization
    const activePromos: any[] = localDb
      .prepare(
        `SELECT * FROM promotions
         WHERE (organization_id = ?)
           AND status = 'ACTIVE' AND _deleted = 0
           AND (start_at IS NULL OR start_at <= ?)
           AND (end_at IS NULL OR end_at >= ?)
         ORDER BY priority DESC, created_at ASC`
      )
      .all(organizationId, nowIso, nowIso);

    if (activePromos.length === 0) {
      return {
        appliedPromotions: [],
        rejectedPromotions: [],
        lineDiscounts,
        totalPromoDiscountPaise: 0,
        freeItems: [],
      };
    }

    const totalCartValuePaise = cartLines.reduce((acc, l) => acc + l.basePricePaise * l.quantity, 0);

    // 2. Evaluate each promotion against targets and conditions
    const qualifiedOutcomes: EvaluatedPromotionOutcome[] = [];

    for (const pRow of activePromos) {
      const pId = pRow.id || pRow._local_id;
      const config: PromotionConfig = typeof pRow.config_json === 'string'
        ? JSON.parse(pRow.config_json || '{}')
        : (pRow.config_json || {});

      // Check offline capability
      if (isOffline && config.offline_allowed === false) {
        rejectedPromotions.push({ id: pId, code: pRow.code, name: pRow.name, reason: 'Requires online validation' });
        continue;
      }

      // Check global usage limit
      if (pRow.usage_limit != null && pRow.current_uses >= pRow.usage_limit) {
        rejectedPromotions.push({ id: pId, code: pRow.code, name: pRow.name, reason: 'Global usage limit reached' });
        continue;
      }

      // Check per-customer limit
      if (customerId && pRow.per_customer_limit != null && pRow.per_customer_limit > 0) {
        const custAppsRow: any = localDb
          .prepare(
            `SELECT COUNT(*) as count 
             FROM promotion_applications pa
             JOIN sales s ON s.id = pa.sale_id OR s._local_id = pa.sale_id
             WHERE (pa.promotion_id = ? OR pa.promotion_id = ?) AND (s.customer_id = ? OR s.customer_id = ?) AND pa._deleted = 0`
          )
          .get(pId, pId, customerId, customerId);

        if (Number(custAppsRow?.count || 0) >= pRow.per_customer_limit) {
          rejectedPromotions.push({ id: pId, code: pRow.code, name: pRow.name, reason: 'Per-customer limit reached' });
          continue;
        }
      }

      // Check min cart value
      if (pRow.min_cart_value_paise > 0 && totalCartValuePaise < pRow.min_cart_value_paise) {
        rejectedPromotions.push({ id: pId, code: pRow.code, name: pRow.name, reason: 'Minimum cart value not met' });
        continue;
      }

      // Check store/region target scoping
      const targets: any[] = localDb
        .prepare('SELECT * FROM promotion_targets WHERE (promotion_id = ? OR promotion_id = ?) AND _deleted = 0')
        .all(pId, pId);

      const storeTargets = targets.filter(t => t.target_type === 'STORE');
      if (storeTargets.length > 0 && storeId) {
        const storeMatch = storeTargets.some(t => t.target_id === storeId);
        if (!storeMatch) {
          rejectedPromotions.push({ id: pId, code: pRow.code, name: pRow.name, reason: 'Ineligible store location' });
          continue;
        }
      }

      // 3. Evaluate Promotion Rules by Type
      const outcome = this.evaluateSinglePromotion({
        promotion: pRow,
        config,
        targets,
        cartLines,
        organizationId,
        storeId,
      });

      if (outcome.isApplicable && outcome.totalDiscountPaise > 0 || outcome.freeItems.length > 0) {
        // Cap with max_discount_paise if defined
        if (pRow.max_discount_paise != null && outcome.totalDiscountPaise > pRow.max_discount_paise) {
          outcome.totalDiscountPaise = pRow.max_discount_paise;
        }
        qualifiedOutcomes.push(outcome);
      } else if (outcome.rejectionReason) {
        rejectedPromotions.push({ id: pId, code: pRow.code, name: pRow.name, reason: outcome.rejectionReason });
      }
    }

    if (qualifiedOutcomes.length === 0) {
      return {
        appliedPromotions: [],
        rejectedPromotions,
        lineDiscounts,
        totalPromoDiscountPaise: 0,
        freeItems: [],
      };
    }

    // 4. Stacking and Best Offer Resolution
    // Check if an EXCLUSIVE promotion qualifies
    const exclusivePromo = qualifiedOutcomes.find(o => o.stackability === 'EXCLUSIVE');
    let selectedOutcomes: EvaluatedPromotionOutcome[] = [];

    if (exclusivePromo) {
      // Compare exclusive promo discount against sum of stackable discounts to select BEST_CUSTOMER_PRICE
      const stackableSum = qualifiedOutcomes
        .filter(o => o.stackability !== 'EXCLUSIVE')
        .reduce((sum, o) => sum + o.totalDiscountPaise, 0);

      if (exclusivePromo.totalDiscountPaise >= stackableSum) {
        selectedOutcomes = [exclusivePromo];
      } else {
        selectedOutcomes = qualifiedOutcomes.filter(o => o.stackability !== 'EXCLUSIVE');
      }
    } else {
      selectedOutcomes = qualifiedOutcomes;
    }

    let totalPromoDiscountPaise = 0;

    for (const outcome of selectedOutcomes) {
      let appliedFreeQty = 0;
      for (const [medId, discPaise] of outcome.lineDiscounts.entries()) {
        const existing = lineDiscounts.get(medId);
        const freeQty = outcome.freeItems.find(f => f.medicineId === medId)?.quantity || 0;
        appliedFreeQty += freeQty;

        if (existing) {
          lineDiscounts.set(medId, {
            discountPaise: existing.discountPaise + discPaise,
            promoId: outcome.promotionId,
            promoCode: outcome.promotionCode,
            promoName: outcome.promotionName,
            freeQty: existing.freeQty + freeQty,
          });
        } else {
          lineDiscounts.set(medId, {
            discountPaise: discPaise,
            promoId: outcome.promotionId,
            promoCode: outcome.promotionCode,
            promoName: outcome.promotionName,
            freeQty,
          });
        }
      }

      totalPromoDiscountPaise += outcome.totalDiscountPaise;
      appliedPromotions.push({
        id: outcome.promotionId,
        code: outcome.promotionCode,
        name: outcome.promotionName,
        discountPaise: outcome.totalDiscountPaise,
        freeQty: appliedFreeQty,
      });

      freeItems.push(...outcome.freeItems);
    }

    return {
      appliedPromotions,
      rejectedPromotions,
      lineDiscounts,
      totalPromoDiscountPaise,
      freeItems,
    };
  }

  /**
   * Helper: Evaluates a single promotion type against matched cart lines
   */
  private static evaluateSinglePromotion(params: {
    promotion: any;
    config: PromotionConfig;
    targets: any[];
    cartLines: any[];
    organizationId: string;
    storeId?: string | null;
  }): EvaluatedPromotionOutcome {
    const { promotion, config, targets, cartLines, storeId } = params;
    const pId = promotion.id || promotion._local_id;
    const pType = promotion.promotion_type;

    const lineDiscounts = new Map<string, number>();
    const freeItems: Array<{ medicineId: string; quantity: number }> = [];
    let totalDiscountPaise = 0;

    // Filter matching cart lines based on product, category, brand, or manufacturer targets
    const matchingLines = cartLines.filter(line => {
      if (targets.length === 0) return true; // Store/org wide
      const productTargets = targets.filter(t => t.target_type === 'PRODUCT').map(t => t.target_id);
      const catTargets = targets.filter(t => t.target_type === 'CATEGORY').map(t => t.target_id);
      const brandTargets = targets.filter(t => t.target_type === 'BRAND').map(t => t.target_id);
      const mfgTargets = targets.filter(t => t.target_type === 'MANUFACTURER').map(t => t.target_id);

      if (productTargets.length > 0 && productTargets.includes(line.medicineId)) return true;
      if (catTargets.length > 0 && line.category && catTargets.includes(line.category)) return true;
      if (brandTargets.length > 0 && line.brandName && brandTargets.includes(line.brandName)) return true;
      if (mfgTargets.length > 0 && line.manufacturer && mfgTargets.includes(line.manufacturer)) return true;

      return targets.length === 0;
    });

    if (matchingLines.length === 0) {
      return {
        promotionId: pId,
        promotionCode: promotion.code,
        promotionName: promotion.name,
        promotionType: pType,
        stackability: promotion.stackability || 'STACKABLE',
        priority: promotion.priority ?? 10,
        totalDiscountPaise: 0,
        lineDiscounts,
        freeItems,
        isApplicable: false,
        rejectionReason: 'No eligible target products in cart',
      };
    }

    // ── 1. PERCENTAGE_DISCOUNT ───────────────────────────────────────────────
    if (pType === 'PERCENTAGE_DISCOUNT' || pType === 'CATEGORY_DISCOUNT' || pType === 'BRAND_DISCOUNT' || pType === 'MANUFACTURER_DISCOUNT') {
      const pct = Number(config.percentage_discount || 0);
      if (pct > 0) {
        for (const line of matchingLines) {
          const lineBaseTotalPaise = line.basePricePaise * line.quantity;
          const discPaise = Math.round((lineBaseTotalPaise * pct) / 100);
          lineDiscounts.set(line.medicineId, discPaise);
          totalDiscountPaise += discPaise;
        }
      }
    }

    // ── 2. FLAT_DISCOUNT ─────────────────────────────────────────────────────
    else if (pType === 'FLAT_DISCOUNT') {
      const flatPaise = Number(config.flat_discount_paise || 0);
      const eligibleTotalPaise = matchingLines.reduce((sum, l) => sum + l.basePricePaise * l.quantity, 0);

      if (flatPaise > 0 && eligibleTotalPaise >= flatPaise) {
        totalDiscountPaise = flatPaise;
        // Allocate flat discount proportionally across matching lines
        for (const line of matchingLines) {
          const lineVal = line.basePricePaise * line.quantity;
          const propDisc = Math.round((flatPaise * lineVal) / eligibleTotalPaise);
          lineDiscounts.set(line.medicineId, propDisc);
        }
      }
    }

    // ── 3. FIXED_PRICE ───────────────────────────────────────────────────────
    else if (pType === 'FIXED_PRICE') {
      const fixedPaise = Number(config.fixed_price_paise || 0);
      if (fixedPaise > 0) {
        for (const line of matchingLines) {
          if (line.basePricePaise > fixedPaise) {
            const savingsPerUnit = line.basePricePaise - fixedPaise;
            const discPaise = savingsPerUnit * line.quantity;
            lineDiscounts.set(line.medicineId, discPaise);
            totalDiscountPaise += discPaise;
          }
        }
      }
    }

    // ── 4. BUY_X_GET_Y (Same Product or Different Product) ───────────────────
    else if (pType === 'BUY_X_GET_Y') {
      const buyQty = Number(config.buy_qty || 2);
      const getFreeQty = Number(config.get_free_qty || 1);
      const rewardMedId = config.reward_medicine_id || null;

      for (const line of matchingLines) {
        if (!rewardMedId || rewardMedId === line.medicineId) {
          // Same product Buy X Get Y:
          // If customer buys 7 units on Buy 2 Get 1 Free:
          // Set size = buyQty + getFreeQty (e.g. 2 + 1 = 3)
          // sets = Math.floor(7 / 3) = 2
          // free units = 2 * 1 = 2
          // paid units = 7 - 2 = 5
          // or if customer added only buyQty (2 units), free units = 1 if inventory allows.
          const setSize = buyQty + getFreeQty;
          let freeUnits = 0;

          if (line.quantity >= setSize) {
            const fullSets = Math.floor(line.quantity / setSize);
            freeUnits = fullSets * getFreeQty;
          } else if (line.quantity >= buyQty) {
            const multiples = Math.floor(line.quantity / buyQty);
            freeUnits = multiples * getFreeQty;
          }

          if (freeUnits > 0) {
            // Check physical stock availability before giving free quantity
            const stockRow: any = localDb
              .prepare(
                `SELECT SUM(quantity_remaining) as total_stock 
                 FROM medicine_batches 
                 WHERE (medicine_id = ? OR medicine_id = ?) 
                   AND (store_id = ? OR store_id IS NULL) 
                   AND quantity_remaining > 0 AND _deleted = 0`
              )
              .get(line.medicineId, line.medicineId, storeId || null);

            const totalAvailable = Number(stockRow?.total_stock || 0);
            if (totalAvailable >= (line.quantity + (line.quantity < setSize ? freeUnits : 0))) {
              const discPaise = freeUnits * line.basePricePaise;
              lineDiscounts.set(line.medicineId, discPaise);
              totalDiscountPaise += discPaise;
              freeItems.push({ medicineId: line.medicineId, quantity: freeUnits });
            }
          }
        } else {
          // Different product reward
          if (line.quantity >= buyQty) {
            const sets = Math.floor(line.quantity / buyQty);
            const rewardQty = sets * getFreeQty;

            // Check stock of reward product
            const rewardStockRow: any = localDb
              .prepare(
                `SELECT SUM(quantity_remaining) as total_stock 
                 FROM medicine_batches 
                 WHERE (medicine_id = ? OR medicine_id = ?) 
                   AND (store_id = ? OR store_id IS NULL) 
                   AND quantity_remaining > 0 AND _deleted = 0`
              )
              .get(rewardMedId, rewardMedId, storeId || null);

            const rewardStock = Number(rewardStockRow?.total_stock || 0);
            if (rewardStock >= rewardQty) {
              freeItems.push({ medicineId: rewardMedId, quantity: rewardQty });
            }
          }
        }
      }
    }

    // ── 5. QUANTITY_SLAB ─────────────────────────────────────────────────────
    else if (pType === 'QUANTITY_SLAB') {
      const slabs = Array.isArray(config.slabs) ? config.slabs : [];
      slabs.sort((a, b) => b.min_qty - a.min_qty); // Descending by min_qty

      for (const line of matchingLines) {
        const matchedSlab = slabs.find(s => line.quantity >= s.min_qty && (!s.max_qty || line.quantity <= s.max_qty));
        if (matchedSlab) {
          if (matchedSlab.price_paise && matchedSlab.price_paise < line.basePricePaise) {
            const discPerUnit = line.basePricePaise - matchedSlab.price_paise;
            const discPaise = discPerUnit * line.quantity;
            lineDiscounts.set(line.medicineId, discPaise);
            totalDiscountPaise += discPaise;
          } else if (matchedSlab.discount_pct && matchedSlab.discount_pct > 0) {
            const discPaise = Math.round((line.basePricePaise * line.quantity * matchedSlab.discount_pct) / 100);
            lineDiscounts.set(line.medicineId, discPaise);
            totalDiscountPaise += discPaise;
          }
        }
      }
    }

    // ── 6. BUNDLE / COMBO ────────────────────────────────────────────────────
    else if (pType === 'BUNDLE') {
      const bundleItems = Array.isArray(config.bundle_items) ? config.bundle_items : [];
      const bundlePricePaise = Number(config.bundle_price_paise || 0);

      // Check if all bundle items are present in cart with required quantities
      let bundleCount = Infinity;
      for (const bItem of bundleItems) {
        const cartLine = cartLines.find(l => l.medicineId === bItem.medicine_id);
        if (!cartLine || cartLine.quantity < bItem.quantity) {
          bundleCount = 0;
          break;
        }
        bundleCount = Math.min(bundleCount, Math.floor(cartLine.quantity / bItem.quantity));
      }

      if (bundleCount > 0 && bundleCount !== Infinity) {
        const regularBundleTotalPaise = bundleItems.reduce((acc, bItem) => {
          const cartLine = cartLines.find(l => l.medicineId === bItem.medicine_id);
          return acc + (cartLine?.basePricePaise || 0) * bItem.quantity;
        }, 0);

        if (regularBundleTotalPaise > bundlePricePaise) {
          const bundleSavings = (regularBundleTotalPaise - bundlePricePaise) * bundleCount;
          totalDiscountPaise = bundleSavings;

          for (const bItem of bundleItems) {
            const cartLine = cartLines.find(l => l.medicineId === bItem.medicine_id)!;
            const lineVal = cartLine.basePricePaise * bItem.quantity * bundleCount;
            const propDisc = Math.round((bundleSavings * lineVal) / (regularBundleTotalPaise * bundleCount));
            lineDiscounts.set(bItem.medicine_id, propDisc);
          }
        }
      }
    }

    // ── 7. CART_THRESHOLD_DISCOUNT ───────────────────────────────────────────
    else if (pType === 'CART_THRESHOLD_DISCOUNT') {
      const thresholdPaise = Number(config.threshold_amount_paise || 0);
      const totalEligible = matchingLines.reduce((sum, l) => sum + l.basePricePaise * l.quantity, 0);

      if (totalEligible >= thresholdPaise) {
        let discPaise = 0;
        if (config.threshold_discount_type === 'PERCENTAGE') {
          discPaise = Math.round((totalEligible * Number(config.threshold_discount_value || 0)) / 100);
        } else {
          discPaise = Money.toPaise(Number(config.threshold_discount_value || 0));
        }

        totalDiscountPaise = discPaise;
        for (const line of matchingLines) {
          const lineVal = line.basePricePaise * line.quantity;
          const propDisc = Math.round((discPaise * lineVal) / totalEligible);
          lineDiscounts.set(line.medicineId, propDisc);
        }
      }
    }

    return {
      promotionId: pId,
      promotionCode: promotion.code,
      promotionName: promotion.name,
      promotionType: pType,
      stackability: promotion.stackability || 'STACKABLE',
      priority: promotion.priority ?? 10,
      totalDiscountPaise,
      lineDiscounts,
      freeItems,
      isApplicable: totalDiscountPaise > 0 || freeItems.length > 0,
    };
  }

  /**
   * Records applied promotions on sale completion
   */
  static recordApplications(params: {
    organizationId: string;
    storeId?: string | null;
    saleId: string;
    applications: Array<{ id: string; code: string; name: string; discountPaise: number; freeQty: number }>;
  }) {
    const { organizationId, storeId, saleId, applications } = params;
    for (const app of applications) {
      const appId = uuidv4();
      localMutate({
        table: 'promotion_applications',
        operation: 'INSERT',
        data: {
          id: appId,
          _local_id: appId,
          organization_id: organizationId,
          store_id: storeId || null,
          sale_id: saleId,
          promotion_id: app.id,
          promotion_code: app.code,
          promotion_name: app.name,
          discount_amount_paise: app.discountPaise,
          free_quantity: app.freeQty,
        },
      });

      // Increment current_uses on promotion
      localDb
        .prepare('UPDATE promotions SET current_uses = current_uses + 1 WHERE id = ? OR _local_id = ?')
        .run(app.id, app.id);
    }
  }

  /**
   * Promotions CRUD
   */
  static listPromotions(organizationId: string): Promotion[] {
    return localDb
      .prepare(
        `SELECT p.*,
          (SELECT COUNT(*) FROM promotion_applications WHERE promotion_id = p.id OR promotion_id = p._local_id) as total_applications
         FROM promotions p
         WHERE (p.organization_id = ?) AND p._deleted = 0
         ORDER BY p.priority DESC, p.created_at DESC`
      )
      .all(organizationId) as Promotion[];
  }

  static createPromotion(data: Partial<Promotion> & { targets?: PromotionTarget[]; rewards?: any[] }): Promotion {
    const id = data.id || uuidv4();
    const created = localMutate({
      table: 'promotions',
      operation: 'INSERT',
      data: {
        id,
        _local_id: id,
        organization_id: data.organization_id,
        code: (data.code || `PROMO_${Date.now()}`).toUpperCase(),
        name: data.name,
        description: data.description || '',
        promotion_type: data.promotion_type || 'PERCENTAGE_DISCOUNT',
        priority: data.priority ?? 10,
        stackability: data.stackability || 'STACKABLE',
        start_at: data.start_at || null,
        end_at: data.end_at || null,
        status: data.status || 'ACTIVE',
        usage_limit: data.usage_limit || null,
        per_customer_limit: data.per_customer_limit || null,
        current_uses: 0,
        channel_scope: data.channel_scope || 'ALL',
        min_cart_value_paise: data.min_cart_value_paise ?? 0,
        max_discount_paise: data.max_discount_paise || null,
        is_best_offer_eligible: data.is_best_offer_eligible !== undefined ? (data.is_best_offer_eligible ? 1 : 0) : 1,
        rule_version: 1,
        config_json: typeof data.config_json === 'object' ? JSON.stringify(data.config_json) : (data.config_json || '{}'),
      },
    });

    if (Array.isArray(data.targets) && data.targets.length > 0) {
      for (const t of data.targets) {
        const tId = uuidv4();
        localMutate({
          table: 'promotion_targets',
          operation: 'INSERT',
          data: {
            id: tId,
            _local_id: tId,
            organization_id: data.organization_id,
            promotion_id: id,
            target_type: t.target_type,
            target_id: t.target_id,
            is_excluded: t.is_excluded ? 1 : 0,
          },
        });
      }
    }

    return created as Promotion;
  }
}
