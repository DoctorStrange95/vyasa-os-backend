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
  const { patientId, message, type, id: clientId } = req.body as { patientId?: string; message?: string; type?: string; id?: string };
  if (!patientId || !message?.trim()) {
    res.status(400).json({ error: 'patientId and message are required' });
    return;
  }
  // Use the client-provided id when present so the sender's optimistic message
  // and the persisted row share an id (clean de-dup when the chat reloads).
  const id = clientId || `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const time = new Date().toISOString();
  // sender_name is NOT NULL — fall back so a thin JWT can't break the insert.
  // clinic_id is kept exactly as u.clinicId so the GET filter still matches.
  const senderName = u.name || 'User';
  try {
    await sql`
      INSERT INTO chat_messages (id, patient_id, clinic_id, sender_id, sender_name, sender_role, message, type, time)
      VALUES (${id}, ${patientId}, ${u.clinicId}, ${u.userId ?? null}, ${senderName}, ${u.role ?? 'user'}, ${message}, ${type ?? 'message'}, ${time})
      ON CONFLICT (id) DO NOTHING
    `;
  } catch (e) {
    console.error('[chat POST insert failed]', e);
    res.status(500).json({ error: (e as Error).message });
    return;
  }
  res.json({ id, patientId, senderId: u.userId, senderName, senderRole: u.role, message, type: type ?? 'message', time });
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
