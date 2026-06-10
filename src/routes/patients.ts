import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import sql from '../db';
import { maybeEncrypt, maybeDecrypt } from '../lib/crypto';
import { auditFromReq } from '../lib/audit';

const router = Router();
router.use(requireAuth);

function decryptPatient(p: Record<string, unknown>): Record<string, unknown> {
  return {
    ...p,
    name: maybeDecrypt(p.name as string),
    phone: maybeDecrypt(p.phone as string),
    diagnosis: maybeDecrypt(p.diagnosis as string),
  };
}

// ─── List patients for clinic ─────────────────────────────────────────────────

router.get('/', async (req: Request, res: Response) => {
  const clinicId = req.user!.clinicId;
  const rows = await sql`
    SELECT * FROM patients WHERE clinic_id = ${clinicId}
    ORDER BY created_at DESC
  `;
  const patients = rows.map(decryptPatient);
  auditFromReq(req, 'patient.read', 'patients', clinicId, { count: patients.length });
  res.json(patients);
});

// ─── Single patient ───────────────────────────────────────────────────────────

router.get('/:id', async (req: Request, res: Response) => {
  const [p] = await sql`
    SELECT * FROM patients WHERE id = ${req.params.id} AND clinic_id = ${req.user!.clinicId}
  `;
  if (!p) { res.status(404).json({ error: 'Patient not found' }); return; }
  auditFromReq(req, 'patient.read', 'patient', req.params.id);
  res.json(decryptPatient(p as Record<string, unknown>));
});

// ─── Create / Upsert patient ──────────────────────────────────────────────────

router.post('/', async (req: Request, res: Response) => {
  const clinicId = req.user!.clinicId;
  const d = req.body;

  const encName = maybeEncrypt(d.name);
  const encPhone = maybeEncrypt(d.phone ?? null);
  const encDiagnosis = maybeEncrypt(d.diagnosis ?? null);

  const [patient] = await sql`
    INSERT INTO patients (
      id, clinic_id, name, age, gender, mrn, phone, email, blood_group,
      status, priority, ward, bed, admit_date, discharge_date, diagnosis, allergies,
      insurance, attending_doctor, attending_doctor_id, assigned_nurse_id, assigned_nurse_name,
      death_date, death_cause, referred_hospital, referred_dept, referred_doctor,
      referral_reason, referral_urgency, locality
    ) VALUES (
      ${d.id}, ${clinicId}, ${encName}, ${d.age ?? null}, ${d.gender ?? 'M'}, ${d.mrn ?? null},
      ${encPhone}, ${d.email ?? null}, ${d.bloodGroup ?? null},
      ${d.status ?? 'OPD'}, ${d.priority ?? 'Stable'}, ${d.ward ?? null}, ${d.bed ?? null},
      ${d.admitDate ?? null}, ${d.dischargeDate ?? null}, ${encDiagnosis},
      ${JSON.stringify(d.allergies ?? [])},
      ${d.insurance ?? null}, ${d.attendingDoctor ?? null}, ${d.attendingDoctorId ?? null},
      ${d.assignedNurseId ?? null}, ${d.assignedNurseName ?? null},
      ${d.deathDate ?? null}, ${d.deathCause ?? null}, ${d.referredHospital ?? null},
      ${d.referredDept ?? null}, ${d.referredDoctor ?? null},
      ${d.referralReason ?? null}, ${d.referralUrgency ?? null}, ${d.locality ?? null}
    )
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name, age = EXCLUDED.age, gender = EXCLUDED.gender,
      phone = EXCLUDED.phone, email = EXCLUDED.email, blood_group = EXCLUDED.blood_group,
      status = EXCLUDED.status, priority = EXCLUDED.priority,
      ward = EXCLUDED.ward, bed = EXCLUDED.bed, admit_date = EXCLUDED.admit_date,
      discharge_date = EXCLUDED.discharge_date, diagnosis = EXCLUDED.diagnosis,
      allergies = EXCLUDED.allergies, insurance = EXCLUDED.insurance,
      attending_doctor = EXCLUDED.attending_doctor, attending_doctor_id = EXCLUDED.attending_doctor_id,
      assigned_nurse_id = EXCLUDED.assigned_nurse_id, assigned_nurse_name = EXCLUDED.assigned_nurse_name,
      death_date = EXCLUDED.death_date, death_cause = EXCLUDED.death_cause,
      referred_hospital = EXCLUDED.referred_hospital, referred_dept = EXCLUDED.referred_dept,
      referred_doctor = EXCLUDED.referred_doctor, referral_reason = EXCLUDED.referral_reason,
      referral_urgency = EXCLUDED.referral_urgency, locality = EXCLUDED.locality, updated_at = NOW()
    RETURNING *
  `;

  auditFromReq(req, 'patient.create', 'patient', d.id, { mrn: d.mrn, status: d.status });
  res.status(201).json(decryptPatient(patient as Record<string, unknown>));
});

