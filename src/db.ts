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

  console.log('✅ DB migrations complete');
}

// Run as standalone: npx tsx src/db.ts
if (require.main === module) {
  runMigrations().catch(console.error).finally(() => process.exit());
}
