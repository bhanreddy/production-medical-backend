// fulfilmentEngine.ts — Enterprise Multi-Store Fulfilment Location Selection Engine
import { localDb } from '../../local-db';
import { InventoryAvailabilityService } from '../inventory/inventoryAvailabilityService';
import { FulfilmentCandidate, FulfilmentType } from '../../domain/orderTypes';
import { AppError } from '../../lib/appError';

export interface LocationEvaluationParams {
  organizationId: string;
  items: Array<{
    medicine_id: string;
    quantity: number;
    unit_type?: string;
    conversion_factor?: number;
  }>;
  fulfilmentType?: FulfilmentType;
  requestedStoreId?: string | null;
  customerCoordinates?: { latitude: number; longitude: number } | null;
  pincode?: string | null;
  excludeLocationIds?: string[];
  requireSingleStoreFulfilment?: boolean;
}

export class FulfilmentEngine {
  /**
   * Approximate Haversine distance in kilometers
   */
  static calculateDistanceKm(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number
  ): number {
    const R = 6371; // Earth radius in km
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return Math.round(R * c * 10) / 10;
  }

  /**
   * Check if location is currently open based on operating hours
   */
  static isLocationOpen(openingTimeStr?: string | null, closingTimeStr?: string | null, timeZone = 'Asia/Kolkata'): boolean {
    if (!openingTimeStr || !closingTimeStr) return true;

    try {
      const now = new Date();
      const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
      const hour = Number(parts.find(part => part.type === 'hour')?.value);
      const minute = Number(parts.find(part => part.type === 'minute')?.value);
      const currentMinutes = hour * 60 + minute;

      const [openH, openM] = openingTimeStr.split(':').map(Number);
      const [closeH, closeM] = closingTimeStr.split(':').map(Number);

      const openMinutes = openH * 60 + (openM || 0);
      const closeMinutes = closeH * 60 + (closeM || 0);

      if (closeMinutes >= openMinutes) {
        return currentMinutes >= openMinutes && currentMinutes <= closeMinutes;
      } else {
        // Handles overnight store hours (e.g. 20:00 to 04:00)
        return currentMinutes >= openMinutes || currentMinutes <= closeMinutes;
      }
    } catch {
      return true;
    }
  }

