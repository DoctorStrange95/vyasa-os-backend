import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import sql from '../db';
import { auditFromReq } from '../lib/audit';

const router = Router();
router.use(requireAuth);

// GET /staff/pending
// Returns pending staff who were invited to one of THIS doctor's clinics.
// (Staff with no invited_clinic_ids at all are also shown so legacy invites
// aren't lost — but staff invited to someone else's clinic are hidden.)
router.get('/pending', async (req: Request, res: Response) => {
  const userId = req.user!.userId;

  const clinics = await sql`SELECT id FROM clinics WHERE owner_id = ${userId}`;
  let myClinicIds = clinics.map(c => c.id as string);

  // Fallback: use clinic_id from users table if clinics table has no rows for this doctor
  if (myClinicIds.length === 0) {
    const [doctor] = await sql`SELECT clinic_id FROM users WHERE id = ${userId}`;
    if (doctor?.clinic_id) myClinicIds = [doctor.clinic_id as string];
  }

  const pending = await sql`
    SELECT id, name, email, phone, role, degrees, specialty,
           invited_clinic_ids, invited_clinic_name, invited_by_user_id, created_at
    FROM users
    WHERE approval_status = 'pending'
      AND role NOT IN ('clinic_admin', 'superadmin', 'patient')
    ORDER BY created_at DESC
  `;
  const scoped = pending.filter(p => {
    // Primary match: invited_by_user_id — set when staff registers via invite link
    // that includes ?did=doctorId. Most reliable across all role types.
    if (p.invited_by_user_id != null) {
      return (p.invited_by_user_id as number) === userId;
    }
    // Fallback: match by clinic IDs (older registrations without invited_by_user_id)
    // decodeURIComponent handles links that were double-encoded by WhatsApp/email
    const raw = decodeURIComponent((p.invited_clinic_ids as string | null) ?? '');
    const invited = raw.split(',').map(s => s.trim()).filter(Boolean);
    if (invited.length === 0) return true; // legacy: no invite metadata → show to all
    return myClinicIds.length === 0 || invited.some(id => myClinicIds.includes(id));
  });
  res.json(scoped);
});

// GET /staff/active — returns approved staff belonging to the doctor's clinics
// Primary match: invited_by_user_id = doctor (set on approve / invite link)
// Secondary: clinic_id = ANY(doctor's clinics) for older records without invited_by_user_id
router.get('/active', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const clinics = await sql`SELECT id FROM clinics WHERE owner_id = ${userId}`;
  const clinicIds = clinics.map(c => c.id as string);

  // Primary: staff who were approved by / invited by this doctor
  const byInvite = await sql`
    SELECT id, name, email, phone, role, degrees, specialty, department, clinic_id, created_at
    FROM users
    WHERE approval_status = 'approved'
      AND role NOT IN ('clinic_admin', 'superadmin', 'patient')
      AND invited_by_user_id = ${userId}
    ORDER BY name
  `;

  // Secondary: legacy staff with no invited_by_user_id but assigned to this doctor's clinic
  let byClinic: typeof byInvite = [];
  if (clinicIds.length > 0) {
    byClinic = await sql`
      SELECT id, name, email, phone, role, degrees, specialty, department, clinic_id, created_at
      FROM users
      WHERE approval_status = 'approved'
        AND role NOT IN ('clinic_admin', 'superadmin', 'patient')
        AND invited_by_user_id IS NULL
        AND clinic_id = ANY(${clinicIds})
      ORDER BY name
    `;
  }

  // Merge without duplicates (byInvite takes precedence)
  const seen = new Set(byInvite.map(u => u.id));
  const combined = [
    ...byInvite,
    ...byClinic.filter(u => !seen.has(u.id)),
  ].sort((a, b) => String(a.name).localeCompare(String(b.name)));

  res.json(combined);
});

