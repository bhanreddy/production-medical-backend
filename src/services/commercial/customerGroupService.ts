import { localDb } from '../../local-db';
import { localMutate } from '../../lib/localMutate';
import { v4 as uuidv4 } from 'uuid';
import {
  CustomerGroup,
  CustomerGroupMember,
  CustomerMembership,
} from '../../domain/commercialTypes';

export class CustomerGroupService {
  /**
   * Lists customer groups for an organization
   */
  static listGroups(organizationId: string): CustomerGroup[] {
    return localDb
      .prepare(
        `SELECT cg.*, 
          (SELECT COUNT(*) FROM customer_group_members WHERE customer_group_id = cg.id OR customer_group_id = cg._local_id) as member_count
         FROM customer_groups cg
         WHERE (cg.organization_id = ?) AND cg._deleted = 0
         ORDER BY cg.priority DESC, cg.name ASC`
      )
      .all(organizationId) as CustomerGroup[];
  }

  /**
   * Creates a customer group
   */
  static createGroup(data: Partial<CustomerGroup>): CustomerGroup {
    const id = data.id || uuidv4();
    const group = localMutate({
      table: 'customer_groups',
      operation: 'INSERT',
      data: {
        id,
        _local_id: id,
        organization_id: data.organization_id,
        code: data.code || `GRP_${Date.now()}`,
        name: data.name,
        description: data.description || '',
        priority: data.priority ?? 10,
        default_price_book_id: data.default_price_book_id || null,
        discount_pct: data.discount_pct ?? 0,
        is_active: data.is_active !== undefined ? (data.is_active ? 1 : 0) : 1,
      },
    });
    return group as CustomerGroup;
  }

  /**
   * Assigns a customer to a group
   */
  static assignCustomer(params: {
    organizationId: string;
    customerGroupId: string;
    customerId: string;
    startAt?: string;
    endAt?: string;
    assignedBy?: string;
  }): CustomerGroupMember {
    const id = uuidv4();
    const member = localMutate({
      table: 'customer_group_members',
      operation: 'INSERT',
      data: {
        id,
        _local_id: id,
        organization_id: params.organizationId,
        customer_group_id: params.customerGroupId,
        customer_id: params.customerId,
        start_at: params.startAt || new Date().toISOString(),
        end_at: params.endAt || null,
        status: 'ACTIVE',
        assigned_by: params.assignedBy || null,
      },
    });
    return member as CustomerGroupMember;
  }

  /**
   * Resolves the primary active group for a customer based on highest priority
   */
  static resolveCustomerGroup(customerId: string, organizationId: string): CustomerGroup | null {
    const nowIso = new Date().toISOString();
    const group: any = localDb
      .prepare(
        `SELECT cg.*
         FROM customer_groups cg
         JOIN customer_group_members cgm ON (cgm.customer_group_id = cg.id OR cgm.customer_group_id = cg._local_id)
         WHERE (cgm.customer_id = ? OR cgm.customer_id = ?)
           AND (cg.organization_id = ?)
           AND cg.is_active = 1 AND cg._deleted = 0
           AND cgm.status = 'ACTIVE' AND cgm._deleted = 0
           AND (cgm.start_at IS NULL OR cgm.start_at <= ?)
           AND (cgm.end_at IS NULL OR cgm.end_at >= ?)
         ORDER BY cg.priority DESC
         LIMIT 1`
      )
      .get(customerId, customerId, organizationId, nowIso, nowIso);

    return group || null;
  }

  /**
   * Creates or updates a customer membership tier
   */
  static setMembership(params: {
    organizationId: string;
    customerId: string;
    membershipType?: string;
    tier?: string;
    loyaltyMultiplier?: number;
    membershipNumber?: string;
    startAt?: string;
    endAt?: string;
  }): CustomerMembership {
    const id = uuidv4();
    const existing: any = localDb
      .prepare('SELECT * FROM customer_memberships WHERE customer_id = ? AND _deleted = 0')
      .get(params.customerId);

    if (existing) {
      const updated = localMutate({
        table: 'customer_memberships',
        operation: 'UPDATE',
        data: {
          _local_id: existing._local_id,
          membership_type: params.membershipType || existing.membership_type,
          tier: params.tier || existing.tier,
          loyalty_multiplier: params.loyaltyMultiplier ?? existing.loyalty_multiplier,
          membership_number: params.membershipNumber || existing.membership_number,
          start_at: params.startAt || existing.start_at,
          end_at: params.endAt || existing.end_at,
          status: 'ACTIVE',
        },
      });
      return updated as CustomerMembership;
    }

    const created = localMutate({
      table: 'customer_memberships',
      operation: 'INSERT',
      data: {
        id,
        _local_id: id,
        organization_id: params.organizationId,
        customer_id: params.customerId,
        membership_number: params.membershipNumber || `MEM-${Date.now().toString().slice(-6)}`,
        membership_type: params.membershipType || 'STANDARD',
        tier: params.tier || 'SILVER',
        loyalty_multiplier: params.loyaltyMultiplier ?? 1.0,
        start_at: params.startAt || new Date().toISOString(),
        end_at: params.endAt || null,
        status: 'ACTIVE',
      },
    });
    return created as CustomerMembership;
  }

  /**
   * Retrieves active membership for a customer
   */
  static getActiveMembership(customerId: string, organizationId: string): CustomerMembership | null {
    const nowIso = new Date().toISOString();
    const mem: any = localDb
      .prepare(
        `SELECT * FROM customer_memberships
         WHERE (customer_id = ? OR customer_id = ?)
           AND (organization_id = ?)
           AND status = 'ACTIVE' AND _deleted = 0
           AND (start_at IS NULL OR start_at <= ?)
           AND (end_at IS NULL OR end_at >= ?)
         LIMIT 1`
      )
      .get(customerId, customerId, organizationId, nowIso, nowIso);

    return mem || null;
  }
}
