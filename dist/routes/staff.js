"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const db_1 = __importDefault(require("../db"));
const audit_1 = require("../lib/audit");
const router = (0, express_1.Router)();
router.use(auth_1.requireAuth);
// GET /staff/pending
// Returns pending staff who were invited to one of THIS doctor's clinics.
// (Staff with no invited_clinic_ids at all are also shown so legacy invites
// aren't lost — but staff invited to someone else's clinic are hidden.)
router.get('/pending', async (req, res) => {
    const userId = req.user.userId;
    const clinics = await (0, db_1.default) `SELECT id FROM clinics WHERE owner_id = ${userId}`;
    let myClinicIds = clinics.map(c => c.id);
    // Fallback: use clinic_id from users table if clinics table has no rows for this doctor
    if (myClinicIds.length === 0) {
        const [doctor] = await (0, db_1.default) `SELECT clinic_id FROM users WHERE id = ${userId}`;
        if (doctor?.clinic_id)
            myClinicIds = [doctor.clinic_id];
    }
    const pending = await (0, db_1.default) `
    SELECT id, name, email, phone, role, degrees, specialty,
           invited_clinic_ids, invited_clinic_name, invited_by_user_id, created_at
    FROM users
    WHERE approval_status = 'pending'
      AND role NOT IN ('clinic_admin', 'clinic_manager', 'superadmin', 'patient')
    ORDER BY created_at DESC
  `;
    const scoped = pending.filter(p => {
        // Primary match: invited_by_user_id — set when staff registers via invite link
        // that includes ?did=doctorId. Most reliable across all role types.
        if (p.invited_by_user_id != null) {
            return p.invited_by_user_id === userId;
        }
        // Fallback: match by clinic IDs (older registrations without invited_by_user_id)
        // decodeURIComponent handles links that were double-encoded by WhatsApp/email
        const raw = decodeURIComponent(p.invited_clinic_ids ?? '');
        const invited = raw.split(',').map(s => s.trim()).filter(Boolean);
        if (invited.length === 0)
            return true; // legacy: no invite metadata → show to all
        return myClinicIds.length === 0 || invited.some(id => myClinicIds.includes(id));
    });
    res.json(scoped);
});
// GET /staff/active — returns approved staff belonging to the doctor's clinics
// Primary match: invited_by_user_id = doctor (set on approve / invite link)
// Secondary: clinic_id = ANY(doctor's clinics) for older records without invited_by_user_id
router.get('/active', async (req, res) => {
    const userId = req.user.userId;
    const clinics = await (0, db_1.default) `SELECT id FROM clinics WHERE owner_id = ${userId}`;
    const clinicIds = clinics.map(c => c.id);
    // Primary: staff who were approved by / invited by this doctor
    const byInvite = await (0, db_1.default) `
    SELECT id, name, email, phone, role, degrees, specialty, department, clinic_id, created_at
    FROM users
    WHERE approval_status = 'approved'
      AND role NOT IN ('clinic_admin', 'clinic_manager', 'superadmin', 'patient')
      AND invited_by_user_id = ${userId}
    ORDER BY name
  `;
    // Secondary: legacy staff with no invited_by_user_id but assigned to this doctor's clinic
    let byClinic = [];
    if (clinicIds.length > 0) {
        byClinic = await (0, db_1.default) `
      SELECT id, name, email, phone, role, degrees, specialty, department, clinic_id, created_at
      FROM users
      WHERE approval_status = 'approved'
        AND role NOT IN ('clinic_admin', 'clinic_manager', 'superadmin', 'patient')
        AND invited_by_user_id IS NULL
        AND clinic_id = ANY(${clinicIds})
      ORDER BY name
    `;
    }
    // Merge without duplicates (byInvite takes precedence)
    const seen = new Set(byInvite.map(u => u.id));
    const combined = [
        ...byInvite,
        ...byClinic.filter(u => !seen.has(u.id)),
    ].sort((a, b) => String(a.name).localeCompare(String(b.name)));
    res.json(combined);
});
// POST /staff/:id/approve — assign to first matched clinic and mark approved
router.post('/:id/approve', async (req, res) => {
    const user = req.user;
    const targetId = Number(req.params.id);
    const clinics = await (0, db_1.default) `SELECT id FROM clinics WHERE owner_id = ${user.userId}`;
    const clinicIds = clinics.map(c => c.id);
    if (clinicIds.length === 0) {
        res.status(403).json({ error: 'No clinics found' });
        return;
    }
    // Verify the target user was actually invited to one of this doctor's clinics
    const [target] = await (0, db_1.default) `SELECT id, invited_clinic_ids, invited_by_user_id FROM users WHERE id = ${targetId}`;
    if (!target) {
        res.status(404).json({ error: 'User not found' });
        return;
    }
    // Primary auth check: if staff was invited directly by this doctor, allow
    const directlyInvited = target.invited_by_user_id === user.userId;
    // Secondary check: match via clinic IDs
    const invitedIds = target.invited_clinic_ids?.split(',').map(s => s.trim()).filter(Boolean) ?? [];
    const matchedClinic = clinicIds.find(id => invitedIds.includes(id));
    // If they were explicitly invited to a different doctor's clinic, refuse
    if (!directlyInvited && !matchedClinic && invitedIds.length > 0) {
        res.status(403).json({ error: 'This staff member was invited to a different clinic.' });
        return;
    }
    // Legacy registrations with no invite metadata: assign to this doctor's first clinic
    const assignClinic = matchedClinic ?? clinicIds[0];
    await (0, db_1.default) `
    UPDATE users
    SET approval_status = 'approved',
        clinic_id = ${assignClinic},
        invited_by_user_id = COALESCE(invited_by_user_id, ${user.userId}),
        approved_at = NOW()
    WHERE id = ${targetId}
  `;
    (0, audit_1.auditFromReq)(req, 'staff.approve', 'user', String(targetId), { clinicId: assignClinic });
    res.json({ ok: true, clinicId: assignClinic });
});
// POST /staff/create — directly create an approved staff member (no invite flow)
// Used by clinic_admin when adding staff manually from the UI
router.post('/create', async (req, res) => {
    const user = req.user;
    if (user.role !== 'clinic_admin' && user.role !== 'clinic_manager' && user.role !== 'superadmin') {
        res.status(403).json({ error: 'Only clinic admins can create staff directly' });
        return;
    }
    const { name, email, phone, role, department, specialty, shift } = req.body;
    if (!name?.trim() || !email?.trim()) {
        res.status(400).json({ error: 'Name and email are required' });
        return;
    }
    const clinics = await (0, db_1.default) `SELECT id FROM clinics WHERE owner_id = ${user.userId}`;
    const clinicIds = clinics.map(c => c.id);
    const assignClinic = clinicIds[0] ?? null;
    const bcrypt = await Promise.resolve().then(() => __importStar(require('bcryptjs')));
    const tempPass = Math.random().toString(36).slice(-10) + 'A1!';
    const passwordHash = await bcrypt.hash(tempPass, 10);
    try {
        const [created] = await (0, db_1.default) `
      INSERT INTO users (name, email, phone, role, department, specialty,
                         clinic_id, invited_by_user_id, approval_status,
                         password_hash, approved_at)
      VALUES (${name.trim()}, ${email.trim().toLowerCase()},
              ${phone ?? ''}, ${role ?? 'nurse'},
              ${department ?? ''}, ${specialty ?? ''},
              ${assignClinic}, ${user.userId}, 'approved',
              ${passwordHash}, NOW())
      RETURNING id, name, email, phone, role, specialty, department, clinic_id, created_at
    `;
        (0, audit_1.auditFromReq)(req, 'staff.create', 'user', String(created.id), { clinic: assignClinic });
        res.status(201).json({ ...created, status: 'active' });
    }
    catch (err) {
        if (err.code === '23505') {
            res.status(409).json({ error: 'A user with this email already exists' });
        }
        else {
            throw err;
        }
    }
});
// POST /staff/:id/reject
router.post('/:id/reject', async (req, res) => {
    const targetId = Number(req.params.id);
    const reason = req.body.reason ?? 'Not approved by clinic';
    await (0, db_1.default) `
    UPDATE users
    SET approval_status = 'rejected', rejection_reason = ${reason}
    WHERE id = ${targetId}
  `;
    (0, audit_1.auditFromReq)(req, 'staff.reject', 'user', String(targetId), { reason });
    res.json({ ok: true });
});
// DELETE /staff/:id — remove staff from clinic
router.delete('/:id', async (req, res) => {
    const user = req.user;
    const targetId = Number(req.params.id);
    const clinics = await (0, db_1.default) `SELECT id FROM clinics WHERE owner_id = ${user.userId}`;
    const clinicIds = clinics.map(c => c.id);
    // Only remove staff who belong to this doctor's clinic
    await (0, db_1.default) `
    UPDATE users
    SET clinic_id = NULL, approval_status = 'rejected', rejection_reason = 'Removed by doctor'
    WHERE id = ${targetId}
      AND clinic_id = ANY(${clinicIds})
  `;
    res.json({ ok: true });
});
exports.default = router;
