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
// ─── All visits for a patient ─────────────────────────────────────────────────
router.get('/patient/:patientId', async (req, res) => {
    const userId = req.user.userId;
    const clinicId = req.user.clinicId;
    const visits = await (0, db_1.default) `
    SELECT * FROM visits
    WHERE patient_id = ${req.params.patientId}
      AND (
        clinic_id IN (SELECT id FROM clinics WHERE owner_id = ${userId})
        OR clinic_id = ${clinicId}
        OR doctor_id = ${userId}
      )
    ORDER BY date DESC, created_at DESC
  `;
    // Merge `data` JSONB fields into the row for compatibility with frontend.
    // Spread FIRST so a stray id/date key inside the blob can't clobber real columns.
    const result = visits.map(v => ({
        ...(v.data ?? {}),
        id: v.id,
        patientId: v.patient_id,
        date: v.date,
        doctorName: v.doctor_name,
        doctorId: v.doctor_id,
    }));
    res.json(result);
});
// ─── All visits for clinic (today or given date) ──────────────────────────────
router.get('/clinic', async (req, res) => {
    const { date } = req.query;
    const userId = req.user.userId;
    const clinicId = req.user.clinicId;
    const visits = date
        ? await (0, db_1.default) `
        SELECT * FROM visits
        WHERE (
          clinic_id IN (SELECT id FROM clinics WHERE owner_id = ${userId})
          OR clinic_id = ${clinicId}
          OR doctor_id = ${userId}
        )
          AND date = ${date}
        ORDER BY created_at DESC`
        : await (0, db_1.default) `
        SELECT * FROM visits
        WHERE clinic_id IN (SELECT id FROM clinics WHERE owner_id = ${userId})
           OR clinic_id = ${clinicId}
           OR doctor_id = ${userId}
        ORDER BY date DESC, created_at DESC LIMIT 200`;
    // Map snake_case DB fields to camelCase for frontend
    const result = visits.map(v => ({
        ...(v.data ?? {}),
        id: v.id,
        patientId: v.patient_id,
        date: v.date,
        doctorName: v.doctor_name,
        doctorId: v.doctor_id,
    }));
    res.json(result);
});
// ─── Upsert visit ─────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
    const d = req.body;
    const clinicId = req.user.clinicId;
    // Separate top-level fields from data blob
    const { id, patientId, date, doctorName, doctorId, ...visitData } = d;
    const [visit] = await (0, db_1.default) `
    INSERT INTO visits (id, patient_id, clinic_id, date, doctor_name, doctor_id, data)
    VALUES (${id}, ${patientId}, ${clinicId}, ${date}, ${doctorName}, ${doctorId ?? null}, ${JSON.stringify(visitData)})
    ON CONFLICT (id) DO UPDATE SET
      date = EXCLUDED.date,
      doctor_name = EXCLUDED.doctor_name,
      data = EXCLUDED.data
    RETURNING *
  `;
    res.status(201).json({
        ...(visit.data ?? {}),
        id: visit.id,
        patientId: visit.patient_id,
        date: visit.date,
        doctorName: visit.doctor_name,
    });
});
// ─── Delete visit ─────────────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
    await (0, db_1.default) `
    DELETE FROM visits WHERE id = ${req.params.id} AND clinic_id = ${req.user.clinicId}
  `;
    res.json({ ok: true });
});
exports.default = router;
