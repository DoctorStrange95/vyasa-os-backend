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
router.post('/', async (req, res) => {
    const doctorId = req.user.userId;
    const clinicId = req.user.clinicId;
    const { id, patientId, admitDate, dischargeDate, dischargeType, finalDiagnosis, conditionAtDischarge, treatmentSummary, proceduresDone, instructions, referredTo, followUp, ward, bed, data, } = req.body;
    if (!id || !patientId)
        return res.status(400).json({ error: 'id and patientId required' });
    const [row] = await (0, db_1.default) `
    INSERT INTO discharge_summaries
      (id, patient_id, clinic_id, doctor_id, admit_date, discharge_date, discharge_type,
       final_diagnosis, condition_at_discharge, treatment_summary, procedures_done,
       instructions, referred_to, follow_up, ward, bed, data)
    VALUES
      (${id}, ${patientId}, ${clinicId}, ${doctorId},
       ${admitDate ?? null}, ${dischargeDate ?? new Date().toISOString()},
       ${dischargeType ?? 'Improved'}, ${finalDiagnosis ?? null},
       ${conditionAtDischarge ?? null}, ${treatmentSummary ?? null},
       ${proceduresDone ?? null}, ${instructions ?? null},
       ${referredTo ?? null}, ${followUp ?? null},
       ${ward ?? null}, ${bed ?? null},
       ${data ? JSON.stringify(data) : '{}'}
      )
    ON CONFLICT (id) DO UPDATE SET
      treatment_summary = EXCLUDED.treatment_summary,
      instructions = EXCLUDED.instructions,
      data = EXCLUDED.data
    RETURNING *
  `;
    res.json({ ok: true, row });
});
router.get('/patient/:patientId', async (req, res) => {
    const rows = await (0, db_1.default) `
    SELECT * FROM discharge_summaries
    WHERE patient_id = ${req.params.patientId}
      AND clinic_id  = ${req.user.clinicId}
    ORDER BY discharge_date DESC
  `;
    res.json(rows);
});
exports.default = router;
