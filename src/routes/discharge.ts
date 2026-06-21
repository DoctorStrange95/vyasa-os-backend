import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import sql from '../db';

const router = Router();
router.use(requireAuth);

router.post('/', async (req: Request, res: Response) => {
  const doctorId = req.user!.userId;
  const clinicId = req.user!.clinicId;
  const {
    id, patientId, admitDate, dischargeDate, dischargeType,
    finalDiagnosis, conditionAtDischarge, treatmentSummary,
    proceduresDone, instructions, referredTo, followUp, ward, bed, data,
  } = req.body as Record<string, any>;

  if (!id || !patientId) return res.status(400).json({ error: 'id and patientId required' });

  const [row] = await sql`
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

router.get('/patient/:patientId', async (req: Request, res: Response) => {
  const rows = await sql`
    SELECT * FROM discharge_summaries
    WHERE patient_id = ${req.params.patientId}
      AND clinic_id  = ${req.user!.clinicId}
    ORDER BY discharge_date DESC
  `;
  res.json(rows);
});

export default router;
