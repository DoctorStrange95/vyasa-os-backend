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
// ─── Send a message (REST fallback when the socket is unavailable) ───────────
// The socket path (index.ts) stays primary for real-time; this guarantees the
// message is persisted so it reaches other devices on their next load.
router.post('/', async (req, res) => {
    const u = req.user;
    const { patientId, message, type, id: clientId } = req.body;
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
        // Plain insert — NO "ON CONFLICT (id)": the prod chat_messages table may not
        // have a unique constraint on id, which made ON CONFLICT error out (this was
        // the "Chat not saved" bug). The frontend already de-dups by id on reload.
        await (0, db_1.default) `
      INSERT INTO chat_messages (id, patient_id, clinic_id, sender_id, sender_name, sender_role, message, type, time)
      VALUES (${id}, ${patientId}, ${u.clinicId}, ${u.userId ?? null}, ${senderName}, ${u.role ?? 'user'}, ${message}, ${type ?? 'message'}, ${time})
    `;
    }
    catch (e) {
        console.error('[chat POST insert failed]', e);
        res.status(500).json({ error: e.message });
        return;
    }
    res.json({ id, patientId, senderId: u.userId, senderName, senderRole: u.role, message, type: type ?? 'message', time });
});
// ─── Recent messages across the whole clinic (for the notification bell) ─────
// Defined BEFORE /:patientId so the literal path wins the route match.
router.get('/recent', async (req, res) => {
    const rows = await (0, db_1.default) `
    SELECT * FROM chat_messages
    WHERE clinic_id = ${req.user.clinicId}
    ORDER BY time DESC
    LIMIT 30
  `;
    res.json(rows.map(r => ({
        id: r.id, patientId: r.patient_id, senderId: r.sender_id,
        senderName: r.sender_name, senderRole: r.sender_role,
        message: r.message, type: r.type, time: r.time,
    })));
});
// ─── Get messages for a patient or clinic-wide ───────────────────────────────
router.get('/:patientId', async (req, res) => {
    const rows = await (0, db_1.default) `
    SELECT * FROM chat_messages
    WHERE patient_id = ${req.params.patientId} AND clinic_id = ${req.user.clinicId}
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
exports.default = router;
