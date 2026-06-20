import { Router, Request, Response } from 'express';
import sql from '../db';
import { sendMail, newBookingDoctorEmail } from '../lib/mailer';
import { waNewBookingDoctor } from '../lib/whatsapp';

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

// IST = UTC+5:30. Server runs in UTC so all date/time ops need +330 min offset.
function istNow(): Date {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000);
}
function dateStr(offsetDays = 0): string {
  const d = istNow();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}
function istTimeStr(): string {
  return istNow().toISOString().slice(11, 16); // HH:MM in IST
}

// ─── GET /public/doctor/:slug ─────────────────────────────────────────────────
router.get('/doctor/:slug', async (req: Request, res: Response) => {
  const { slug } = req.params;
  try {
    const rows = await sql`
      SELECT u.id, u.name, u.specialty, u.degrees,
             CASE WHEN u.show_reg_number = true THEN COALESCE(u.reg_number, u.license_number, p.reg_number) ELSE '' END AS reg_number,
             u.bio, u.languages, u.accepting_patients, u.gbp_url,
             u.years_experience, u.consultation_fee, u.profile_slug,
             u.public_profile_enabled, u.profile_photo_url, u.clinic_id,
             u.education, u.services, u.awards,
             u.advance_payment, u.advance_amount, u.payment_qr_url,
             p.doctor_name, p.clinic_name, p.address, p.phone, p.email, p.timings
      FROM users u
      LEFT JOIN pad_settings p ON p.user_id = u.id
      WHERE u.profile_slug = ${slug}
        AND u.public_profile_enabled = true
        AND u.approval_status = 'approved'
    `;
    if (!rows.length) { res.status(404).json({ error: 'Doctor not found' }); return; }
    const r = rows[0];

    // Fetch ALL clinics this doctor is associated with:
    // primary clinic_id, clinics they own, and clinics they were invited to
    const clinicIds: string[] = [];
    if (r.clinic_id) clinicIds.push(r.clinic_id as string);

    const staffRows = await sql`SELECT invited_clinic_ids FROM users WHERE id = ${r.id}`;
    if (staffRows[0]?.invited_clinic_ids) {
      const extra = (staffRows[0].invited_clinic_ids as string).split(',').map((s: string) => s.trim()).filter(Boolean);
      for (const cid of extra) if (!clinicIds.includes(cid)) clinicIds.push(cid);
    }

    const clinics = await sql`
      SELECT DISTINCT id, name, address, phone, timings, schedule,
                      state, city, pincode, lat, lng
      FROM clinics
      WHERE id = ANY(${clinicIds.length ? clinicIds : ['__none__']}) OR owner_id = ${r.id}
    `;

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
      education: r.education || '',
      services: r.services || '',
      awards: r.awards || '',
      // Advance payment (QR shown to patients only when enabled with an amount)
      advancePayment: r.advance_payment === true && Number(r.advance_amount) > 0,
      advanceAmount: r.advance_payment === true ? (r.advance_amount ?? null) : null,
      paymentQrUrl: r.advance_payment === true ? (r.payment_qr_url || '') : '',
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
        state: c.state || '',
        city: c.city || '',
        pincode: c.pincode || '',
        lat: c.lat != null ? Number(c.lat) : null,
        lng: c.lng != null ? Number(c.lng) : null,
        hasSchedule: Array.isArray(c.schedule) && (c.schedule as { open?: boolean }[]).some(d => d.open),
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
  const requestedClinic = (req.query.clinic_id as string | undefined)?.trim() || null;

  try {
    const doctors = await sql`
      SELECT u.id, u.clinic_id FROM users u
      WHERE u.profile_slug = ${slug} AND u.public_profile_enabled = true
        AND u.accepting_patients = true
    `;
    if (!doctors.length) { res.status(404).json({ error: 'Doctor not found or not accepting patients' }); return; }

    const doctorId = doctors[0].id as number;
    const clinicId = doctors[0].clinic_id as string | null;

    // With ?clinic_id= use only that chamber's schedule; otherwise merge all.
    // (Either way, booked-slot conflicts are checked per DOCTOR — they can't
    // be in two chambers at the same time.)
    const clinicRows = requestedClinic
      ? await sql`
          SELECT schedule, max_patients FROM clinics
          WHERE id = ${requestedClinic}
            AND (id = ${clinicId ?? '__none__'} OR owner_id = ${doctorId})
        `
      : await sql`
          SELECT schedule, max_patients FROM clinics
          WHERE id = ${clinicId ?? '__none__'} OR owner_id = ${doctorId}
        `;
    if (requestedClinic && !clinicRows.length) {
      res.status(404).json({ error: 'Clinic not found for this doctor' }); return;
    }
    // Merge per-day: a day is open if ANY clinic is open; sessions are unioned
    const schedule: DaySchedule[] = [];
    for (let day = 0; day < 7; day++) {
      const merged: DaySchedule = { day, open: false, sessions: [], maxPatients: 0 };
      for (const row of clinicRows) {
        const cs = (row.schedule as DaySchedule[]) ?? [];
        const ds = cs.find(s => s.day === day);
        if (ds?.open && ds.sessions?.length) {
          merged.open = true;
          for (const sess of ds.sessions) {
            if (!merged.sessions.some(s => s.start === sess.start && s.end === sess.end)) {
              merged.sessions.push(sess);
            }
          }
          merged.maxPatients += ds.maxPatients ?? (row.max_patients as number) ?? 20;
        }
      }
      merged.sessions.sort((a, b) => a.start.localeCompare(b.start));
      if (merged.open) schedule.push(merged);
    }
    const globalCap = clinicRows.reduce((acc, r) => acc + ((r.max_patients as number) ?? 20), 0) || 20;

    // Dates we'll generate slots for — start today, one entry per day
    const targetDates = Array.from({ length: days }, (_, i) => dateStr(i));

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

      // Filter out slots that are already filled or in the past (compare in IST)
      const nowDate = dateStr(0);
      const nowTime = istTimeStr();

      const available = allSlots.filter(t => {
        if (date === nowDate && t <= nowTime) return false; // past slot today (IST)
        return (dayBooked[t] ?? 0) === 0; // not already booked
      });

      const remaining = Math.max(0, cap - totalBooked);
      // Return all pickable times; totalSlots carries the cap so the date card shows
      // the patient limit rather than the raw time-interval count
      if (available.length > 0 && remaining > 0) {
        result.push({ date, slots: available, totalSlots: cap, bookedCount: totalBooked });
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
  const { patient_name, patient_phone, patient_email, patient_age, patient_gender, reason, preferred_date, preferred_time, clinic_id } = req.body;

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

    // Validate the chosen chamber belongs to this doctor (ignore if not)
    let bookClinic: string | null = null;
    if (clinic_id) {
      const owned = await sql`
        SELECT c.id FROM clinics c
        JOIN users u ON u.id = ${doctorId}
        WHERE c.id = ${clinic_id} AND (c.owner_id = ${doctorId} OR c.id = u.clinic_id)
      `;
      if (owned.length) bookClinic = clinic_id as string;
    }

    const genderVal = ['M', 'F', 'Other'].includes(patient_gender as string) ? (patient_gender as string) : 'M';
    const [row] = await sql`
      INSERT INTO booking_requests
        (doctor_id, clinic_id, patient_name, patient_phone, patient_email, patient_age, patient_gender, reason, preferred_date, preferred_time)
      VALUES
        (${doctorId}, ${bookClinic}, ${patient_name.trim()}, ${patient_phone.replace(/\D/g, '').slice(-10)},
         ${(patient_email as string | undefined)?.trim() || ''},
         ${patient_age ? Number(patient_age) : null}, ${genderVal}, ${reason?.trim() || ''},
         ${preferred_date}, ${preferred_time})
      RETURNING id, status, created_at
    `;

    // Notify the doctor by email + WhatsApp (fire-and-forget)
    try {
      const [doc] = await sql`
        SELECT u.name, u.email, u.phone, c.name AS clinic_name
        FROM users u LEFT JOIN clinics c ON c.id = ${bookClinic}
        WHERE u.id = ${doctorId}
      `;
      const cleanPhone = patient_phone.replace(/\D/g, '').slice(-10);
      if (doc?.email) {
        const mail = newBookingDoctorEmail({
          doctorName: doc.name as string,
          patientName: patient_name.trim(),
          patientPhone: cleanPhone,
          date: preferred_date, time: preferred_time,
          clinicName: (doc.clinic_name as string) || undefined,
          reason: reason?.trim() || undefined,
        });
        sendMail(doc.email as string, mail.subject, mail.html);
      }
      if (doc?.phone) {
        waNewBookingDoctor(doc.phone as string, {
          patientName: patient_name.trim(), patientPhone: cleanPhone,
          date: preferred_date, time: preferred_time,
        });
      }
    } catch (e) { console.error('[booking notify]', e); }

    res.status(201).json({ ok: true, id: row.id, status: row.status });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /public/doctors/featured — homepage carousel ─────────────────────────
router.get('/doctors/featured', async (req: Request, res: Response) => {
  try {
    const scheduleExists = sql`
      EXISTS (
        SELECT 1 FROM clinics c2, jsonb_array_elements(c2.schedule) d
        WHERE (c2.owner_id = u.id OR c2.id = u.clinic_id)
          AND (d->>'open')::boolean
      )`;

    // Completeness score: profile photo heavily weighted
    const completeness = sql`
      (CASE WHEN u.profile_photo_url IS NOT NULL AND u.profile_photo_url != '' THEN 5 ELSE 0 END
       + CASE WHEN u.bio IS NOT NULL AND LENGTH(u.bio) > 20 THEN 2 ELSE 0 END
       + CASE WHEN u.years_experience IS NOT NULL AND u.years_experience > 0 THEN 1 ELSE 0 END
       + CASE WHEN u.city IS NOT NULL AND u.city != '' THEN 1 ELSE 0 END
       + CASE WHEN u.consultation_fee IS NOT NULL THEN 1 ELSE 0 END
       + CASE WHEN u.specialty IS NOT NULL AND u.specialty != '' THEN 1 ELSE 0 END)`;

    // Single query — is_featured first, then photo, then completeness
    const rows = await sql`
      SELECT u.id, u.name, u.specialty, u.degrees, u.profile_slug, u.profile_photo_url,
             u.years_experience, u.consultation_fee, u.accepting_patients, u.city, u.state,
             u.bio, u.is_featured,
             p.doctor_name, p.clinic_name, p.address, p.timings, p.phone,
             ${scheduleExists} AS has_schedule,
             ${completeness} AS completeness
      FROM users u
      LEFT JOIN pad_settings p ON p.user_id = u.id
      WHERE u.public_profile_enabled = true
        AND u.approval_status = 'approved'
        AND u.profile_slug IS NOT NULL
      ORDER BY
        u.is_featured DESC NULLS LAST,
        (CASE WHEN u.profile_photo_url IS NOT NULL AND u.profile_photo_url != '' THEN 1 ELSE 0 END) DESC,
        completeness DESC
      LIMIT 5
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
        bookingOpen: r.accepting_patients !== false && r.has_schedule === true,
        city: r.city || '',
        state: r.state || '',
        clinicName: r.clinic_name || '',
        clinicPhone: r.phone || '',
        timings: r.timings || '',
        bio: (r.bio as string)?.slice(0, 120) || '',
        isFeatured: r.is_featured === true,
      })),
    });
  } catch (err) {
    console.error('[public/doctors/featured]', err);
    res.status(500).json({ error: 'Failed to load featured doctors' });
  }
});

// ─── GET /public/doctors — doctor directory (no auth) ────────────────────────
router.get('/doctors', async (req: Request, res: Response) => {
  const { state, city, specialty, search, limit = '50', offset = '0' } = req.query as Record<string, string>;
  try {
    // Build all filters without dynamic SQL — use nullable params pattern
    const rows = await sql`
      SELECT u.id, u.name, u.specialty, u.degrees,
             u.profile_slug, u.profile_photo_url,
             u.years_experience, u.consultation_fee,
             u.accepting_patients, u.city, u.state,
             u.bio,
             p.doctor_name, p.clinic_name, p.address, p.timings, p.phone,
             EXISTS (
               SELECT 1 FROM clinics c2, jsonb_array_elements(c2.schedule) d
               WHERE (c2.owner_id = u.id OR c2.id = u.clinic_id)
                 AND (d->>'open')::boolean
             ) AS has_schedule
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
        // True only when the doctor has at least one clinic with an open weekly schedule
        bookingOpen: r.accepting_patients !== false && r.has_schedule === true,
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

// ─── GET /public/sitemap.xml — all public doctor profiles for search engines ─
const APP_ORIGIN = 'https://app.vyasaa.com';

router.get('/sitemap.xml', async (_req: Request, res: Response) => {
  try {
    const rows = await sql`
      SELECT profile_slug FROM users
      WHERE public_profile_enabled = true
        AND approval_status = 'approved'
        AND profile_slug IS NOT NULL AND profile_slug != ''
      ORDER BY profile_slug
    `;
    const urls = rows
      .map(r => `  <url>\n    <loc>${APP_ORIGIN}/dr/${encodeURIComponent(r.profile_slug as string)}</loc>\n    <changefreq>weekly</changefreq>\n    <priority>0.8</priority>\n  </url>`)
      .join('\n');
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(xml);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
