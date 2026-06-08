import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import sql from '../db';

const router = Router();
router.use(requireAuth);

// ─── Get messages for a patient or clinic-wide ───────────────────────────────

router.get('/:patientId', async (req: Request, res: Response) => {
  const rows = await sql`
    SELECT * FROM chat_messages
    WHERE patient_id = ${req.params.patientId} AND clinic_id = ${req.user!.clinicId}
    ORDER BY time ASC
    LIMIT 100
  `;
  res.json(rows.map(r => ({
    id: r.id,
    patientId: r.patient_id,
    senderId: r.sender_id,
    senderName: r.sender_name,
    senderRole: r.sender_role,
    message: r.message,
    type: r.type,
    time: r.time,
  })));
});

export default router;
