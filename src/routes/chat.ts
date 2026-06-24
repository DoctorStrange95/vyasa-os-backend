import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import sql from '../db';

const router = Router();
router.use(requireAuth);

// ─── Send a message (REST fallback when the socket is unavailable) ───────────
// The socket path (index.ts) stays primary for real-time; this guarantees the
// message is persisted so it reaches other devices on their next load.
router.post('/', async (req: Request, res: Response) => {
  const u = req.user!;
  const { patientId, message, type } = req.body as { patientId?: string; message?: string; type?: string };
  if (!patientId || !message?.trim()) {
    res.status(400).json({ error: 'patientId and message are required' });
    return;
  }
  const id = `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const time = new Date().toISOString();
  await sql`
    INSERT INTO chat_messages (id, patient_id, clinic_id, sender_id, sender_name, sender_role, message, type, time)
    VALUES (${id}, ${patientId}, ${u.clinicId}, ${u.userId}, ${u.name}, ${u.role}, ${message}, ${type ?? 'message'}, ${time})
  `;
  res.json({ id, patientId, senderId: u.userId, senderName: u.name, senderRole: u.role, message, type: type ?? 'message', time });
});

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
