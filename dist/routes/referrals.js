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
// Helper: create a notification
async function notify(userId, type, title, message, entityType, entityId) {
    await (0, db_1.default) `
    INSERT INTO notifications (user_id, type, title, message, entity_type, entity_id)
    VALUES (${userId}, ${type}, ${title}, ${message}, ${entityType}, ${entityId})
  `.catch(() => { }); // never block on notification failure
}
// ─── GET /referrals — list referrals (sent + received) ───────────────────────
router.get('/', async (req, res) => {
    const userId = req.user.userId;
    const { direction, status } = req.query;
    try {
        const rows = await (0, db_1.default) `
      SELECT r.*,
        u_ref.name AS referring_doctor_name,
        u_ref.specialty AS referring_doctor_specialty,
        u_ref.profile_photo_url AS referring_doctor_photo,
        u_rec.name AS receiving_doctor_name,
        u_rec.specialty AS receiving_doctor_specialty,
        u_rec.profile_photo_url AS receiving_doctor_photo
      FROM referrals r
      JOIN users u_ref ON u_ref.id = r.referring_doctor_id
      JOIN users u_rec ON u_rec.id = r.receiving_doctor_id
      WHERE (
        ${direction === 'sent' ? (0, db_1.default) `r.referring_doctor_id = ${userId}` :
            direction === 'received' ? (0, db_1.default) `r.receiving_doctor_id = ${userId}` :
                (0, db_1.default) `(r.referring_doctor_id = ${userId} OR r.receiving_doctor_id = ${userId})`}
      )
      ${status ? (0, db_1.default) `AND r.status = ${status}` : (0, db_1.default) ``}
      ORDER BY r.created_at DESC
      LIMIT 100
    `;
        res.json(rows.map(r => ({
            id: r.id,
            referringDoctorId: r.referring_doctor_id,
            referringDoctorName: r.referring_doctor_name,
            referringDoctorSpecialty: r.referring_doctor_specialty,
            referringDoctorPhoto: r.referring_doctor_photo,
            receivingDoctorId: r.receiving_doctor_id,
            receivingDoctorName: r.receiving_doctor_name,
            receivingDoctorSpecialty: r.receiving_doctor_specialty,
            receivingDoctorPhoto: r.receiving_doctor_photo,
            patientId: r.patient_id,
            patientName: r.patient_name,
            patientAge: r.patient_age,
            patientGender: r.patient_gender,
            patientPhone: r.patient_phone,
            reason: r.reason,
            notes: r.notes,
            clinicalInfo: r.clinical_info,
            urgency: r.urgency,
            status: r.status,
            declinedReason: r.declined_reason,
            createdAt: r.created_at,
            acceptedAt: r.accepted_at,
            declinedAt: r.declined_at,
        })));
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// ─── POST /referrals — create a referral ─────────────────────────────────────
router.post('/', async (req, res) => {
    const referringDoctorId = req.user.userId;
    const { receivingDoctorId, patientId, patientName, patientAge, patientGender, patientPhone, reason, notes, clinicalInfo, urgency, } = req.body;
    if (!receivingDoctorId || !patientName?.trim() || !reason?.trim()) {
        return res.status(400).json({ error: 'receivingDoctorId, patientName, and reason are required' });
    }
    if (Number(receivingDoctorId) === referringDoctorId) {
        return res.status(400).json({ error: 'Cannot refer a patient to yourself' });
    }
    try {
        // Verify receiving doctor exists and is approved
        const [recDoc] = await (0, db_1.default) `
      SELECT id, name, specialty FROM users
      WHERE id = ${Number(receivingDoctorId)} AND approval_status = 'approved'
    `;
        if (!recDoc)
            return res.status(404).json({ error: 'Receiving doctor not found' });
        const [refDoc] = await (0, db_1.default) `SELECT name FROM users WHERE id = ${referringDoctorId}`;
        const [referral] = await (0, db_1.default) `
      INSERT INTO referrals (
        referring_doctor_id, receiving_doctor_id,
        patient_id, patient_name, patient_age, patient_gender, patient_phone,
        reason, notes, clinical_info, urgency
      ) VALUES (
        ${referringDoctorId}, ${Number(receivingDoctorId)},
        ${patientId ?? null}, ${patientName.trim()},
        ${patientAge ? Number(patientAge) : null},
        ${patientGender ?? 'M'}, ${patientPhone ?? ''},
        ${reason.trim()}, ${notes ?? ''}, ${clinicalInfo ?? ''},
        ${urgency ?? 'routine'}
      )
      RETURNING id
    `;
        // Notify the receiving doctor
        await notify(Number(receivingDoctorId), 'referral_received', 'Patient Referral', `Dr. ${refDoc?.name ?? 'A colleague'} has referred a patient to you: ${patientName.trim()}. Reason: ${reason.trim().slice(0, 100)}`, 'referral', String(referral.id));
        res.status(201).json({ ok: true, id: referral.id });
    }
    catch (e) {
        console.error('[referrals POST]', e);
        res.status(500).json({ error: e.message });
    }
});
// ─── GET /referrals/:id — get referral details ───────────────────────────────
router.get('/:id', async (req, res) => {
    const userId = req.user.userId;
    const referralId = Number(req.params.id);
    try {
        const rows = await (0, db_1.default) `
      SELECT r.*,
        u_ref.name AS referring_doctor_name, u_ref.specialty AS referring_doctor_specialty,
        u_ref.profile_photo_url AS referring_doctor_photo,
        u_rec.name AS receiving_doctor_name, u_rec.specialty AS receiving_doctor_specialty,
        u_rec.profile_photo_url AS receiving_doctor_photo
      FROM referrals r
      JOIN users u_ref ON u_ref.id = r.referring_doctor_id
      JOIN users u_rec ON u_rec.id = r.receiving_doctor_id
      WHERE r.id = ${referralId}
        AND (r.referring_doctor_id = ${userId} OR r.receiving_doctor_id = ${userId})
    `;
        if (!rows.length)
            return res.status(404).json({ error: 'Referral not found' });
        const r = rows[0];
        res.json({
            id: r.id,
            referringDoctorId: r.referring_doctor_id,
            referringDoctorName: r.referring_doctor_name,
            referringDoctorSpecialty: r.referring_doctor_specialty,
            referringDoctorPhoto: r.referring_doctor_photo,
            receivingDoctorId: r.receiving_doctor_id,
            receivingDoctorName: r.receiving_doctor_name,
            receivingDoctorSpecialty: r.receiving_doctor_specialty,
            receivingDoctorPhoto: r.receiving_doctor_photo,
            patientId: r.patient_id, patientName: r.patient_name,
            patientAge: r.patient_age, patientGender: r.patient_gender, patientPhone: r.patient_phone,
            reason: r.reason, notes: r.notes, clinicalInfo: r.clinical_info,
            urgency: r.urgency, status: r.status, declinedReason: r.declined_reason,
            createdAt: r.created_at, acceptedAt: r.accepted_at, declinedAt: r.declined_at,
        });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// ─── PATCH /referrals/:id — accept or decline ────────────────────────────────
router.patch('/:id', async (req, res) => {
    const userId = req.user.userId;
    const referralId = Number(req.params.id);
    const { action, declinedReason } = req.body;
    if (!['accept', 'decline', 'cancel'].includes(action)) {
        return res.status(400).json({ error: 'action must be accept, decline, or cancel' });
    }
    try {
        const [referral] = await (0, db_1.default) `SELECT * FROM referrals WHERE id = ${referralId}`;
        if (!referral)
            return res.status(404).json({ error: 'Referral not found' });
        // Auth checks
        if (action === 'accept' || action === 'decline') {
            if (Number(referral.receiving_doctor_id) !== userId) {
                return res.status(403).json({ error: 'Only the receiving doctor can accept or decline' });
            }
        }
        if (action === 'cancel') {
            if (Number(referral.referring_doctor_id) !== userId) {
                return res.status(403).json({ error: 'Only the referring doctor can cancel' });
            }
        }
        if (referral.status !== 'pending') {
            return res.status(409).json({ error: `Referral is already ${referral.status}` });
        }
        const now = new Date().toISOString();
        let updated;
        if (action === 'accept') {
            [updated] = await (0, db_1.default) `
        UPDATE referrals SET status = 'accepted', accepted_at = ${now}, updated_at = ${now}
        WHERE id = ${referralId} RETURNING *
      `;
            // Notify referring doctor
            const [recDoc] = await (0, db_1.default) `SELECT name FROM users WHERE id = ${userId}`;
            await notify(Number(referral.referring_doctor_id), 'referral_accepted', 'Referral Accepted', `Dr. ${recDoc?.name ?? 'The doctor'} has accepted your referral for ${referral.patient_name}.`, 'referral', String(referralId));
        }
        else if (action === 'decline') {
            [updated] = await (0, db_1.default) `
        UPDATE referrals SET status = 'declined', declined_at = ${now},
          declined_reason = ${declinedReason ?? ''}, updated_at = ${now}
        WHERE id = ${referralId} RETURNING *
      `;
            const [recDoc] = await (0, db_1.default) `SELECT name FROM users WHERE id = ${userId}`;
            await notify(Number(referral.referring_doctor_id), 'referral_declined', 'Referral Declined', `Dr. ${recDoc?.name ?? 'The doctor'} has declined your referral for ${referral.patient_name}.${declinedReason ? ` Reason: ${declinedReason}` : ''}`, 'referral', String(referralId));
        }
        else {
            [updated] = await (0, db_1.default) `
        UPDATE referrals SET status = 'cancelled', updated_at = ${now}
        WHERE id = ${referralId} RETURNING *
      `;
        }
        res.json({ ok: true, status: updated.status });
    }
    catch (e) {
        console.error('[referrals PATCH]', e);
        res.status(500).json({ error: e.message });
    }
});
exports.default = router;
