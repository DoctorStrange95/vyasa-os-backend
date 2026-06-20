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
  const clinics = await sql`SELECT id FROM clinics WHERE owner_id = ${req.user!.userId}`;
  let myClinicIds = clinics.map(c => c.id as string);

  // Fallback: if no clinics found in clinics table, use the clinic_id from the user's own record
  // (handles doctors who never synced their local padStore clinics to the backend)
  if (myClinicIds.length === 0) {
    const [doctor] = await sql`SELECT clinic_id FROM users WHERE id = ${req.user!.userId}`;
    if (doctor?.clinic_id) myClinicIds = [doctor.clinic_id as string];
  }

  const pending = await sql`
    SELECT id, name, email, phone, role, degrees, specialty,
           invited_clinic_ids, invited_clinic_name, created_at
    FROM users
    WHERE approval_status = 'pending'
      AND role NOT IN ('clinic_admin', 'superadmin', 'patient')
    ORDER BY created_at DESC
  `;
  const scoped = pending.filter(p => {
    // decodeURIComponent handles the case where the invite link was double-encoded
    // (e.g. shared via WhatsApp converting %2C → %252C, making split(',') fail)
    const raw = decodeURIComponent((p.invited_clinic_ids as string | null) ?? '');
    const invited = raw.split(',').map(s => s.trim()).filter(Boolean);
    if (invited.length === 0) return true; // legacy registration with no invite metadata
    return myClinicIds.length === 0 || invited.some(id => myClinicIds.includes(id));
  });
  res.json(scoped);
});

// GET /staff/active — returns approved staff belonging to the doctor's clinics
router.get('/active', async (req: Request, res: Response) => {
  const user = req.user!;
  const clinics = await sql`SELECT id FROM clinics WHERE owner_id = ${user.userId}`;
  const clinicIds = clinics.map(c => c.id as string);

  if (clinicIds.length === 0) {
    res.json([]);
    return;
  }

  const active = await sql`
    SELECT id, name, email, phone, role, degrees, specialty, clinic_id, created_at
    FROM users
    WHERE approval_status = 'approved'
      AND role != 'clinic_admin'
      AND role != 'superadmin'
      AND clinic_id = ANY(${clinicIds})
    ORDER BY name
  `;

  res.json(active);
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
  const [target] = await sql`SELECT id, invited_clinic_ids FROM users WHERE id = ${targetId}`;
  if (!target) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  const invitedIds = (target.invited_clinic_ids as string | null)?.split(',').map(s => s.trim()).filter(Boolean) ?? [];
  const matchedClinic = clinicIds.find(id => invitedIds.includes(id));

  // If they were explicitly invited to a different doctor's clinic, refuse —
  // silently absorbing someone else's staff would be wrong.
  if (!matchedClinic && invitedIds.length > 0) {
    res.status(403).json({ error: 'This staff member was invited to a different clinic.' });
    return;
  }

  // Legacy registrations with no invite metadata: assign to this doctor's first clinic
  const assignClinic = matchedClinic ?? clinicIds[0];

  await sql`
    UPDATE users
    SET approval_status = 'approved', clinic_id = ${assignClinic}
    WHERE id = ${targetId}
  `;

  auditFromReq(req, 'staff.approve', 'user', String(targetId), { clinicId: assignClinic });
  res.json({ ok: true, clinicId: assignClinic });
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
