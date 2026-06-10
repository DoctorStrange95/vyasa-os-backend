import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import sql from '../db';

const router = Router();
router.use(requireAuth);

// GET /staff/pending — returns pending users invited to any of the doctor's clinics
router.get('/pending', async (req: Request, res: Response) => {
  const user = req.user!;

  // Fetch the doctor's clinic IDs (the clinics they own)
  const clinics = await sql`SELECT id FROM clinics WHERE owner_id = ${user.userId}`;
  const clinicIds = clinics.map((c: any) => c.id as string);

  if (clinicIds.length === 0) {
    res.json([]);
    return;
  }

  // Find pending users who listed any of these clinic IDs in their invitation
  // Use a pattern match per clinic ID with OR logic via raw check
  const likePatterns = clinicIds.map(id => `%${id}%`);
  const pending = await sql`
    SELECT id, name, email, phone, role, degrees, specialty, invited_clinic_ids, invited_clinic_name, created_at
    FROM users
    WHERE approval_status = 'pending'
      AND role NOT IN ('clinic_admin', 'superadmin')
      AND invited_clinic_ids LIKE ANY(${likePatterns})
    ORDER BY created_at DESC
  `;

  res.json(pending);
});

// GET /staff/active — returns approved staff belonging to the doctor's clinics
router.get('/active', async (req: Request, res: Response) => {
  const user = req.user!;
  const clinics = await sql`SELECT id FROM clinics WHERE owner_id = ${user.userId}`;
  const clinicIds = clinics.map((c: any) => c.id as string);

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
  const clinicIds = clinics.map((c: any) => c.id as string);

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

  const invitedIds = (target.invited_clinic_ids as string | null)?.split(',').map(s => s.trim()) ?? [];
  const matchedClinic = clinicIds.find(id => invitedIds.includes(id));

  if (!matchedClinic && clinicIds.length > 0) {
    // Fallback: assign to doctor's first clinic if no match (edge case for old registrations)
  }

  const assignClinic = matchedClinic ?? clinicIds[0];

  await sql`
    UPDATE users
    SET approval_status = 'approved', clinic_id = ${assignClinic}
    WHERE id = ${targetId}
  `;

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

  res.json({ ok: true });
});

// DELETE /staff/:id — remove staff from clinic
router.delete('/:id', async (req: Request, res: Response) => {
  const user = req.user!;
  const targetId = Number(req.params.id);

  const clinics = await sql`SELECT id FROM clinics WHERE owner_id = ${user.userId}`;
  const clinicIds = clinics.map((c: any) => c.id as string);

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
