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
router.get('/patient/:patientId', async (req, res) => {
    const rows = await (0, db_1.default) `
    SELECT * FROM vitals
    WHERE patient_id = ${req.params.patientId} AND clinic_id = ${req.user.clinicId}
    ORDER BY time DESC
    LIMIT 50
  `;
    res.json(rows.map(r => ({
        id: r.id, patientId: r.patient_id, time: r.time, recordedBy: r.recorded_by,
        bp: r.bp, pulse: r.pulse, temp: r.temp, spo2: r.spo2, rr: r.rr,
        weight: r.weight, height: r.height, gcs: r.gcs, sugar: r.sugar,
        notes: r.notes, alert: r.alert,
    })));
});
router.post('/', async (req, res) => {
    const d = req.body;
    const clinicId = req.user.clinicId;
    const [row] = await (0, db_1.default) `
    INSERT INTO vitals (id, patient_id, clinic_id, time, recorded_by, bp, pulse, temp, spo2, rr, weight, height, gcs, sugar, notes, alert)
    VALUES (
      ${d.id}, ${d.patientId}, ${clinicId}, ${d.time}, ${d.recordedBy ?? ''},
      ${d.bp ?? null}, ${d.pulse ?? null}, ${d.temp ?? null}, ${d.spo2 ?? null}, ${d.rr ?? null},
      ${d.weight ?? null}, ${d.height ?? null}, ${d.gcs ?? null}, ${d.sugar ?? null},
      ${d.notes ?? null}, ${d.alert ?? false}
    )
    ON CONFLICT (id) DO UPDATE SET
      bp = EXCLUDED.bp, pulse = EXCLUDED.pulse, temp = EXCLUDED.temp,
      spo2 = EXCLUDED.spo2, rr = EXCLUDED.rr, weight = EXCLUDED.weight,
      height = EXCLUDED.height, gcs = EXCLUDED.gcs, sugar = EXCLUDED.sugar,
      notes = EXCLUDED.notes, alert = EXCLUDED.alert
    RETURNING *
  `;
    res.status(201).json(row);
});
router.delete('/:id', async (req, res) => {
    await (0, db_1.default) `DELETE FROM vitals WHERE id = ${req.params.id} AND clinic_id = ${req.user.clinicId}`;
    res.json({ ok: true });
});
exports.default = router;
