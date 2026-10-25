// orderStateMachine.ts — Enterprise Order State Machine & Transition Guards
import {
  OrderStatus,
  OrderPrescriptionStatus,
  OrderPaymentStatus,
  OrderFulfilmentStatus,
  OrderItemStatus,
} from '../../domain/orderTypes';
import { AppError } from '../../lib/appError';

export class OrderStateMachine {
  // Allowed Order Status Transitions
  private static readonly ALLOWED_ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
    DRAFT: ['CREATED', 'VALIDATING', 'CANCELLED'],
    CREATED: ['VALIDATING', 'PRESCRIPTION_PENDING', 'CONFIRMED', 'CANCELLED', 'FAILED'],
    VALIDATING: ['PRESCRIPTION_PENDING', 'CONFIRMED', 'CANCELLED', 'FAILED'],
    PRESCRIPTION_PENDING: ['CONFIRMED', 'CANCELLED', 'FAILED'],
    CONFIRMED: ['INVENTORY_RESERVED', 'PICKING', 'CANCELLED', 'FAILED'],
    INVENTORY_RESERVED: ['PICKING', 'PACKED', 'CANCELLED', 'FAILED'],
    PICKING: ['PACKED', 'PARTIALLY_FULFILLED', 'CANCELLED', 'FAILED'],
    PACKED: ['READY_FOR_PICKUP', 'READY_FOR_DISPATCH', 'CANCELLED', 'FAILED'],
    READY_FOR_PICKUP: ['COMPLETED', 'CANCELLED', 'FAILED'],
    READY_FOR_DISPATCH: ['COMPLETED', 'CANCELLED', 'FAILED'],
    PARTIALLY_FULFILLED: ['PACKED', 'READY_FOR_PICKUP', 'READY_FOR_DISPATCH', 'COMPLETED', 'CANCELLED'],
    COMPLETED: [], // Terminal
    CANCELLED: [], // Terminal
    FAILED: ['VALIDATING', 'CANCELLED'], // Can retry validation or cancel
  };

  // Allowed Fulfilment Status Transitions
  private static readonly ALLOWED_FULFILMENT_TRANSITIONS: Record<OrderFulfilmentStatus, OrderFulfilmentStatus[]> = {
    UNASSIGNED: ['ASSIGNED', 'CANCELLED'],
    ASSIGNED: ['RESERVED', 'PICKING', 'CANCELLED'],
    RESERVED: ['PICKING', 'PACKED', 'CANCELLED'],
    PICKING: ['PICKED', 'PACKED', 'CANCELLED'],
    PICKED: ['PACKED', 'READY', 'CANCELLED'],
    PACKED: ['READY', 'DISPATCHED', 'CANCELLED'],
    READY: ['HANDED_OVER', 'DISPATCHED', 'CANCELLED'],
    DISPATCHED: ['HANDED_OVER', 'CANCELLED', 'FAILED'],
    HANDED_OVER: [], // Terminal
    CANCELLED: [], // Terminal
    FAILED: ['ASSIGNED', 'CANCELLED'],
  };

  // Allowed Item Status Transitions
  private static readonly ALLOWED_ITEM_TRANSITIONS: Record<OrderItemStatus, OrderItemStatus[]> = {
    REQUESTED: ['PENDING_VALIDATION', 'PENDING_PRESCRIPTION', 'CONFIRMED', 'CANCELLED', 'UNAVAILABLE'],
    PENDING_VALIDATION: ['PENDING_PRESCRIPTION', 'CONFIRMED', 'CANCELLED', 'UNAVAILABLE'],
    PENDING_PRESCRIPTION: ['CONFIRMED', 'CANCELLED', 'UNAVAILABLE'],
    CONFIRMED: ['RESERVED', 'PICKING', 'CANCELLED', 'UNAVAILABLE'],
    RESERVED: ['PICKING', 'PICKED', 'SUBSTITUTION_REQUIRED', 'CANCELLED', 'UNAVAILABLE'],
    PICKING: ['PICKED', 'SUBSTITUTION_REQUIRED', 'PARTIALLY_FULFILLED', 'CANCELLED', 'UNAVAILABLE'],
    PICKED: ['FULFILLED', 'PARTIALLY_FULFILLED', 'CANCELLED'],
    SUBSTITUTION_REQUIRED: ['CONFIRMED', 'RESERVED', 'CANCELLED', 'UNAVAILABLE'],
    PARTIALLY_FULFILLED: ['FULFILLED', 'CANCELLED'],
    FULFILLED: [],
    CANCELLED: [],
    UNAVAILABLE: ['SUBSTITUTION_REQUIRED', 'CANCELLED'],
  };

  /**
   * Validate order status transition
   */
  static validateOrderTransition(from: OrderStatus, to: OrderStatus): void {
    if (from === to) return;

    const allowed = this.ALLOWED_ORDER_TRANSITIONS[from] || [];
    if (!allowed.includes(to)) {
      throw new AppError(
        400,
        `Invalid order status transition from '${from}' to '${to}'`,
        'INVALID_STATE_TRANSITION'
      );
    }
  }

  /**
   * Validate fulfilment status transition
   */
  static validateFulfilmentTransition(from: OrderFulfilmentStatus, to: OrderFulfilmentStatus): void {
    if (from === to) return;

    const allowed = this.ALLOWED_FULFILMENT_TRANSITIONS[from] || [];
    if (!allowed.includes(to)) {
      throw new AppError(
        400,
        `Invalid fulfilment status transition from '${from}' to '${to}'`,
        'INVALID_FULFILMENT_TRANSITION'
      );
    }
  }

  /**
   * Validate item status transition
   */
  static validateItemTransition(from: OrderItemStatus, to: OrderItemStatus): void {
    if (from === to) return;

    const allowed = this.ALLOWED_ITEM_TRANSITIONS[from] || [];
    if (!allowed.includes(to)) {
      throw new AppError(
        400,
        `Invalid order item status transition from '${from}' to '${to}'`,
        'INVALID_ITEM_STATE_TRANSITION'
      );
    }
  }

  /**
   * Determine if order is in a final immutable state
   */
  static isOrderTerminal(status: OrderStatus): boolean {
    return status === 'COMPLETED' || status === 'CANCELLED';
  }

  /**
   * Check if order can be cancelled at its current stage
   */
  static canCancelOrder(status: OrderStatus): { allowed: boolean; reason?: string } {
    if (status === 'COMPLETED') {
      return { allowed: false, reason: 'Completed orders cannot be cancelled. Use Sales Return instead.' };
    }
    if (status === 'CANCELLED') {
      return { allowed: false, reason: 'Order is already cancelled.' };
    }
    return { allowed: true };
  }

  /**
   * Map internal statuses to customer-friendly display status
   */
  static getCustomerDisplayStatus(status: OrderStatus, fulfilmentType: string): {
    title: string;
    step: number;
    description: string;
  } {
    switch (status) {
      case 'DRAFT':
      case 'CREATED':
      case 'VALIDATING':
        return { title: 'Order Placed', step: 1, description: 'Your order has been received.' };
      case 'PRESCRIPTION_PENDING':
        return { title: 'Prescription Under Review', step: 1, description: 'Our licensed pharmacist is reviewing your prescription.' };
      case 'CONFIRMED':
      case 'INVENTORY_RESERVED':
        return { title: 'Order Confirmed', step: 2, description: 'Your order has been confirmed and medicines are reserved.' };
      case 'PICKING':
      case 'PACKED':
      case 'PARTIALLY_FULFILLED':
        return { title: 'Preparing Order', step: 3, description: 'Our pharmacy staff is packing your items.' };
      case 'READY_FOR_PICKUP':
        return { title: 'Ready for Pickup', step: 4, description: 'Your order is ready at the pharmacy counter. Please present your pickup code.' };
      case 'READY_FOR_DISPATCH':
        return { title: 'Ready for Delivery', step: 4, description: 'Your package is packed and awaiting rider dispatch.' };
      case 'COMPLETED':
        return {
          title: fulfilmentType === 'HOME_DELIVERY' ? 'Delivered' : 'Picked Up',
          step: 5,
          description: 'Order successfully completed.',
        };
      case 'CANCELLED':
        return { title: 'Cancelled', step: 0, description: 'This order was cancelled.' };
      case 'FAILED':
        return { title: 'Needs Attention', step: 0, description: 'There was an issue processing your order.' };
      default:
        return { title: 'Processing', step: 1, description: 'Order is being processed.' };
    }
  }
}
