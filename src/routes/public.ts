import { Router, Request, Response } from 'express';
import sql from '../db';

const router = Router();

// GET /public/doctor/:slug — no auth required
router.get('/doctor/:slug', async (req: Request, res: Response) => {
  const { slug } = req.params;
  try {
    const rows = await sql`
      SELECT u.id, u.name, u.specialty, u.degrees, u.reg_number,
             u.bio, u.languages, u.accepting_patients, u.gbp_url,
             u.years_experience, u.consultation_fee, u.profile_slug,
             u.public_profile_enabled,
             p.doctor_name, p.clinic_name, p.address, p.phone, p.email, p.timings
      FROM users u
      LEFT JOIN pad_settings p ON p.user_id = u.id
      WHERE u.profile_slug = ${slug}
        AND u.public_profile_enabled = true
        AND u.approval_status = 'approved'
    `;
    if (!rows.length) return res.status(404).json({ error: 'Doctor not found' });
    const r = rows[0];
    res.json({
      id: r.id,
      name: r.doctor_name || r.name,
      specialty: r.specialty || '',
      qualification: r.degrees || '',
      regNumber: r.reg_number || '',
      bio: r.bio || '',
      languages: r.languages || '',
      acceptingPatients: r.accepting_patients !== false,
      gbpUrl: r.gbp_url || '',
      yearsExperience: r.years_experience || 0,
      consultationFee: r.consultation_fee || null,
      profileSlug: r.profile_slug,
      clinicName: r.clinic_name || '',
      clinicAddress: r.address || '',
      clinicPhone: r.phone || '',
      clinicEmail: r.email || '',
      timings: r.timings || '',
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /public/doctor/:slug/book — no auth required
router.post('/doctor/:slug/book', async (req: Request, res: Response) => {
  const { slug } = req.params;
  const { patient_name, patient_phone, patient_age, reason, preferred_date, preferred_time } = req.body;
  if (!patient_name?.trim() || !patient_phone?.trim()) {
    return res.status(400).json({ error: 'Name and phone are required' });
  }
  try {
    const doctors = await sql`SELECT id FROM users WHERE profile_slug = ${slug} AND public_profile_enabled = true`;
    if (!doctors.length) return res.status(404).json({ error: 'Doctor not found' });
    const doctorId = doctors[0].id;
    const [row] = await sql`
      INSERT INTO booking_requests (doctor_id, patient_name, patient_phone, patient_age, reason, preferred_date, preferred_time)
      VALUES (${doctorId}, ${patient_name.trim()}, ${patient_phone.trim()},
              ${patient_age || null}, ${reason || ''}, ${preferred_date || null}, ${preferred_time || null})
      RETURNING id, status, created_at
    `;
    res.status(201).json({ ok: true, id: row.id, status: row.status });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /public/doctor/:slug/slots — available slot dates (next 14 days)
router.get('/doctor/:slug/slots', async (req: Request, res: Response) => {
  const { slug } = req.params;
  try {
    const doctors = await sql`
      SELECT u.id, u.clinic_id FROM users u
      WHERE u.profile_slug = ${slug} AND u.public_profile_enabled = true
    `;
    if (!doctors.length) return res.status(404).json({ error: 'Doctor not found' });
    const clinicId = doctors[0].clinic_id;
    const clinic = clinicId ? await sql`SELECT schedule, timings FROM clinics WHERE id = ${clinicId}` : [];
    res.json({ schedule: clinic[0]?.schedule ?? [], timings: clinic[0]?.timings ?? '' });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
