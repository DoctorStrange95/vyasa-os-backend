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
           u.reg_number, u.license_number, u.medical_council, u.reg_state,
           u.state, u.city, u.profile_slug,
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
  const userId = Number(req.params.id);

  // Fetch current state before update so we can generate slug if missing
  const [existing] = await sql`
    SELECT name, email, role, profile_slug FROM users WHERE id = ${userId}
  `;
  if (!existing) { res.status(404).json({ error: 'User not found' }); return; }

  // Generate profile_slug now if the doctor doesn't have one yet
  if (!existing.profile_slug && ['clinic_admin', 'doctor'].includes(existing.role as string)) {
    const base = (existing.name as string)
      .toLowerCase()
      .replace(/^dr\.?\s+/i, '')
      .replace(/[^a-z0-9\s]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 80);
    let slug = base;
    let n = 2;
    while (true) {
      const taken = await sql`SELECT id FROM users WHERE profile_slug = ${slug}`;
      if (!taken.length) break;
      slug = `${base}-${n++}`;
    }
    await sql`UPDATE users SET profile_slug = ${slug}, approved_at = NOW(), approval_status = 'approved' WHERE id = ${userId}`;
  } else {
    await sql`UPDATE users SET approval_status = 'approved', approved_at = NOW() WHERE id = ${userId}`;
  }

  if (existing.email && ['clinic_admin', 'doctor'].includes(existing.role as string)) {
    const mail = approvalEmail(existing.name as string);
    sendMail(existing.email as string, mail.subject, mail.html);
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

// ─── Block / Unblock a user (superadmin) ─────────────────────────────────────
// Block = set 'suspended' (prevents login). Unblock = restore to 'approved'.
router.post('/users/:id/block', async (req: Request, res: Response) => {
  if (req.user!.role !== 'superadmin') { res.status(403).json({ error: 'Forbidden' }); return; }
  await sql`UPDATE users SET approval_status = 'suspended' WHERE id = ${req.params.id}`;
  res.json({ ok: true, status: 'suspended' });
});

router.post('/users/:id/unblock', async (req: Request, res: Response) => {
  if (req.user!.role !== 'superadmin') { res.status(403).json({ error: 'Forbidden' }); return; }
  await sql`UPDATE users SET approval_status = 'approved' WHERE id = ${req.params.id}`;
  res.json({ ok: true, status: 'approved' });
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
      COALESCE(u.show_in_directory, true) AS show_in_directory,
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
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS total_visits
      FROM visits
      WHERE doctor_id = u.id
         OR (doctor_id IS NULL AND LOWER(doctor_name) = LOWER(u.name))
    ) v ON true
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

// ─── Superadmin: toggle show_in_directory for a doctor ───────────────────────

router.patch('/doctors/:id/directory', async (req: Request, res: Response) => {
  if (req.user!.role !== 'superadmin') { res.status(403).json({ error: 'Forbidden' }); return; }
  const { show } = req.body as { show: boolean };
  await sql`UPDATE users SET show_in_directory = ${show} WHERE id = ${req.params.id}`;
  res.json({ ok: true, show });
});

// ─── Login funnel analytics ──────────────────────────────────────────────────

router.get('/funnel', async (_req: Request, res: Response) => {
  const [events, logins] = await Promise.all([
    sql`
      SELECT event_type, COUNT(*) AS count
      FROM page_events
      WHERE created_at > NOW() - INTERVAL '30 days'
      GROUP BY event_type
      ORDER BY count DESC
    `,
    sql`SELECT COUNT(*) AS count FROM login_sessions WHERE logged_in_at > NOW() - INTERVAL '30 days'`,
  ]);
  res.json({ events, successful_logins: Number(logins[0]?.count ?? 0) });
});

router.get('/login-attempts', async (_req: Request, res: Response) => {
  const rows = await sql`
    SELECT
      metadata->>'email' AS email,
      metadata->>'method' AS method,
      metadata->>'status' AS status,
      created_at
    FROM page_events
    WHERE event_type = 'login_attempt'
      AND metadata->>'email' IS NOT NULL
    ORDER BY created_at DESC
    LIMIT 100
  `;
  res.json(rows);
});

router.get('/failed-logins', async (_req: Request, res: Response) => {
  const rows = await sql`
    SELECT
      metadata->>'email' AS email,
      metadata->>'method' AS method,
      metadata->>'reason' AS reason,
      created_at
    FROM page_events
    WHERE event_type = 'login_failed'
      AND metadata->>'email' IS NOT NULL
    ORDER BY created_at DESC
    LIMIT 100
  `;
  res.json(rows);
});

// ─── Recent logins with geo ──────────────────────────────────────────────────

router.get('/recent-logins', async (_req: Request, res: Response) => {
  const rows = await sql`
    SELECT
      u.id, u.name, u.email, u.specialty, u.city, u.state,
      ls.logged_in_at, ls.ip_address, ls.location_label, ls.lat, ls.lng, ls.user_agent
    FROM login_sessions ls
    JOIN users u ON u.id = ls.user_id
    ORDER BY ls.logged_in_at DESC
    LIMIT 100
  `;
  res.json(rows);
});

router.get('/geo-summary', async (_req: Request, res: Response) => {
  const byCityState = await sql`
    SELECT
      COALESCE(ls.location_label, u.city, 'Unknown') AS location,
      u.state,
      COUNT(*) AS login_count,
      COUNT(DISTINCT u.id) AS unique_doctors
    FROM login_sessions ls
    JOIN users u ON u.id = ls.user_id
    GROUP BY COALESCE(ls.location_label, u.city, 'Unknown'), u.state
    ORDER BY login_count DESC
    LIMIT 20
  `;
  res.json(byCityState);
});

// ─── Email logs ──────────────────────────────────────────────────────────────

router.post('/email-logs', async (req: Request, res: Response) => {
  const { recipient_id, recipient_email, recipient_name, template_name, subject } = req.body;
  if (!recipient_email || !recipient_name || !template_name || !subject) {
    res.status(400).json({ error: 'Missing required fields' });
    return;
  }
  await sql`
    INSERT INTO email_logs (sent_by, recipient_id, recipient_email, recipient_name, template_name, subject)
    VALUES (${req.user!.userId}, ${recipient_id ?? null}, ${recipient_email}, ${recipient_name}, ${template_name}, ${subject})
  `;
  res.json({ ok: true });
});

router.get('/email-logs', async (_req: Request, res: Response) => {
  const rows = await sql`
    SELECT id, recipient_id, recipient_email, recipient_name, template_name, subject, sent_at
    FROM email_logs
    ORDER BY sent_at DESC
    LIMIT 500
  `;
  res.json(rows);
});

// ─── Superadmin: clinics overview (grouped staff per clinic) ─────────────────
// Read-only. Fully wrapped in try/catch so a query issue returns [] instead of
// ever crashing the panel. Groups org members + pending invitees under each clinic.
router.get('/clinics-overview', async (req: Request, res: Response) => {
  if (req.user!.role !== 'superadmin') { res.status(403).json({ error: 'Forbidden' }); return; }
  try {
    const orgs = await sql`
      SELECT o.id, o.name AS org_name, o.type, o.city, o.created_at,
             u.id AS owner_id, u.name AS owner_name, u.email AS owner_email,
             u.specialty AS owner_specialty, u.approval_status AS owner_status
      FROM organizations o
      LEFT JOIN users u ON u.id = o.owner_id
      ORDER BY o.created_at DESC
    `;
    if (!orgs.length) { res.json([]); return; }

    const orgIds = orgs.map((o: any) => o.id as string);
    const ownerIds = orgs.map((o: any) => o.owner_id).filter((x: any) => x != null);

    const members = await sql`
      SELECT om.org_id, om.role AS member_role,
             u.id, u.name, u.email, u.specialty, u.role AS user_role, u.approval_status,
             COALESCE(ls.login_count, 0)::int AS login_count, ls.last_login
      FROM org_members om
      JOIN users u ON u.id = om.user_id
      LEFT JOIN (
        SELECT user_id, MAX(logged_in_at) AS last_login, COUNT(*) AS login_count
        FROM login_sessions GROUP BY user_id
      ) ls ON ls.user_id = u.id
      WHERE om.org_id = ANY(${orgIds}::text[])
    `;

    // Pending invitees linked to a clinic owner but not yet in org_members
    const invited = ownerIds.length ? await sql`
      SELECT u.id, u.name, u.email, u.specialty, u.role AS member_role, u.role AS user_role,
             u.approval_status, u.invited_by_user_id AS owner_id,
             COALESCE(ls.login_count, 0)::int AS login_count, ls.last_login
      FROM users u
      LEFT JOIN (
        SELECT user_id, MAX(logged_in_at) AS last_login, COUNT(*) AS login_count
        FROM login_sessions GROUP BY user_id
      ) ls ON ls.user_id = u.id
      WHERE u.invited_by_user_id = ANY(${ownerIds}::int[])
        AND u.role IN ('doctor','nurse','pharmacist','labtech','lab_technician')
    ` : [];

    const result = orgs.map((o: any) => {
      const mem = members.filter((m: any) => m.org_id === o.id);
      const memIds = new Set(mem.map((m: any) => m.id));
      const pend = invited.filter((iv: any) => iv.owner_id === o.owner_id && !memIds.has(iv.id));
      const all = [...mem, ...pend];
      const counts: Record<string, number> = {};
      for (const m of all) {
        const r = String(m.member_role || m.user_role || 'other').toLowerCase();
        counts[r] = (counts[r] || 0) + 1;
      }
      return { ...o, members: all, counts, staff_total: all.length };
    });
    res.json(result);
  } catch (e) {
    console.error('[clinics-overview]', e);
    res.json([]);
  }
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
