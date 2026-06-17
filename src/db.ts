import { neon } from '@neondatabase/serverless';
import 'dotenv/config';

const sql = neon(process.env.DATABASE_URL!);

export default sql;

// ─── Schema migration (run once on startup) ───────────────────────────────────

export async function runMigrations() {
  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT DEFAULT '',
      role TEXT NOT NULL DEFAULT 'clinic_admin',
      specialty TEXT,
      degrees TEXT,
      phone TEXT,
      reg_number TEXT,
      license_number TEXT,
      clinic_id TEXT,
      approval_status TEXT NOT NULL DEFAULT 'pending',
      rejection_reason TEXT,
      google_id TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS clinics (
      id TEXT PRIMARY KEY,
      owner_id INTEGER REFERENCES users(id),
      name TEXT NOT NULL,
      address TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      fee NUMERIC DEFAULT 200,
      max_patients INTEGER DEFAULT 30,
      timings TEXT DEFAULT '',
      schedule JSONB DEFAULT '[]',
      color TEXT DEFAULT '#0d9488',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS pad_settings (
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE PRIMARY KEY,
      doctor_name TEXT DEFAULT '',
      degrees TEXT DEFAULT '',
      specialty TEXT DEFAULT '',
      reg_number TEXT DEFAULT '',
      address TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      email TEXT DEFAULT '',
      timings TEXT DEFAULT '',
      clinic_name TEXT DEFAULT '',
      footer_note TEXT DEFAULT '',
      quote TEXT DEFAULT '',
      show_quote BOOLEAN DEFAULT false,
      show_timings BOOLEAN DEFAULT true,
      theme TEXT DEFAULT 'teal',
      custom_fields JSONB DEFAULT '[]',
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS patients (
      id TEXT PRIMARY KEY,
      clinic_id TEXT NOT NULL,
      name TEXT NOT NULL,
      age INTEGER,
      gender TEXT DEFAULT 'M',
      mrn TEXT,
      phone TEXT,
      email TEXT,
      blood_group TEXT,
      status TEXT DEFAULT 'OPD',
      priority TEXT DEFAULT 'Stable',
      ward TEXT,
      bed TEXT,
      admit_date TEXT,
      discharge_date TEXT,
      diagnosis TEXT,
      allergies JSONB DEFAULT '[]',
      insurance TEXT,
      attending_doctor TEXT,
      attending_doctor_id INTEGER,
      assigned_nurse_id INTEGER,
      assigned_nurse_name TEXT,
      death_date TEXT,
      death_cause TEXT,
      referred_hospital TEXT,
      referred_dept TEXT,
      referred_doctor TEXT,
      referral_reason TEXT,
      referral_urgency TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS visits (
      id TEXT PRIMARY KEY,
      patient_id TEXT NOT NULL,
      clinic_id TEXT NOT NULL,
      date TEXT NOT NULL,
      doctor_name TEXT NOT NULL,
      doctor_id INTEGER,
      data JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS vitals (
      id TEXT PRIMARY KEY,
      patient_id TEXT NOT NULL,
      clinic_id TEXT NOT NULL,
      time TEXT NOT NULL,
      recorded_by TEXT DEFAULT '',
      bp TEXT,
      pulse NUMERIC,
      temp NUMERIC,
      spo2 NUMERIC,
      rr NUMERIC,
      weight NUMERIC,
      height NUMERIC,
      gcs NUMERIC,
      sugar NUMERIC,
      notes TEXT,
      alert BOOLEAN DEFAULT false
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS appointments (
      id TEXT PRIMARY KEY,
      clinic_id TEXT NOT NULL,
      patient_id TEXT,
      patient_name TEXT NOT NULL,
      patient_age INTEGER,
      doctor_id INTEGER,
      doctor_name TEXT,
      date TEXT NOT NULL,
      time TEXT NOT NULL,
      reason TEXT DEFAULT '',
      status TEXT DEFAULT 'scheduled',
      notes TEXT,
      consultation_fee NUMERIC DEFAULT 0,
      amount_paid NUMERIC DEFAULT 0,
      payment_mode TEXT,
      token INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      patient_id TEXT,
      clinic_id TEXT NOT NULL,
      sender_id INTEGER,
      sender_name TEXT NOT NULL,
      sender_role TEXT DEFAULT 'doctor',
      message TEXT NOT NULL,
      type TEXT DEFAULT 'message',
      time TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      token TEXT UNIQUE NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  // Indexes for common queries
  await sql`CREATE INDEX IF NOT EXISTS idx_patients_clinic ON patients(clinic_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_visits_patient ON visits(patient_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_vitals_patient ON vitals(patient_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_appointments_clinic_date ON appointments(clinic_id, date)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_chat_clinic ON chat_messages(clinic_id)`;

  // Column additions for existing tables
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS reg_state TEXT`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS state TEXT`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS city TEXT`;

  // Login session audit log
  await sql`
    CREATE TABLE IF NOT EXISTS login_sessions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      user_name TEXT,
      user_email TEXT,
      user_role TEXT,
      logged_in_at TIMESTAMPTZ DEFAULT NOW(),
      ip_address TEXT,
      user_agent TEXT,
      lat DOUBLE PRECISION,
      lng DOUBLE PRECISION,
      location_label TEXT
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_login_sessions_user ON login_sessions(user_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_login_sessions_time ON login_sessions(logged_in_at DESC)`;

  // Store which doctor's clinic(s) a staff member was invited to
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS invited_clinic_ids TEXT`;
  // Store invited clinic display name(s) for reference
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS invited_clinic_name TEXT`;

  // Backfill: create a clinic record for any clinic_admin who has a clinic_id but no row in clinics
  const orphanDoctors = await sql`
    SELECT u.id, u.name, u.clinic_id
    FROM users u
    LEFT JOIN clinics c ON c.id = u.clinic_id
    WHERE u.role = 'clinic_admin'
      AND u.clinic_id IS NOT NULL
      AND c.id IS NULL
  `;
  for (const doc of orphanDoctors) {
    await sql`
      INSERT INTO clinics (id, owner_id, name, address, fee, max_patients)
      VALUES (${doc.clinic_id}, ${doc.id}, ${doc.name + "'s Clinic"}, '', 200, 30)
      ON CONFLICT DO NOTHING
    `;
  }

  // Backfill: assign a clinic_id to clinic_admin users who have none at all
  const noClinics = await sql`
    SELECT id, name FROM users WHERE role = 'clinic_admin' AND clinic_id IS NULL
  `;
  for (const doc of noClinics) {
    const clinicId = `clinic_${doc.id}`;
    await sql`
      INSERT INTO clinics (id, owner_id, name, address, fee, max_patients)
      VALUES (${clinicId}, ${doc.id}, ${(doc.name as string) + "'s Clinic"}, '', 200, 30)
      ON CONFLICT DO NOTHING
    `;
    await sql`UPDATE users SET clinic_id = ${clinicId} WHERE id = ${doc.id}`;
    await sql`
      INSERT INTO pad_settings (user_id, doctor_name, clinic_name)
      VALUES (${doc.id}, ${doc.name}, ${(doc.name as string) + "'s Clinic"})
      ON CONFLICT (user_id) DO NOTHING
    `;
  }

  // Locality field for patients (area/neighbourhood)
  await sql`ALTER TABLE patients ADD COLUMN IF NOT EXISTS locality TEXT`;

  // Clinic location fields — patients pick a chamber by location when booking
  await sql`ALTER TABLE clinics ADD COLUMN IF NOT EXISTS state TEXT DEFAULT ''`;
  await sql`ALTER TABLE clinics ADD COLUMN IF NOT EXISTS city TEXT DEFAULT ''`;
  await sql`ALTER TABLE clinics ADD COLUMN IF NOT EXISTS pincode TEXT DEFAULT ''`;
  await sql`ALTER TABLE clinics ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION`;
  await sql`ALTER TABLE clinics ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION`;

  // Beds config per clinic (JSONB array of { id, number, ward, type })
  await sql`ALTER TABLE clinics ADD COLUMN IF NOT EXISTS beds JSONB DEFAULT '[]'`;

  // Audit log — every action by every user
  await sql`
    CREATE TABLE IF NOT EXISTS audit_log (
      id BIGSERIAL PRIMARY KEY,
      actor_id INTEGER,
      actor_name TEXT,
      actor_role TEXT,
      clinic_id TEXT,
      action TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT,
      details JSONB,
      ip_address TEXT,
      user_agent TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_audit_clinic ON audit_log(clinic_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_audit_resource ON audit_log(resource_type, resource_id)`;

  // ── Public Profile fields on users ────────────────────────────────────────
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_slug TEXT UNIQUE`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT DEFAULT ''`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS languages TEXT DEFAULT ''`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS accepting_patients BOOLEAN DEFAULT true`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS public_profile_enabled BOOLEAN DEFAULT true`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS gbp_url TEXT DEFAULT ''`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS years_experience INTEGER DEFAULT 0`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS consultation_fee INTEGER`;
  await sql`ALTER TABLE clinics ADD COLUMN IF NOT EXISTS public_enabled BOOLEAN DEFAULT true`;

  // Auto-generate profile_slug for clinic_admin users who don't have one
  const noSlug = await sql`SELECT id, name FROM users WHERE role = 'clinic_admin' AND profile_slug IS NULL`;
  for (const u of noSlug) {
    const base = (u.name as string).toLowerCase().replace(/^dr\.?\s+/i, '').replace(/[^a-z0-9\s]/g, '').trim().replace(/\s+/g, '-').slice(0, 80);
    let slug = base, n = 2;
    while (true) {
      const existing = await sql`SELECT id FROM users WHERE profile_slug = ${slug}`;
      if (!existing.length) break;
      slug = `${base}-${n++}`;
    }
    await sql`UPDATE users SET profile_slug = ${slug} WHERE id = ${u.id}`;
  }

  // ── Booking requests table ─────────────────────────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS booking_requests (
      id BIGSERIAL PRIMARY KEY,
      doctor_id INTEGER NOT NULL REFERENCES users(id),
      clinic_id TEXT,
      patient_name TEXT NOT NULL,
      patient_phone TEXT NOT NULL,
      patient_age INTEGER,
      reason TEXT DEFAULT '',
      preferred_date TEXT,
      preferred_time TEXT,
      status TEXT DEFAULT 'pending',
      notes TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      confirmed_at TIMESTAMPTZ,
      confirmed_by INTEGER
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_booking_requests_doctor ON booking_requests(doctor_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_booking_requests_status ON booking_requests(doctor_id, status)`;

  // Doctor public profile photo
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_photo_url TEXT`;

  // Patient email on bookings (for confirmation emails)
  await sql`ALTER TABLE booking_requests ADD COLUMN IF NOT EXISTS patient_email TEXT DEFAULT ''`;

  // Advance payment settings + payment QR (UPI) for doctors
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS advance_payment BOOLEAN DEFAULT false`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS advance_amount INTEGER`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS payment_qr_url TEXT`;

  // Privacy: hide registration/MCI number from public profile (default hidden)
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS show_reg_number BOOLEAN DEFAULT false`;

  // Doctor social-presence fields: education history, services offered, awards
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS education TEXT DEFAULT ''`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS services TEXT DEFAULT ''`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS awards TEXT DEFAULT ''`;

  // Approval/Rejection timestamps
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ`;

  // Backfill reg_number from license_number for users who registered via the MCI/CI field
  await sql`
    UPDATE users SET reg_number = license_number
    WHERE license_number IS NOT NULL AND license_number != ''
      AND (reg_number IS NULL OR reg_number = '')
  `;
  await sql`
    UPDATE pad_settings ps SET reg_number = u.license_number
    FROM users u WHERE u.id = ps.user_id
      AND u.license_number IS NOT NULL AND u.license_number != ''
      AND (ps.reg_number IS NULL OR ps.reg_number = '')
  `;

  // User profile fields missing from original schema
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS clinic_name TEXT DEFAULT ''`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS department TEXT DEFAULT ''`;

  // ── Backfill: create appointments for all existing confirmed booking_requests ─
  // Only creates rows where no appointment with id 'BOOK-{id}-...' already exists
  const confirmedBookings = await sql`
    SELECT br.*, cl.id AS fallback_clinic_id
    FROM booking_requests br
    LEFT JOIN clinics cl ON cl.owner_id = br.doctor_id
    WHERE br.status = 'confirmed' AND br.preferred_date IS NOT NULL
  `;
  for (const b of confirmedBookings) {
    const aptId = `BOOK-${b.id}`;
    const existing = await sql`SELECT id FROM appointments WHERE id LIKE ${aptId + '%'} LIMIT 1`;
    if (existing.length > 0) continue;
    const clinicId = (b.clinic_id as string | null) ?? (b.fallback_clinic_id as string | null);
    if (!clinicId) continue;
    await sql`
      INSERT INTO appointments
        (id, clinic_id, patient_id, patient_name, patient_age, doctor_id, date, time, reason, status)
      VALUES
        (${aptId}, ${clinicId}, NULL, ${b.patient_name as string},
         ${b.patient_age ? Number(b.patient_age) : null}, ${b.doctor_id as number},
         ${b.preferred_date as string}, ${(b.preferred_time as string | null) ?? '09:00'},
         ${(b.reason as string | null) ?? 'OPD Appointment'}, 'scheduled')
      ON CONFLICT DO NOTHING
    `.catch((e: Error) => console.error('[backfill booking→apt]', b.id, e.message));
  }

  console.log('✅ DB migrations complete');
}

// Run as standalone: npx tsx src/db.ts
if (require.main === module) {
  runMigrations().catch(console.error).finally(() => process.exit());
}
