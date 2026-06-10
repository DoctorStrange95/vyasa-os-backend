import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import sql from '../db';

const router = Router();

function requireSuperAdmin(req: Request, res: Response, next: () => void) {
  if (req.user?.role !== 'superadmin') {
    res.status(403).json({ error: 'Superadmin access required' });
    return;
  }
  next();
}

router.use(requireAuth);
router.use(requireSuperAdmin);

// ─── List all pending users ───────────────────────────────────────────────────

router.get('/users', async (_req: Request, res: Response) => {
  const users = await sql`
    SELECT id, name, email, role, specialty, degrees, phone, reg_number, approval_status, created_at
    FROM users
    ORDER BY created_at DESC
  `;
  res.json(users);
});

// ─── Approve a user (allow full prescription access) ─────────────────────────

router.post('/users/:id/approve', async (req: Request, res: Response) => {
  await sql`UPDATE users SET approval_status = 'approved' WHERE id = ${req.params.id}`;
  res.json({ ok: true });
});

// ─── Reject / suspend a user ──────────────────────────────────────────────────

router.post('/users/:id/reject', async (req: Request, res: Response) => {
  const { reason } = req.body;
  await sql`
    UPDATE users SET approval_status = 'rejected', rejection_reason = ${reason ?? 'License not verified'}
    WHERE id = ${req.params.id}
  `;
  res.json({ ok: true });
});

router.post('/users/:id/suspend', async (req: Request, res: Response) => {
  await sql`UPDATE users SET approval_status = 'suspended' WHERE id = ${req.params.id}`;
  res.json({ ok: true });
});

// ─── Analytics ───────────────────────────────────────────────────────────────

router.get('/stats', async (_req: Request, res: Response) => {
  const [users] = await sql`SELECT COUNT(*) as total, SUM(CASE WHEN approval_status='approved' THEN 1 ELSE 0 END) as approved, SUM(CASE WHEN approval_status='pending' THEN 1 ELSE 0 END) as pending FROM users WHERE role != 'superadmin'`;
  const [patients] = await sql`SELECT COUNT(*) as total FROM patients`;
  const [visits] = await sql`SELECT COUNT(*) as total FROM visits`;
  res.json({ users, patients, visits });
});

// ─── Audit log (superadmin) ───────────────────────────────────────────────────

router.get('/audit', async (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query.limit ?? 100), 500);
  const offset = Number(req.query.offset ?? 0);
  const clinicId = req.query.clinic_id as string | undefined;
  const actorId = req.query.actor_id as string | undefined;

  const rows = clinicId
    ? await sql`
        SELECT * FROM audit_log
        WHERE clinic_id = ${clinicId}
        ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`
    : actorId
    ? await sql`
        SELECT * FROM audit_log
        WHERE actor_id = ${Number(actorId)}
        ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`
    : await sql`
        SELECT * FROM audit_log
        ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`;

  res.json(rows);
});

// ─── Clinic-scoped audit log (doctor sees their own clinic's log) ─────────────

export async function getClinicAuditLog(req: Request, res: Response) {
  const clinicId = req.user!.clinicId;
  const limit = Math.min(Number(req.query.limit ?? 50), 200);
  const offset = Number(req.query.offset ?? 0);

  const rows = await sql`
    SELECT id, actor_name, actor_role, action, resource_type, resource_id, details, ip_address, created_at
    FROM audit_log
    WHERE clinic_id = ${clinicId}
    ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}
  `;
  res.json(rows);
}

export default router;
