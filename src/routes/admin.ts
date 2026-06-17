import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import sql from '../db';
import { sendMail, approvalEmail } from '../lib/mailer';

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
    SELECT u.id, u.name, u.email, u.role, u.specialty, u.degrees, u.phone,
           u.reg_number, u.license_number, u.state, u.city, u.profile_slug,
           u.approval_status, u.rejection_reason, u.created_at,
           ls.last_login, COALESCE(ls.login_count, 0) AS login_count
    FROM users u
    LEFT JOIN (
      SELECT user_id, MAX(logged_in_at) AS last_login, COUNT(*) AS login_count
      FROM login_sessions GROUP BY user_id
    ) ls ON ls.user_id = u.id
    ORDER BY u.created_at DESC
  `;
  res.json(users);
});

// ─── Login sessions for a user (full timestamp history) ──────────────────────

router.get('/users/:id/sessions', async (req: Request, res: Response) => {
  const rows = await sql`
    SELECT logged_in_at, ip_address, user_agent, location_label, lat, lng
    FROM login_sessions WHERE user_id = ${Number(req.params.id)}
    ORDER BY logged_in_at DESC LIMIT 100
  `;
  res.json(rows);
});

// ─── Approve a user (allow full prescription access) ─────────────────────────

router.post('/users/:id/approve', async (req: Request, res: Response) => {
  const [user] = await sql`
    UPDATE users SET approval_status = 'approved' WHERE id = ${Number(req.params.id)}
    RETURNING name, email, role
  `;
  if (user?.email && ['clinic_admin', 'doctor'].includes(user.role as string)) {
    const mail = approvalEmail(user.name as string);
    sendMail(user.email as string, mail.subject, mail.html);
  }
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
  const [users] = await sql`
    SELECT COUNT(*) as total,
           SUM(CASE WHEN approval_status='approved' THEN 1 ELSE 0 END) as approved,
           SUM(CASE WHEN approval_status='pending'  THEN 1 ELSE 0 END) as pending,
           SUM(CASE WHEN approval_status='rejected' THEN 1 ELSE 0 END) as rejected,
           SUM(CASE WHEN role IN ('clinic_admin','doctor') THEN 1 ELSE 0 END) as doctors,
           SUM(CASE WHEN created_at > NOW() - INTERVAL '7 days' THEN 1 ELSE 0 END) as new_this_week
    FROM users WHERE role != 'superadmin'`;
  const [patients] = await sql`SELECT COUNT(*) as total FROM patients`;
  const [visits] = await sql`SELECT COUNT(*) as total FROM visits`;
  const [bookings] = await sql`
    SELECT COUNT(*) as total,
           SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) as pending,
           SUM(CASE WHEN created_at > NOW() - INTERVAL '7 days' THEN 1 ELSE 0 END) as this_week
    FROM booking_requests`;
  const [logins] = await sql`
    SELECT COUNT(*) as total,
           SUM(CASE WHEN logged_in_at > NOW() - INTERVAL '24 hours' THEN 1 ELSE 0 END) as last_24h
    FROM login_sessions`;
  res.json({ users, patients, visits, bookings, logins });
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

// ─── Per-doctor stats overview (all approved doctors) ────────────────────────

router.get('/doctors/overview', async (_req: Request, res: Response) => {
  const rows = await sql`
    SELECT
      u.id, u.name, u.email, u.specialty, u.degrees, u.phone,
      u.reg_number, u.license_number, u.city, u.state, u.profile_slug,
      u.approval_status, u.created_at, u.approved_at,
      u.clinic_id, u.consultation_fee, u.years_experience,
      c.name AS clinic_name,
      COALESCE(br.total_bookings,     0) AS total_bookings,
      COALESCE(br.confirmed_bookings, 0) AS confirmed_bookings,
      COALESCE(br.pending_bookings,   0) AS pending_bookings,
      COALESCE(v.total_visits,        0) AS total_visits,
      COALESCE(p.total_patients,      0) AS total_patients,
      COALESCE(ls.login_count,        0) AS login_count,
      ls.last_login
    FROM users u
    LEFT JOIN clinics c ON c.id = u.clinic_id
    LEFT JOIN (
      SELECT doctor_id,
        COUNT(*)                                                          AS total_bookings,
        SUM(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END)            AS confirmed_bookings,
        SUM(CASE WHEN status = 'pending'   THEN 1 ELSE 0 END)            AS pending_bookings
      FROM booking_requests GROUP BY doctor_id
    ) br ON br.doctor_id = u.id
    LEFT JOIN (
      SELECT doctor_id, COUNT(*) AS total_visits
      FROM visits GROUP BY doctor_id
    ) v ON v.doctor_id = u.id
    LEFT JOIN (
      SELECT attending_doctor_id, COUNT(DISTINCT id) AS total_patients
      FROM patients WHERE attending_doctor_id IS NOT NULL
      GROUP BY attending_doctor_id
    ) p ON p.attending_doctor_id = u.id
    LEFT JOIN (
      SELECT user_id, MAX(logged_in_at) AS last_login, COUNT(*) AS login_count
      FROM login_sessions GROUP BY user_id
    ) ls ON ls.user_id = u.id
    WHERE u.role IN ('clinic_admin', 'doctor') AND u.approval_status = 'approved'
    ORDER BY total_bookings DESC, u.name
  `;
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
