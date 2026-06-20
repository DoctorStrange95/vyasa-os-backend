import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import sql from '../db';

const router = Router();
router.use(requireAuth);

// ─── Get clinics for this user ────────────────────────────────────────────────

router.get('/', async (req: Request, res: Response) => {
  const rows = await sql`SELECT * FROM clinics WHERE owner_id = ${req.user!.userId}`;
  res.json(rows.map(r => ({
    id: r.id, name: r.name, address: r.address, phone: r.phone,
    fee: Number(r.fee), maxPatients: r.max_patients, timings: r.timings,
    schedule: r.schedule, color: r.color,
    beds: r.beds ?? [],
    state: r.state ?? '', city: r.city ?? '', pincode: r.pincode ?? '',
    lat: r.lat != null ? Number(r.lat) : undefined,
    lng: r.lng != null ? Number(r.lng) : undefined,
  })));
});

// ─── Create clinic ────────────────────────────────────────────────────────────

router.post('/', async (req: Request, res: Response) => {
  const d = req.body;
  const [row] = await sql`
    INSERT INTO clinics (id, owner_id, name, address, phone, fee, max_patients, timings, schedule, color, beds,
                         state, city, pincode, lat, lng)
    VALUES (${d.id}, ${req.user!.userId}, ${d.name}, ${d.address ?? ''}, ${d.phone ?? ''},
            ${d.fee ?? 200}, ${d.maxPatients ?? 30}, ${d.timings ?? ''},
            ${JSON.stringify(d.schedule ?? [])}, ${d.color ?? '#0d9488'},
            ${JSON.stringify(d.beds ?? [])},
            ${d.state ?? ''}, ${d.city ?? ''}, ${d.pincode ?? ''},
            ${d.lat != null ? Number(d.lat) : null}, ${d.lng != null ? Number(d.lng) : null})
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name, address = EXCLUDED.address, phone = EXCLUDED.phone,
      fee = EXCLUDED.fee, max_patients = EXCLUDED.max_patients, timings = EXCLUDED.timings,
      schedule = EXCLUDED.schedule, color = EXCLUDED.color, beds = EXCLUDED.beds,
      state = EXCLUDED.state, city = EXCLUDED.city, pincode = EXCLUDED.pincode,
      lat = EXCLUDED.lat, lng = EXCLUDED.lng
    RETURNING *
  `;
  res.status(201).json(row);
});

// ─── Update clinic ────────────────────────────────────────────────────────────

router.patch('/:id', async (req: Request, res: Response) => {
  const d = req.body;
  const [row] = await sql`
    UPDATE clinics SET
      name = COALESCE(${d.name ?? null}, name),
      address = COALESCE(${d.address ?? null}, address),
      phone = COALESCE(${d.phone ?? null}, phone),
      fee = COALESCE(${d.fee ?? null}, fee),
      max_patients = COALESCE(${d.maxPatients ?? null}, max_patients),
      timings = COALESCE(${d.timings ?? null}, timings),
      schedule = COALESCE(${d.schedule ? JSON.stringify(d.schedule) : null}::jsonb, schedule),
      color = COALESCE(${d.color ?? null}, color),
      beds = COALESCE(${d.beds != null ? JSON.stringify(d.beds) : null}::jsonb, beds)
    WHERE id = ${req.params.id} AND owner_id = ${req.user!.userId}
    RETURNING *
  `;
  if (!row) { res.status(404).json({ error: 'Clinic not found' }); return; }
  res.json(row);
});

// ─── Delete clinic ────────────────────────────────────────────────────────────

router.delete('/:id', async (req: Request, res: Response) => {
  const doctorId = req.user!.userId;
  const clinicId = req.params.id;

  const [row] = await sql`
    DELETE FROM clinics WHERE id = ${clinicId} AND owner_id = ${doctorId}
    RETURNING id
  `;
  if (!row) { res.status(404).json({ error: 'Clinic not found' }); return; }

  // Find the doctor's next remaining clinic (after deletion)
  const [next] = await sql`
    SELECT id FROM clinics WHERE owner_id = ${doctorId} LIMIT 1
  `;

  // Update the doctor's own clinic_id pointer so the backfill migration
  // doesn't recreate the deleted clinic on backend restart
  await sql`
    UPDATE users SET clinic_id = ${next?.id ?? null}
    WHERE id = ${doctorId} AND clinic_id = ${clinicId}
  `;

  // Reassign all approved staff whose clinic_id pointed to the deleted clinic.
  // Also stamp invited_by_user_id so they remain visible even if reassigned to null.
  await sql`
    UPDATE users SET
      clinic_id = ${next?.id ?? null},
      invited_by_user_id = COALESCE(invited_by_user_id, ${doctorId})
    WHERE clinic_id = ${clinicId}
      AND role NOT IN ('clinic_admin', 'superadmin')
      AND approval_status = 'approved'
  `;

  res.status(204).end();
});

// ─── Get pad settings ─────────────────────────────────────────────────────────

router.get('/pad', async (req: Request, res: Response) => {
  const [row] = await sql`SELECT * FROM pad_settings WHERE user_id = ${req.user!.userId}`;
  if (!row) {
    res.json({});
    return;
  }
  res.json({
    doctorName: row.doctor_name,
    degrees: row.degrees,
    specialty: row.specialty,
    regNumber: row.reg_number,
    address: row.address,
    phone: row.phone,
    email: row.email,
    timings: row.timings,
    clinicName: row.clinic_name,
    footerNote: row.footer_note,
    quote: row.quote,
    showQuote: row.show_quote,
    showTimings: row.show_timings,
    theme: row.theme,
    customFields: row.custom_fields,
    eSignUrl: row.e_sign_url ?? '',
  });
});

// ─── Save pad settings ────────────────────────────────────────────────────────

router.put('/pad', async (req: Request, res: Response) => {
  const d = req.body;
  const userId = req.user!.userId;
  await sql`
    INSERT INTO pad_settings (user_id, doctor_name, degrees, specialty, reg_number, address, phone, email,
      timings, clinic_name, footer_note, quote, show_quote, show_timings, theme, custom_fields, e_sign_url, updated_at)
    VALUES (${userId}, ${d.doctorName ?? ''}, ${d.degrees ?? ''}, ${d.specialty ?? ''},
            ${d.regNumber ?? ''}, ${d.address ?? ''}, ${d.phone ?? ''}, ${d.email ?? ''},
            ${d.timings ?? ''}, ${d.clinicName ?? ''}, ${d.footerNote ?? ''},
            ${d.quote ?? ''}, ${d.showQuote ?? false}, ${d.showTimings ?? true},
            ${d.theme ?? 'teal'}, ${JSON.stringify(d.customFields ?? [])}, ${d.eSignUrl ?? ''}, NOW())
    ON CONFLICT (user_id) DO UPDATE SET
      doctor_name = EXCLUDED.doctor_name, degrees = EXCLUDED.degrees,
      specialty = EXCLUDED.specialty, reg_number = EXCLUDED.reg_number,
      address = EXCLUDED.address, phone = EXCLUDED.phone, email = EXCLUDED.email,
      timings = EXCLUDED.timings, clinic_name = EXCLUDED.clinic_name,
      footer_note = EXCLUDED.footer_note, quote = EXCLUDED.quote,
      show_quote = EXCLUDED.show_quote, show_timings = EXCLUDED.show_timings,
      theme = EXCLUDED.theme, custom_fields = EXCLUDED.custom_fields,
      e_sign_url = EXCLUDED.e_sign_url, updated_at = NOW()
  `;
  res.json({ ok: true });
});

export default router;
