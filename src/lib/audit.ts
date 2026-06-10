import { Request } from 'express';
import sql from '../db';

export type AuditAction =
  | 'patient.create' | 'patient.read' | 'patient.update' | 'patient.delete'
  | 'visit.create' | 'visit.read' | 'visit.update' | 'visit.delete'
  | 'vitals.create' | 'vitals.read' | 'vitals.update' | 'vitals.delete'
  | 'appointment.create' | 'appointment.read' | 'appointment.update' | 'appointment.delete'
  | 'staff.approve' | 'staff.reject' | 'staff.remove'
  | 'auth.login' | 'auth.logout' | 'auth.register'
  | 'settings.update';

export interface AuditEntry {
  actorId: number;
  actorName: string;
  actorRole: string;
  clinicId?: string;
  action: AuditAction;
  resourceType: string;
  resourceId?: string;
  details?: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
}

export async function audit(entry: AuditEntry): Promise<void> {
  const ip = entry.ip ?? null;
  const ua = entry.userAgent ?? null;
  const details = entry.details ? JSON.stringify(entry.details) : null;

  // Fire-and-forget — never block a request for audit logging
  sql`
    INSERT INTO audit_log (
      actor_id, actor_name, actor_role, clinic_id,
      action, resource_type, resource_id,
      details, ip_address, user_agent
    ) VALUES (
      ${entry.actorId}, ${entry.actorName}, ${entry.actorRole}, ${entry.clinicId ?? null},
      ${entry.action}, ${entry.resourceType}, ${entry.resourceId ?? null},
      ${details}, ${ip}, ${ua}
    )
  `.catch(err => console.error('[audit] write failed:', err));
}

export function auditFromReq(
  req: Request,
  action: AuditAction,
  resourceType: string,
  resourceId?: string,
  details?: Record<string, unknown>,
): void {
  const user = req.user!;
  const ip = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim()
    ?? req.socket?.remoteAddress ?? undefined;
  const ua = req.headers['user-agent'];

  audit({
    actorId: user.userId,
    actorName: user.name,
    actorRole: user.role,
    clinicId: user.clinicId,
    action,
    resourceType,
    resourceId,
    details,
    ip,
    userAgent: ua,
  }).catch(() => {});
}
