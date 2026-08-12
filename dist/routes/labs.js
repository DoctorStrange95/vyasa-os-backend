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
// ─── Create lab order ─────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
    const doctorId = req.user.userId;
    const clinicId = req.user.clinicId;
    const { id, patientId, testName, panel, orderedBy, orderedAt, status, urgency } = req.body;
    if (!id || !patientId || !testName)
        return res.status(400).json({ error: 'id, patientId, testName required' });
    const [row] = await (0, db_1.default) `
    INSERT INTO lab_orders (id, patient_id, clinic_id, doctor_id, test_name, panel, ordered_by, ordered_at, status, urgency)
    VALUES (${id}, ${patientId}, ${clinicId}, ${doctorId}, ${testName}, ${panel ?? null}, ${orderedBy ?? null}, ${orderedAt}, ${status ?? 'ordered'}, ${urgency ?? null})
    ON CONFLICT (id) DO NOTHING
    RETURNING *
  `;
    res.json({ ok: true, row });
});
// ─── Get all lab orders for the clinic (doctor + their staff portals) ────────
router.get('/clinic', async (req, res) => {
    const userId = req.user.userId;
    const clinicId = req.user.clinicId;
    const rows = await (0, db_1.default) `
    SELECT * FROM lab_orders
    WHERE clinic_id IN (SELECT id FROM clinics WHERE owner_id = ${userId})
       OR clinic_id = ${clinicId}
    ORDER BY ordered_at DESC
    LIMIT 1000
  `;
    res.json(rows.map(r => ({
        id: r.id,
        patientId: r.patient_id,
        testName: r.test_name,
        panel: r.panel,
        orderedBy: r.ordered_by,
        orderedAt: r.ordered_at,
        status: r.status,
        urgency: r.urgency,
        result: r.result,
        unit: r.unit,
        refRange: r.ref_range,
        critical: r.critical,
        resultTime: r.result_time,
        reportDataUrl: r.report_data_url,
    })));
});
// ─── Get lab orders for a patient ────────────────────────────────────────────
router.get('/patient/:patientId', async (req, res) => {
    const rows = await (0, db_1.default) `
    SELECT * FROM lab_orders
    WHERE patient_id = ${req.params.patientId}
      AND clinic_id  = ${req.user.clinicId}
    ORDER BY ordered_at DESC
  `;
    res.json(rows);
});
// ─── Enter / update result ────────────────────────────────────────────────────
router.patch('/:id/result', async (req, res) => {
    const { result, unit, refRange, critical, resultTime, reportDataUrl, status } = req.body;
    await (0, db_1.default) `
    UPDATE lab_orders SET
      result         = ${result ?? null},
      unit           = ${unit ?? null},
      ref_range      = ${refRange ?? null},
      critical       = ${critical ?? false},
      result_time    = ${resultTime ?? new Date().toISOString()},
      report_data_url = ${reportDataUrl ?? null},
      status         = ${status ?? 'resulted'}
    WHERE id = ${req.params.id}
      AND clinic_id = ${req.user.clinicId}
  `;
    res.json({ ok: true });
});
exports.default = router;
