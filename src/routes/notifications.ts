import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import sql from '../db';

const router = Router();
router.use(requireAuth);

// GET /notifications — list recent notifications for current user
router.get('/', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  try {
    const rows = await sql`
      SELECT * FROM notifications
      WHERE user_id = ${userId}
      ORDER BY created_at DESC
      LIMIT 50
    `;
    res.json(rows.map(r => ({
      id: r.id,
      type: r.type,
      title: r.title,
      message: r.message,
      entityType: r.entity_type,
      entityId: r.entity_id,
      read: r.read,
      createdAt: r.created_at,
    })));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /notifications/read-all — mark all as read
router.patch('/read-all', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  try {
    await sql`UPDATE notifications SET read = true WHERE user_id = ${userId} AND read = false`;
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /notifications/:id/read — mark one as read
router.patch('/:id/read', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  try {
    await sql`UPDATE notifications SET read = true WHERE id = ${Number(req.params.id)} AND user_id = ${userId}`;
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
