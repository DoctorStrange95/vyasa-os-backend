import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import sql from '../db';

const router = Router();
router.use(requireAuth);

function istDateStr(offsetDays = 0): string {
  const d = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

router.get('/', async (req: Request, res: Response) => {
  const { date, from, to } = req.query;
  const userId = req.user!.userId;
  const clinicId = req.user!.clinicId;

  // Return appointments for ALL clinics this doctor owns, or where they're the doctor
  let rows;
  if (date) {
    rows = await sql`
      SELECT a.*, cl.name AS clinic_name FROM appointments a
      LEFT JOIN clinics cl ON cl.id = a.clinic_id
      WHERE (a.doctor_id = ${userId} OR a.clinic_id IN (SELECT id FROM clinics WHERE owner_id = ${userId}) OR a.clinic_id = ${clinicId})
        AND a.date = ${date as string} ORDER BY a.time`;
  } else if (from && to) {
    rows = await sql`
      SELECT a.*, cl.name AS clinic_name FROM appointments a
      LEFT JOIN clinics cl ON cl.id = a.clinic_id
      WHERE (a.doctor_id = ${userId} OR a.clinic_id IN (SELECT id FROM clinics WHERE owner_id = ${userId}) OR a.clinic_id = ${clinicId})
        AND a.date >= ${from as string} AND a.date <= ${to as string} ORDER BY a.date, a.time`;
  } else {
    const today = istDateStr(0);
    const future = istDateStr(30);
    rows = await sql`
      SELECT a.*, cl.name AS clinic_name FROM appointments a
      LEFT JOIN clinics cl ON cl.id = a.clinic_id
      WHERE (a.doctor_id = ${userId} OR a.clinic_id IN (SELECT id FROM clinics WHERE owner_id = ${userId}) OR a.clinic_id = ${clinicId})
        AND a.date >= ${today} AND a.date <= ${future} ORDER BY a.date, a.time`;
  }

  res.json(rows.map(r => ({
    id: r.id,
    patientId: r.patient_id,
    patientName: r.patient_name,
    patientAge: r.patient_age,
    clinicId: r.clinic_id,
    clinicName: r.clinic_name ?? null,
    doctorId: r.doctor_id,
    doctorName: r.doctor_name,
    date: r.date,
    time: r.time,
    reason: r.reason,
    status: r.status,
    notes: r.notes,
    consultationFee: r.consultation_fee,
    amountPaid: r.amount_paid,
    paymentMode: r.payment_mode,
    token: r.token,
    createdAt: r.created_at,
  })));
});

router.post('/', async (req: Request, res: Response) => {
  const d = req.body;
  const clinicId = req.user!.clinicId;
  const userId = req.user!.userId;

  const [row] = await sql`
    INSERT INTO appointments (id, clinic_id, patient_id, patient_name, patient_age, doctor_id, doctor_name,
      date, time, reason, status, notes, consultation_fee, amount_paid, payment_mode, token)
    VALUES (
      ${d.id}, ${clinicId}, ${d.patientId ?? null}, ${d.patientName}, ${d.patientAge ?? null},
      ${userId}, ${d.doctorName ?? null},
      ${d.date}, ${d.time}, ${d.reason ?? ''}, ${d.status ?? 'scheduled'},
      ${d.notes ?? null}, ${d.consultationFee ?? 0}, ${d.amountPaid ?? 0},
      ${d.paymentMode ?? null}, ${d.token ?? null}
    )
    ON CONFLICT (id) DO UPDATE SET
      status = EXCLUDED.status, notes = EXCLUDED.notes,
      amount_paid = EXCLUDED.amount_paid, payment_mode = EXCLUDED.payment_mode,
      patient_id = EXCLUDED.patient_id, reason = EXCLUDED.reason,
      consultation_fee = EXCLUDED.consultation_fee, token = EXCLUDED.token
    RETURNING *
  `;
  res.status(201).json(row);
});

router.patch('/:id', async (req: Request, res: Response) => {
  const d = req.body;
  const userId = req.user!.userId;
  // Allow update if: doctor owns the clinic, is the assigned doctor, or it's their primary clinic
  const [row] = await sql`
    UPDATE appointments SET
      status = COALESCE(${d.status ?? null}, status),
      amount_paid = COALESCE(${d.amountPaid ?? null}, amount_paid),
      payment_mode = COALESCE(${d.paymentMode ?? null}, payment_mode),
      notes = COALESCE(${d.notes ?? null}, notes),
      patient_id = COALESCE(${d.patientId ?? null}, patient_id)
    WHERE id = ${req.params.id}
      AND (
        doctor_id = ${userId}
        OR clinic_id IN (SELECT id FROM clinics WHERE owner_id = ${userId})
        OR clinic_id = ${req.user!.clinicId}
      )
    RETURNING *
  `;
  if (!row) { res.status(404).json({ error: 'Appointment not found' }); return; }
  res.json(row);
});

router.delete('/:id', async (req: Request, res: Response) => {
  await sql`DELETE FROM appointments WHERE id = ${req.params.id} AND clinic_id = ${req.user!.clinicId}`;
  res.json({ ok: true });
});

export default router;