  /**
   * Evaluate and rank fulfilment candidates for an order
   */
  static evaluateCandidates(params: LocationEvaluationParams): FulfilmentCandidate[] {
    const {
      organizationId,
      items,
      fulfilmentType = 'STORE_PICKUP',
      requestedStoreId = null,
      customerCoordinates = null,
      excludeLocationIds = [],
    } = params;

    if (!items || items.length === 0) {
      throw new AppError(400, 'Cannot evaluate fulfilment for empty item list', 'INVALID_ITEMS');
    }

    // 1. Check if any items require cold chain or special storage
    let requiresColdChain = false;
    for (const it of items) {
      const medRow: any = localDb
        .prepare('SELECT storage_type, cold_chain_required FROM medicines WHERE id = ? OR _local_id = ?')
        .get(it.medicine_id, it.medicine_id);
      if (medRow?.cold_chain_required || medRow?.storage_type === 'COLD_CHAIN') {
        requiresColdChain = true;
      }
    }

    // 2. Query all candidate stores in the organization
    const storeRows: any[] = localDb
      .prepare(
        `SELECT * FROM stores 
         WHERE organization_id = ? AND _deleted = 0 AND (deleted_at IS NULL)`
      )
      .all(organizationId);

    const candidates: FulfilmentCandidate[] = [];

    for (const s of storeRows) {
      if (excludeLocationIds.includes(s.id) || excludeLocationIds.includes(s._local_id)) {
        continue;
      }

      const ineligibilityReasons: string[] = [];

      const isStoreActive = (s.status || 'active').toLowerCase() === 'active';
      if (!isStoreActive) {
        ineligibilityReasons.push('STORE_INACTIVE');
      }

      // Check Store Capabilities
      const fulfilmentEnabled = s.fulfilment_enabled != null ? Boolean(s.fulfilment_enabled) : true;
      if (!fulfilmentEnabled) ineligibilityReasons.push('FULFILMENT_DISABLED');

      const deliveryEnabled = (s.delivery_enabled != null ? Boolean(s.delivery_enabled) : true) && (s.home_delivery_enabled != null ? Boolean(s.home_delivery_enabled) : true);
      const clickCollectEnabled = s.click_collect_enabled != null ? Boolean(s.click_collect_enabled) : true;

      // If Home Delivery requested, store must support delivery
      if (fulfilmentType === 'HOME_DELIVERY' && !deliveryEnabled) {
        ineligibilityReasons.push('DELIVERY_DISABLED');
      }

      // If Cold Chain required, store must support cold chain
      const coldChainSupported = (s.cold_chain_supported != null ? Boolean(s.cold_chain_supported) : true) && (s.cold_storage_supported != null ? Boolean(s.cold_storage_supported) : true);
      if (requiresColdChain && !coldChainSupported) {
        ineligibilityReasons.push('NO_COLD_STORAGE_SUPPORT');
      }

      const isOpen = isStoreActive && this.isLocationOpen(s.opening_time, s.closing_time, s.timezone || 'Asia/Kolkata');
      if (!isOpen && isStoreActive) {
        ineligibilityReasons.push('STORE_CLOSED');
      }

      // Distance calculation
      let distanceKm = 2.5; // default fallback
      if (customerCoordinates && s.latitude != null && s.longitude != null) {
        distanceKm = this.calculateDistanceKm(
          customerCoordinates.latitude,
          customerCoordinates.longitude,
          Number(s.latitude),
          Number(s.longitude)
        );
      } else if (requestedStoreId && (s.id === requestedStoreId || s._local_id === requestedStoreId)) {
        distanceKm = 0.0;
      }

      // Query active pick queue load
      const loadRow: any = localDb
        .prepare(
          `SELECT COUNT(*) as active_count FROM orders 
           WHERE fulfilment_store_id = ? AND status IN ('CONFIRMED', 'INVENTORY_RESERVED', 'PICKING') AND _deleted = 0`
        )
        .get(s.id);
      const activeOrderCount = Number(loadRow?.active_count || 0);

      // Check item-level inventory availability
      let availableItemsCount = 0;
      const itemAvailabilities = items.map(it => {
        const reqQty = it.quantity * (it.conversion_factor || 1.0);
        const avail = InventoryAvailabilityService.getAvailability({
          organizationId,
          medicineId: it.medicine_id,
          locationType: 'STORE',
          storeId: s.id,
        });

        const isAvail = avail.totalAvailable >= reqQty;
        if (isAvail) availableItemsCount++;

        return {
          medicineId: it.medicine_id,
          medicineName: avail.medicineName || 'Medicine',
          requestedQuantity: reqQty,
          availableQuantity: avail.totalAvailable,
          isAvailable: isAvail,
        };
      });

      const totalItemsCount = items.length;
      const availabilityPct = Math.round((availableItemsCount / totalItemsCount) * 100);
      const fullyAvailable = availableItemsCount === totalItemsCount;

      if (!fullyAvailable) {
        ineligibilityReasons.push('INSUFFICIENT_STOCK');
      }

      const isEligible = ineligibilityReasons.length === 0;

      // Ranking Score: Higher is better
      // 100% stock = +1000, requested store = +500, open = +200, minus distance, minus load
      let score = availabilityPct * 10;
      if (fullyAvailable) score += 1000;
      if (requestedStoreId && (s.id === requestedStoreId || s._local_id === requestedStoreId)) score += 500;
      if (isOpen) score += 200;
      if (!isEligible) score -= 5000;
      score -= distanceKm * 10;
      score -= activeOrderCount * 5;

      candidates.push({
        locationType: 'STORE',
        locationId: s.id,
        locationCode: s.store_code || 'STORE',
        locationName: s.name || s.display_name || 'Store',
        address: s.address || `${s.city || ''}, ${s.state || ''}`,
        distanceKm,
        isOpen,
        fulfilmentEnabled,
        deliveryEnabled,
        clickCollectEnabled,
        coldChainSupported,
        pharmacistAvailable: true,
        activeOrderCount,
        availabilityPct,
        fullyAvailable,
        isEligible,
        ineligibilityReasons,
        availableItemsCount,
        totalItemsCount,
        score,
        itemAvailabilities,
      });
    }

    // Sort descending by score
    candidates.sort((a, b) => b.score - a.score);

    return candidates;
  }

  /**
   * Select single best eligible location for an order
   */
  static selectBestLocation(params: LocationEvaluationParams): FulfilmentCandidate {
    const candidates = this.evaluateCandidates(params);
    const eligible = candidates.filter(c => c.isEligible);
    if (eligible.length > 0) {
      return eligible[0];
    }
    if (candidates.length > 0) {
      return candidates[0];
    }
    throw new AppError(404, 'No eligible stores available for order fulfilment', 'NO_FULFILMENT_LOCATION');
  }
}
