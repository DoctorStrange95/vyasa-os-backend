import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import sql from '../db';

const router = Router();
router.use(requireAuth);

// ─── Save a prescription (or batch) ──────────────────────────────────────────

router.post('/', async (req: Request, res: Response) => {
  const doctorId  = req.user!.userId;
  const clinicId  = req.user!.clinicId;

  // Accept a single object or an array
  const items = Array.isArray(req.body) ? req.body : [req.body];

  const saved: unknown[] = [];

  for (const rx of items) {
    const { id, patientId, visitId, drug, dose, route: rxRoute, frequency,
            duration, instructions, status, time, prescribedBy } = rx as Record<string, string>;

    if (!id || !patientId || !drug) continue;

    const [row] = await sql`
      INSERT INTO prescriptions
        (id, patient_id, visit_id, clinic_id, doctor_id, doctor_name,
         drug, dose, route, frequency, duration, instructions, status, prescribed_at)
      VALUES
        (${id}, ${patientId}, ${visitId ?? null}, ${clinicId}, ${doctorId},
         ${prescribedBy ?? null}, ${drug}, ${dose ?? ''}, ${rxRoute ?? ''},
         ${frequency ?? ''}, ${duration ?? ''}, ${instructions ?? null},
         ${status ?? 'active'}, ${time ?? new Date().toISOString()})
      ON CONFLICT (id) DO UPDATE SET
        status       = EXCLUDED.status,
        instructions = EXCLUDED.instructions
      RETURNING *
    `;
    saved.push(row);
  }

  res.json({ ok: true, saved });
});

// ─── Get prescriptions for a patient ─────────────────────────────────────────

router.get('/patient/:patientId', async (req: Request, res: Response) => {
  const rows = await sql`
    SELECT * FROM prescriptions
    WHERE patient_id = ${req.params.patientId}
      AND clinic_id  = ${req.user!.clinicId}
    ORDER BY prescribed_at DESC
  `;
  res.json(rows);
});

// ─── Update prescription status ───────────────────────────────────────────────

router.patch('/:id/status', async (req: Request, res: Response) => {
  const { status } = req.body as { status: string };
  await sql`
    UPDATE prescriptions SET status = ${status}
    WHERE id = ${req.params.id} AND clinic_id = ${req.user!.clinicId}
  `;
  res.json({ ok: true });
});

export default router;
