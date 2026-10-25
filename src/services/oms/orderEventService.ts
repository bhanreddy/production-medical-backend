// orderEventService.ts — Immutable Order Audit Timeline & Event Dispatcher
import { localDb } from '../../local-db';
import { localMutate } from '../../lib/localMutate';
import { v4 as uuidv4 } from 'uuid';
import { OrderEvent, OrderEventType } from '../../domain/orderTypes';

export type OrderEventHandler = (event: OrderEvent) => void | Promise<void>;

export class OrderEventService {
  private static subscribers: OrderEventHandler[] = [];

  /**
   * Subscribe an event listener
   */
  static subscribe(handler: OrderEventHandler): () => void {
    this.subscribers.push(handler);
    return () => {
      this.subscribers = this.subscribers.filter(h => h !== handler);
    };
  }

  /**
   * Log an immutable order event and notify subscribers
   */
  static logEvent(params: {
    orderId: string;
    fulfilmentId?: string | null;
    organizationId: string;
    eventType: OrderEventType;
    fromStatus?: string | null;
    toStatus?: string | null;
    actorId?: string | null;
    actorName?: string | null;
    details?: Record<string, any>;
    notes?: string | null;
  }): OrderEvent {
    const {
      orderId,
      fulfilmentId = null,
      organizationId,
      eventType,
      fromStatus = null,
      toStatus = null,
      actorId = 'SYSTEM',
      actorName = 'System Orchestrator',
      details = {},
      notes = null,
    } = params;

    const id = uuidv4();
    const nowIso = new Date().toISOString();
    const detailsJson = JSON.stringify(details);

    localMutate({
      table: 'order_events',
      operation: 'INSERT',
      data: {
        id,
        _local_id: id,
        order_id: orderId,
        fulfilment_id: fulfilmentId,
        organization_id: organizationId,
        event_type: eventType,
        from_status: fromStatus,
        to_status: toStatus,
        actor_id: actorId,
        actor_name: actorName,
        details_json: detailsJson,
        notes: notes,
        created_at: nowIso,
      },
    });

    const event: OrderEvent = {
      id,
      order_id: orderId,
      fulfilment_id: fulfilmentId,
      organization_id: organizationId,
      event_type: eventType,
      from_status: fromStatus,
      to_status: toStatus,
      actor_id: actorId,
      actor_name: actorName,
      details_json: detailsJson,
      notes: notes,
      created_at: nowIso,
    };

    // Notify listeners asynchronously
    for (const sub of this.subscribers) {
      try {
        Promise.resolve(sub(event)).catch(err => {
          console.error(`[OrderEventService] Subscriber error on ${eventType}:`, err);
        });
      } catch (err) {
        console.error(`[OrderEventService] Synchronous subscriber error:`, err);
      }
    }

    return event;
  }

  /**
   * Fetch complete chronological timeline for an order
   */
  static getTimeline(orderId: string, organizationId: string): OrderEvent[] {
    const rows: any[] = localDb
      .prepare(
        `SELECT * FROM order_events 
         WHERE order_id = ? AND organization_id = ? 
         ORDER BY created_at ASC`
      )
      .all(orderId, organizationId);

    return rows.map(r => ({
      ...r,
      details: r.details_json ? JSON.parse(r.details_json) : {},
    }));
  }
}
