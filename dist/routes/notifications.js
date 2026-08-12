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
// GET /notifications — list recent notifications for current user
router.get('/', async (req, res) => {
    const userId = req.user.userId;
    try {
        const rows = await (0, db_1.default) `
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
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// PATCH /notifications/read-all — mark all as read
router.patch('/read-all', async (req, res) => {
    const userId = req.user.userId;
    try {
        await (0, db_1.default) `UPDATE notifications SET read = true WHERE user_id = ${userId} AND read = false`;
        res.json({ ok: true });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// PATCH /notifications/:id/read — mark one as read
router.patch('/:id/read', async (req, res) => {
    const userId = req.user.userId;
    try {
        await (0, db_1.default) `UPDATE notifications SET read = true WHERE id = ${Number(req.params.id)} AND user_id = ${userId}`;
        res.json({ ok: true });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
exports.default = router;
