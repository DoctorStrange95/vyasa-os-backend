"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const db_1 = __importDefault(require("../db"));
const router = (0, express_1.Router)();
router.use(auth_1.requireAuth);
function istDateStr(offsetDays = 0) {
    const d = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
    d.setDate(d.getDate() + offsetDays);
    return d.toISOString().slice(0, 10);
}
router.get('/', async (req, res) => {
    const { date, from, to } = req.query;
    const userId = req.user.userId;
    const clinicId = req.user.clinicId;
    // Return appointments for ALL clinics this doctor owns, or where they're the doctor
    let rows;
    if (date) {
        rows = await (0, db_1.default) `
      SELECT a.*, cl.name AS clinic_name FROM appointments a
      LEFT JOIN clinics cl ON cl.id = a.clinic_id
      WHERE (a.doctor_id = ${userId} OR a.clinic_id IN (SELECT id FROM clinics WHERE owner_id = ${userId}) OR a.clinic_id = ${clinicId})
        AND a.date = ${date} ORDER BY a.time`;
    }
    else if (from && to) {
        rows = await (0, db_1.default) `
      SELECT a.*, cl.name AS clinic_name FROM appointments a
      LEFT JOIN clinics cl ON cl.id = a.clinic_id
      WHERE (a.doctor_id = ${userId} OR a.clinic_id IN (SELECT id FROM clinics WHERE owner_id = ${userId}) OR a.clinic_id = ${clinicId})
        AND a.date >= ${from} AND a.date <= ${to} ORDER BY a.date, a.time`;
    }
    else {
        const today = istDateStr(0);
        const future = istDateStr(30);
        rows = await (0, db_1.default) `
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
        patientGender: r.patient_gender ?? 'M',
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
        consultationType: r.consultation_type ?? 'offline',
        googleMeetLink: r.google_meet_link ?? '',
        durationMins: r.duration_mins ?? 30,
    })));
});
router.post('/', async (req, res) => {
    const d = req.body;
    const clinicId = req.user.clinicId;
    const userId = req.user.userId;
    const [row] = await (0, db_1.default) `
    INSERT INTO appointments (id, clinic_id, patient_id, patient_name, patient_age, patient_gender, doctor_id, doctor_name,
      date, time, reason, status, notes, consultation_fee, amount_paid, payment_mode, token,
      consultation_type, google_meet_link, google_calendar_event_id, duration_mins)
    VALUES (
      ${d.id}, ${clinicId}, ${d.patientId ?? null}, ${d.patientName}, ${d.patientAge ?? null},
      ${d.patientGender ?? 'M'},
      ${userId}, ${d.doctorName ?? null},
      ${d.date}, ${d.time}, ${d.reason ?? ''}, ${d.status ?? 'scheduled'},
      ${d.notes ?? null}, ${d.consultationFee ?? 0}, ${d.amountPaid ?? 0},
      ${d.paymentMode ?? null}, ${d.token ?? null},
      ${d.consultationType ?? 'offline'},
      ${d.googleMeetLink ?? ''},
      ${d.googleCalendarEventId ?? ''},
      ${d.durationMins ?? 30}
    )
    ON CONFLICT (id) DO UPDATE SET
      status = EXCLUDED.status, notes = EXCLUDED.notes,
      amount_paid = EXCLUDED.amount_paid, payment_mode = EXCLUDED.payment_mode,
      patient_id = EXCLUDED.patient_id, reason = EXCLUDED.reason,
      consultation_fee = EXCLUDED.consultation_fee, token = EXCLUDED.token,
      consultation_type = EXCLUDED.consultation_type,
      google_meet_link = EXCLUDED.google_meet_link
    RETURNING *
  `;
    res.status(201).json(row);
});
router.patch('/:id', async (req, res) => {
    const d = req.body;
    const userId = req.user.userId;
    // Allow update if: doctor owns the clinic, is the assigned doctor, or it's their primary clinic
    const [row] = await (0, db_1.default) `
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
        OR clinic_id = ${req.user.clinicId}
      )
    RETURNING *
  `;
    if (!row) {
        res.status(404).json({ error: 'Appointment not found' });
        return;
    }
    res.json(row);
});
router.delete('/:id', async (req, res) => {
    await (0, db_1.default) `DELETE FROM appointments WHERE id = ${req.params.id} AND clinic_id = ${req.user.clinicId}`;
    res.json({ ok: true });
});
exports.default = router;
