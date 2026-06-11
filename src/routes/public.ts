import { Router, Request, Response } from 'express';
import sql from '../db';

const router = Router();

// ─── Types mirrored from frontend ────────────────────────────────────────────
interface DaySchedule {
  day: number;       // 0=Sun…6=Sat
  open: boolean;
  sessions: { start: string; end: string }[];
  maxPatients: number;
}

// Generate HH:MM time slots between start and end at given interval (minutes)
function generateSlots(start: string, end: string, intervalMins = 15): string[] {
  const slots: string[] = [];
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  let cur = sh * 60 + sm;
  const endMin = eh * 60 + em;
  while (cur + intervalMins <= endMin) {
    const h = Math.floor(cur / 60).toString().padStart(2, '0');
    const m = (cur % 60).toString().padStart(2, '0');
    slots.push(`${h}:${m}`);
    cur += intervalMins;
  }
  return slots;
}

// Return YYYY-MM-DD for today + n days (UTC+5:30 friendly)
function dateStr(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

// ─── GET /public/doctor/:slug ─────────────────────────────────────────────────
router.get('/doctor/:slug', async (req: Request, res: Response) => {
  const { slug } = req.params;
  try {
    const rows = await sql`
      SELECT u.id, u.name, u.specialty, u.degrees,
             COALESCE(u.reg_number, u.license_number) AS reg_number,
             u.bio, u.languages, u.accepting_patients, u.gbp_url,
             u.years_experience, u.consultation_fee, u.profile_slug,
             u.public_profile_enabled, u.profile_photo_url, u.clinic_id,
             p.doctor_name, p.clinic_name, p.address, p.phone, p.email, p.timings
      FROM users u
      LEFT JOIN pad_settings p ON p.user_id = u.id
      WHERE u.profile_slug = ${slug}
        AND u.public_profile_enabled = true
        AND u.approval_status = 'approved'
    `;
    if (!rows.length) { res.status(404).json({ error: 'Doctor not found' }); return; }
    const r = rows[0];

    // Fetch ALL clinics this doctor is associated with
    const clinicIds: string[] = [];
    if (r.clinic_id) clinicIds.push(r.clinic_id as string);

    // Also check invited_clinic_ids (staff working in multiple clinics)
    const staffRows = await sql`SELECT invited_clinic_ids FROM users WHERE id = ${r.id}`;
    if (staffRows[0]?.invited_clinic_ids) {
      const extra = (staffRows[0].invited_clinic_ids as string).split(',').map((s: string) => s.trim()).filter(Boolean);
      for (const cid of extra) if (!clinicIds.includes(cid)) clinicIds.push(cid);
    }

    const clinics = clinicIds.length
      ? await sql`SELECT id, name, address, phone, timings, schedule FROM clinics WHERE id = ANY(${clinicIds})`
      : [];

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
      profilePhotoUrl: r.profile_photo_url || '',
      // Primary clinic (from pad_settings for display)
      clinicName: r.clinic_name || '',
      clinicAddress: r.address || '',
      clinicPhone: r.phone || '',
      clinicEmail: r.email || '',
      timings: r.timings || '',
      // All clinics
      clinics: clinics.map(c => ({
        id: c.id,
        name: c.name,
        address: c.address || '',
        phone: c.phone || '',
        timings: c.timings || '',
      })),
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /public/doctor/:slug/slots?days=14&interval=15 ──────────────────────
// Returns available time slots per day for the next N days
router.get('/doctor/:slug/slots', async (req: Request, res: Response) => {
  const { slug } = req.params;
  const days = Math.min(Number(req.query.days ?? 14), 30);
  const interval = Number(req.query.interval ?? 15); // slot duration in minutes

  try {
    const doctors = await sql`
      SELECT u.id, u.clinic_id FROM users u
      WHERE u.profile_slug = ${slug} AND u.public_profile_enabled = true
        AND u.accepting_patients = true
    `;
    if (!doctors.length) { res.status(404).json({ error: 'Doctor not found or not accepting patients' }); return; }

    const doctorId = doctors[0].id as number;
    const clinicId = doctors[0].clinic_id as string | null;

    // Fetch clinic schedule (JSONB) + max patients per day
    const clinicRows = clinicId
      ? await sql`SELECT schedule, max_patients FROM clinics WHERE id = ${clinicId}`
      : [];
    const schedule: DaySchedule[] = (clinicRows[0]?.schedule as DaySchedule[]) ?? [];
    const globalCap = (clinicRows[0]?.max_patients as number) ?? 20;

    // Dates we'll generate slots for
    const targetDates = Array.from({ length: days }, (_, i) => dateStr(i === 0 ? 1 : i)); // start tomorrow

    // Fetch already-booked slots in that range (booking_requests + appointments)
    const fromDate = targetDates[0];
    const toDate = targetDates[targetDates.length - 1];

    const bookedRequests = await sql`
      SELECT preferred_date, preferred_time, status FROM booking_requests
      WHERE doctor_id = ${doctorId}
        AND preferred_date >= ${fromDate} AND preferred_date <= ${toDate}
        AND status IN ('pending', 'confirmed')
    `;
    const bookedAppointments = await sql`
      SELECT date, time, status FROM appointments
      WHERE doctor_id = ${doctorId}
        AND date >= ${fromDate} AND date <= ${toDate}
        AND status NOT IN ('cancelled', 'no-show')
    `;

    // Build a booked count map: { "2026-06-12": { "09:00": 2, "09:15": 1 } }
    const bookedMap: Record<string, Record<string, number>> = {};
    for (const r of [...bookedRequests, ...bookedAppointments]) {
      const d = (r.preferred_date ?? r.date) as string;
      const t = ((r.preferred_time ?? r.time) as string)?.slice(0, 5) ?? '';
      if (!d || !t) continue;
      if (!bookedMap[d]) bookedMap[d] = {};
      bookedMap[d][t] = (bookedMap[d][t] ?? 0) + 1;
    }

    // Build per-day availability
    const result: { date: string; slots: string[]; totalSlots: number; bookedCount: number }[] = [];

    for (const date of targetDates) {
      const dayOfWeek = new Date(date + 'T00:00:00').getDay(); // 0=Sun
      const daySchedule = schedule.find(s => s.day === dayOfWeek);

      if (!daySchedule?.open || !daySchedule.sessions?.length) continue;

      const cap = daySchedule.maxPatients ?? globalCap;
      const dayBooked = bookedMap[date] ?? {};
      const totalBooked = Object.values(dayBooked).reduce((a, b) => a + b, 0);

      if (totalBooked >= cap) continue; // day fully booked

      const allSlots: string[] = [];
      for (const session of daySchedule.sessions) {
        allSlots.push(...generateSlots(session.start, session.end, interval));
      }

      // Filter out slots that are already filled or in the past
      const now = new Date();
      const nowDate = now.toISOString().slice(0, 10);
      const nowTime = now.toTimeString().slice(0, 5);

      const available = allSlots.filter(t => {
        if (date === nowDate && t <= nowTime) return false; // past slot today
        return (dayBooked[t] ?? 0) === 0; // not already booked
      });

      if (available.length > 0) {
        result.push({ date, slots: available, totalSlots: allSlots.length, bookedCount: totalBooked });
      }
    }

    res.json({ days: result, interval });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /public/doctor/:slug/book ──────────────────────────────────────────
router.post('/doctor/:slug/book', async (req: Request, res: Response) => {
  const { slug } = req.params;
  const { patient_name, patient_phone, patient_age, reason, preferred_date, preferred_time } = req.body;

  if (!patient_name?.trim() || !patient_phone?.trim()) {
    res.status(400).json({ error: 'Name and phone are required' }); return;
  }
  if (!preferred_date || !preferred_time) {
    res.status(400).json({ error: 'Please select an appointment date and time' }); return;
  }

  try {
    const doctors = await sql`
      SELECT id FROM users WHERE profile_slug = ${slug}
        AND public_profile_enabled = true AND accepting_patients = true
    `;
    if (!doctors.length) { res.status(404).json({ error: 'Doctor not found' }); return; }
    const doctorId = doctors[0].id as number;

    // Idempotency: check if exact slot already booked
    const existing = await sql`
      SELECT id FROM booking_requests
      WHERE doctor_id = ${doctorId}
        AND preferred_date = ${preferred_date}
        AND preferred_time = ${preferred_time}
        AND status IN ('pending', 'confirmed')
    `;
    if (existing.length) {
      res.status(409).json({ error: 'This slot was just booked by someone else. Please choose another time.' });
      return;
    }

    const [row] = await sql`
      INSERT INTO booking_requests
        (doctor_id, patient_name, patient_phone, patient_age, reason, preferred_date, preferred_time)
      VALUES
        (${doctorId}, ${patient_name.trim()}, ${patient_phone.replace(/\D/g, '').slice(-10)},
         ${patient_age ? Number(patient_age) : null}, ${reason?.trim() || ''},
         ${preferred_date}, ${preferred_time})
      RETURNING id, status, created_at
    `;
    res.status(201).json({ ok: true, id: row.id, status: row.status });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /public/doctors — doctor directory (no auth) ────────────────────────
router.get('/doctors', async (req: Request, res: Response) => {
  const { state, city, specialty, search, limit = '50', offset = '0' } = req.query as Record<string, string>;
  try {
    // Build all filters without dynamic SQL — use nullable params pattern
    const rows = await sql`
      SELECT u.id, u.name, u.specialty, u.degrees,
             COALESCE(u.reg_number, u.license_number) AS reg_number,
             u.profile_slug, u.profile_photo_url,
             u.years_experience, u.consultation_fee,
             u.accepting_patients, u.city, u.state,
             u.bio,
             p.doctor_name, p.clinic_name, p.address, p.timings, p.phone
      FROM users u
      LEFT JOIN pad_settings p ON p.user_id = u.id
      WHERE u.public_profile_enabled = true
        AND u.approval_status = 'approved'
        AND u.profile_slug IS NOT NULL
        AND (${state ?? null}::text IS NULL OR LOWER(u.state) = LOWER(${state ?? ''}))
        AND (${city ?? null}::text IS NULL OR LOWER(u.city) = LOWER(${city ?? ''}))
        AND (${specialty ?? null}::text IS NULL OR LOWER(u.specialty) ILIKE ${specialty ? `%${specialty}%` : ''})
        AND (${search ?? null}::text IS NULL
             OR LOWER(u.name) ILIKE ${search ? `%${search}%` : ''}
             OR LOWER(u.specialty) ILIKE ${search ? `%${search}%` : ''}
             OR LOWER(u.city) ILIKE ${search ? `%${search}%` : ''}
             OR LOWER(p.clinic_name) ILIKE ${search ? `%${search}%` : ''})
      ORDER BY u.created_at DESC
      LIMIT ${Number(limit)} OFFSET ${Number(offset)}
    `;

    const total = await sql`
      SELECT COUNT(*) AS n FROM users u
      LEFT JOIN pad_settings p ON p.user_id = u.id
      WHERE u.public_profile_enabled = true
        AND u.approval_status = 'approved'
        AND u.profile_slug IS NOT NULL
    `;

    // Fetch distinct states + cities for filter UI
    const states = await sql`
      SELECT DISTINCT state FROM users
      WHERE public_profile_enabled = true AND approval_status = 'approved'
        AND profile_slug IS NOT NULL AND state IS NOT NULL AND state != ''
      ORDER BY state
    `;
    const cities = await sql`
      SELECT DISTINCT city FROM users
      WHERE public_profile_enabled = true AND approval_status = 'approved'
        AND profile_slug IS NOT NULL AND city IS NOT NULL AND city != ''
        AND (${state ?? null}::text IS NULL OR LOWER(state) = LOWER(${state ?? ''}))
      ORDER BY city
    `;
    const specialties = await sql`
      SELECT DISTINCT specialty FROM users
      WHERE public_profile_enabled = true AND approval_status = 'approved'
        AND profile_slug IS NOT NULL AND specialty IS NOT NULL AND specialty != ''
      ORDER BY specialty
    `;

    res.json({
      doctors: rows.map(r => ({
        id: r.id,
        name: r.doctor_name || r.name,
        specialty: r.specialty || '',
        qualification: r.degrees || '',
        profileSlug: r.profile_slug,
        profilePhotoUrl: r.profile_photo_url || '',
        yearsExperience: r.years_experience || 0,
        consultationFee: r.consultation_fee || null,
        acceptingPatients: r.accepting_patients !== false,
        city: r.city || '',
        state: r.state || '',
        clinicName: r.clinic_name || '',
        clinicAddress: r.address || '',
        clinicPhone: r.phone || '',
        timings: r.timings || '',
        bio: (r.bio as string)?.slice(0, 120) || '',
      })),
      total: Number(total[0]?.n ?? 0),
      filters: {
        states: states.map(r => r.state as string),
        cities: cities.map(r => r.city as string),
        specialties: specialties.map(r => r.specialty as string),
      },
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