// ─── Update patient ───────────────────────────────────────────────────────────

router.patch('/:id', async (req: Request, res: Response) => {
  const d = req.body;
  const encName = d.name != null ? maybeEncrypt(d.name) : null;
  const encPhone = d.phone != null ? maybeEncrypt(d.phone) : null;
  const encDiagnosis = d.diagnosis != null ? maybeEncrypt(d.diagnosis) : null;

  const [patient] = await sql`
    UPDATE patients SET
      name = COALESCE(${encName}, name),
      age = COALESCE(${d.age ?? null}, age),
      gender = COALESCE(${d.gender ?? null}, gender),
      phone = COALESCE(${encPhone}, phone),
      email = COALESCE(${d.email ?? null}, email),
      blood_group = COALESCE(${d.bloodGroup ?? null}, blood_group),
      status = COALESCE(${d.status ?? null}, status),
      priority = COALESCE(${d.priority ?? null}, priority),
      ward = COALESCE(${d.ward ?? null}, ward),
      bed = COALESCE(${d.bed ?? null}, bed),
      admit_date = COALESCE(${d.admitDate ?? null}, admit_date),
      discharge_date = COALESCE(${d.dischargeDate ?? null}, discharge_date),
      diagnosis = COALESCE(${encDiagnosis}, diagnosis),
      allergies = COALESCE(${d.allergies ? JSON.stringify(d.allergies) : null}::jsonb, allergies),
      insurance = COALESCE(${d.insurance ?? null}, insurance),
      attending_doctor = COALESCE(${d.attendingDoctor ?? null}, attending_doctor),
      death_date = COALESCE(${d.deathDate ?? null}, death_date),
      death_cause = COALESCE(${d.deathCause ?? null}, death_cause),
      referred_hospital = COALESCE(${d.referredHospital ?? null}, referred_hospital),
      referred_dept = COALESCE(${d.referredDept ?? null}, referred_dept),
      referred_doctor = COALESCE(${d.referredDoctor ?? null}, referred_doctor),
      referral_reason = COALESCE(${d.referralReason ?? null}, referral_reason),
      referral_urgency = COALESCE(${d.referralUrgency ?? null}, referral_urgency),
      updated_at = NOW()
    WHERE id = ${req.params.id} AND clinic_id = ${req.user!.clinicId}
    RETURNING *
  `;
  if (!patient) { res.status(404).json({ error: 'Patient not found' }); return; }

  auditFromReq(req, 'patient.update', 'patient', req.params.id, {
    fields: Object.keys(d).filter(k => d[k] != null),
  });
  res.json(decryptPatient(patient as Record<string, unknown>));
});

// ─── Delete patient ───────────────────────────────────────────────────────────

router.delete('/:id', async (req: Request, res: Response) => {
  await sql`
    DELETE FROM patients WHERE id = ${req.params.id} AND clinic_id = ${req.user!.clinicId}
  `;
  auditFromReq(req, 'patient.delete', 'patient', req.params.id);
  res.json({ ok: true });
});

export default router;