// POST /staff/:id/approve — assign to first matched clinic and mark approved
router.post('/:id/approve', async (req: Request, res: Response) => {
  const user = req.user!;
  const targetId = Number(req.params.id);

  const clinics = await sql`SELECT id FROM clinics WHERE owner_id = ${user.userId}`;
  const clinicIds = clinics.map(c => c.id as string);

  if (clinicIds.length === 0) {
    res.status(403).json({ error: 'No clinics found' });
    return;
  }

  // Verify the target user was actually invited to one of this doctor's clinics
  const [target] = await sql`SELECT id, invited_clinic_ids, invited_by_user_id FROM users WHERE id = ${targetId}`;
  if (!target) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  // Primary auth check: if staff was invited directly by this doctor, allow
  const directlyInvited = (target.invited_by_user_id as number | null) === user.userId;

  // Secondary check: match via clinic IDs
  const invitedIds = (target.invited_clinic_ids as string | null)?.split(',').map(s => s.trim()).filter(Boolean) ?? [];
  const matchedClinic = clinicIds.find(id => invitedIds.includes(id));

  // If they were explicitly invited to a different doctor's clinic, refuse
  if (!directlyInvited && !matchedClinic && invitedIds.length > 0) {
    res.status(403).json({ error: 'This staff member was invited to a different clinic.' });
    return;
  }

  // Legacy registrations with no invite metadata: assign to this doctor's first clinic
  const assignClinic = matchedClinic ?? clinicIds[0];

  await sql`
    UPDATE users
    SET approval_status = 'approved',
        clinic_id = ${assignClinic},
        invited_by_user_id = COALESCE(invited_by_user_id, ${user.userId}),
        approved_at = NOW()
    WHERE id = ${targetId}
  `;

  auditFromReq(req, 'staff.approve', 'user', String(targetId), { clinicId: assignClinic });
  res.json({ ok: true, clinicId: assignClinic });
});

// POST /staff/create — directly create an approved staff member (no invite flow)
// Used by clinic_admin when adding staff manually from the UI
router.post('/create', async (req: Request, res: Response) => {
  const user = req.user!;
  if (user.role !== 'clinic_admin' && user.role !== 'superadmin') {
    res.status(403).json({ error: 'Only clinic admins can create staff directly' });
    return;
  }

  const { name, email, phone, role, department, specialty, shift } = req.body as {
    name: string; email: string; phone?: string; role?: string;
    department?: string; specialty?: string; shift?: string;
  };
  if (!name?.trim() || !email?.trim()) {
    res.status(400).json({ error: 'Name and email are required' });
    return;
  }

  const clinics = await sql`SELECT id FROM clinics WHERE owner_id = ${user.userId}`;
  const clinicIds = clinics.map(c => c.id as string);
  const assignClinic = clinicIds[0] ?? null;

  const bcrypt = await import('bcryptjs');
  const tempPass = Math.random().toString(36).slice(-10) + 'A1!';
  const passwordHash = await bcrypt.hash(tempPass, 10);

  try {
    const [created] = await sql`
      INSERT INTO users (name, email, phone, role, department, specialty,
                         clinic_id, invited_by_user_id, approval_status,
                         password_hash, approved_at)
      VALUES (${name.trim()}, ${email.trim().toLowerCase()},
              ${phone ?? ''}, ${role ?? 'nurse'},
              ${department ?? ''}, ${specialty ?? ''},
              ${assignClinic}, ${user.userId}, 'approved',
              ${passwordHash}, NOW())
      RETURNING id, name, email, phone, role, specialty, department, clinic_id, created_at
    `;
    auditFromReq(req, 'staff.create', 'user', String(created.id), { clinic: assignClinic });
    res.status(201).json({ ...created, status: 'active' });
  } catch (err: unknown) {
    if ((err as { code?: string }).code === '23505') {
      res.status(409).json({ error: 'A user with this email already exists' });
    } else {
      throw err;
    }
  }
});

// POST /staff/:id/reject
router.post('/:id/reject', async (req: Request, res: Response) => {
  const targetId = Number(req.params.id);
  const reason = (req.body as { reason?: string }).reason ?? 'Not approved by clinic';

  await sql`
    UPDATE users
    SET approval_status = 'rejected', rejection_reason = ${reason}
    WHERE id = ${targetId}
  `;

  auditFromReq(req, 'staff.reject', 'user', String(targetId), { reason });
  res.json({ ok: true });
});

// DELETE /staff/:id — remove staff from clinic
router.delete('/:id', async (req: Request, res: Response) => {
  const user = req.user!;
  const targetId = Number(req.params.id);

  const clinics = await sql`SELECT id FROM clinics WHERE owner_id = ${user.userId}`;
  const clinicIds = clinics.map(c => c.id as string);

  // Only remove staff who belong to this doctor's clinic
  await sql`
    UPDATE users
    SET clinic_id = NULL, approval_status = 'rejected', rejection_reason = 'Removed by doctor'
    WHERE id = ${targetId}
      AND clinic_id = ANY(${clinicIds})
  `;

  res.json({ ok: true });
});

export default router;
