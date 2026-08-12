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
// ─── Save a prescription (or batch) ──────────────────────────────────────────
router.post('/', async (req, res) => {
    const doctorId = req.user.userId;
    const clinicId = req.user.clinicId;
    // Accept a single object or an array
    const items = Array.isArray(req.body) ? req.body : [req.body];
    const saved = [];
    for (const rx of items) {
        const { id, patientId, visitId, drug, dose, route: rxRoute, frequency, duration, instructions, status, time, prescribedBy } = rx;
        if (!id || !patientId || !drug)
            continue;
        const [row] = await (0, db_1.default) `
      INSERT INTO prescriptions
        (id, patient_id, visit_id, clinic_id, doctor_id, doctor_name,
         drug, dose, route, frequency, duration, instructions, status, prescribed_at)
      VALUES
        (${id}, ${patientId}, ${visitId ?? null}, ${clinicId}, ${doctorId},
         ${prescribedBy ?? null}, ${drug}, ${dose ?? ''}, ${rxRoute ?? ''},
         ${frequency ?? ''}, ${duration ?? ''}, ${instructions ?? null},
         ${status ?? 'active'}, ${time ?? new Date().toISOString()})
      ON CONFLICT (id) DO UPDATE SET
        status       = EXCLUDED.status,
        instructions = EXCLUDED.instructions
      RETURNING *
    `;
        saved.push(row);
    }
    res.json({ ok: true, saved });
});
// ─── Get all prescriptions for the clinic (doctor + their staff portals) ─────
router.get('/clinic', async (req, res) => {
    const userId = req.user.userId;
    const clinicId = req.user.clinicId;
    const rows = await (0, db_1.default) `
    SELECT * FROM prescriptions
    WHERE clinic_id IN (SELECT id FROM clinics WHERE owner_id = ${userId})
       OR clinic_id = ${clinicId}
    ORDER BY prescribed_at DESC
    LIMIT 1000
  `;
    res.json(rows.map(r => ({
        id: r.id,
        patientId: r.patient_id,
        drug: r.drug,
        dose: r.dose,
        route: r.route,
        frequency: r.frequency,
        duration: r.duration,
        instructions: r.instructions,
        prescribedBy: r.doctor_name,
        time: r.prescribed_at,
        status: r.status,
    })));
});
// ─── Get prescriptions for a patient ─────────────────────────────────────────
router.get('/patient/:patientId', async (req, res) => {
    const rows = await (0, db_1.default) `
    SELECT * FROM prescriptions
    WHERE patient_id = ${req.params.patientId}
      AND clinic_id  = ${req.user.clinicId}
    ORDER BY prescribed_at DESC
  `;
    res.json(rows);
});
// ─── Update prescription status ───────────────────────────────────────────────
router.patch('/:id/status', async (req, res) => {
    const { status } = req.body;
    await (0, db_1.default) `
    UPDATE prescriptions SET status = ${status}
    WHERE id = ${req.params.id} AND clinic_id = ${req.user.clinicId}
  `;
    res.json({ ok: true });
});
exports.default = router;
