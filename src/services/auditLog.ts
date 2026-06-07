import { supabaseAdmin } from '../config/supabase';

export interface AuditLogOptions {
  clinicId: string;
  userId?: string | null;
  action: 'CREATE' | 'UPDATE' | 'DELETE' | string;
  table: string;
  recordId?: string;
  oldData?: any;
  newData?: any;
  ipAddress?: string;
}

export const auditLog = async (options: AuditLogOptions) => {
  const { error } = await supabaseAdmin.from('audit_logs').insert({
    clinic_id: options.clinicId,
    user_id: options.userId || null,
    action: options.action,
    table_name: options.table,
    record_id: options.recordId || null,
    old_data: options.oldData || null,
    new_data: options.newData || null,
    ip_address: options.ipAddress || null,
  });

  if (error) {
    console.error('Failed to write audit log', error);
  }
};
