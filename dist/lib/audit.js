"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.audit = audit;
exports.auditFromReq = auditFromReq;
const db_1 = __importDefault(require("../db"));
async function audit(entry) {
    const ip = entry.ip ?? null;
    const ua = entry.userAgent ?? null;
    const details = entry.details ? JSON.stringify(entry.details) : null;
    // Fire-and-forget — never block a request for audit logging
    (0, db_1.default) `
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
function auditFromReq(req, action, resourceType, resourceId, details) {
    const user = req.user;
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
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
    }).catch(() => { });
}
