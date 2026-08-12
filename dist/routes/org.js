"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const auth_1 = require("../middleware/auth");
const db_1 = __importDefault(require("../db"));
const router = (0, express_1.Router)();
// ─── POST /org/register ───────────────────────────────────────────────────────
// Register a new organization (clinic or hospital) with an admin account
router.post('/register', async (req, res) => {
    const { org_name, org_type, address, city, state, phone, email, gstin, admin_name, admin_email, admin_password, admin_phone, admin_specialty, } = req.body;
    if (!org_name || !org_type || !admin_name || !admin_email || !admin_password) {
        return res.status(400).json({ error: 'Required fields missing' });
    }
    if (!['clinic', 'hospital'].includes(org_type)) {
        return res.status(400).json({ error: 'org_type must be clinic or hospital' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(admin_email)) {
        return res.status(400).json({ error: 'Invalid email address' });
    }
    if (admin_password.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    if (org_name.trim().length < 2) {
        return res.status(400).json({ error: 'Organisation name too short' });
    }
    try {
        const [existing] = await (0, db_1.default) `SELECT id FROM users WHERE email = ${admin_email.toLowerCase().trim()}`;
        if (existing)
            return res.status(409).json({ error: 'Email already registered' });
        const hash = await bcryptjs_1.default.hash(admin_password, 10);
        const orgId = `org_${Date.now()}`;
        const adminName = admin_name.trim();
        const adminEmail = admin_email.toLowerCase().trim();
        const orgName = org_name.trim();
        // 1. Create org (owner_id = NULL initially)
        await (0, db_1.default) `
      INSERT INTO organizations (id, name, type, address, city, state, phone, email, gstin, owner_id)
      VALUES (
        ${orgId}, ${orgName}, ${org_type},
        ${address ?? ''}, ${city ?? ''}, ${state ?? ''},
        ${phone ?? ''}, ${email ?? ''}, ${gstin ?? ''},
        NULL
      )
    `;
        // 2. Create admin user — org_id has no FK constraint so this always works
        const [adminUser] = await (0, db_1.default) `
      INSERT INTO users (name, email, password_hash, role, phone, specialty, approval_status, org_id)
      VALUES (
        ${adminName}, ${adminEmail}, ${hash},
        'clinic_manager', ${admin_phone ?? ''}, ${admin_specialty ?? ''},
        'approved', ${orgId}
      )
      RETURNING id, name, email, role
    `;
        const userId = adminUser.id;
        // 3. Back-fill owner, add org member, create default clinic
        await (0, db_1.default) `UPDATE organizations SET owner_id = ${userId} WHERE id = ${orgId}`;
        await (0, db_1.default) `
      INSERT INTO org_members (org_id, user_id, role, department)
      VALUES (${orgId}, ${userId}, 'clinic_admin', 'Administration')
    `;
        const clinicId = `clinic_${userId}`;
        await (0, db_1.default) `
      INSERT INTO clinics (id, owner_id, name, address, fee, max_patients)
      VALUES (${clinicId}, ${userId}, ${orgName}, ${address ?? ''}, 200, 30)
      ON CONFLICT DO NOTHING
    `;
        await (0, db_1.default) `UPDATE users SET clinic_id = ${clinicId} WHERE id = ${userId}`;
        res.json({ success: true, org_id: orgId, admin: adminUser });
    }
    catch (e) {
        console.error('[org/register]', e);
        res.status(500).json({ error: e.message });
    }
});
// ─── GET /org/me ─────────────────────────────────────────────────────────────
// Get the organization the current user belongs to
router.get('/me', auth_1.requireAuth, async (req, res) => {
    const userId = req.user?.userId;
    try {
        const [user] = await (0, db_1.default) `SELECT org_id FROM users WHERE id = ${userId}`;
        if (!user?.org_id)
            return res.json({ org: null });
        const [org] = await (0, db_1.default) `SELECT * FROM organizations WHERE id = ${user.org_id}`;
        res.json({ org: org ?? null });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// ─── GET /org/staff ──────────────────────────────────────────────────────────
// List all staff in the current user's organization
router.get('/staff', auth_1.requireAuth, async (req, res) => {
    const userId = req.user?.userId;
    try {
        const [user] = await (0, db_1.default) `SELECT org_id, role FROM users WHERE id = ${userId}`;
        if (!user?.org_id)
            return res.status(403).json({ error: 'Not part of an organization' });
        const staff = await (0, db_1.default) `
      SELECT u.id, u.name, u.email, u.phone, u.specialty, u.department,
             om.role, om.department AS om_department, om.joined_at
      FROM org_members om
      JOIN users u ON u.id = om.user_id
      WHERE om.org_id = ${user.org_id}
      ORDER BY om.joined_at ASC
    `;
        res.json({ staff });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// ─── POST /org/staff ─────────────────────────────────────────────────────────
// Add a new staff member (creates user + adds to org)
router.post('/staff', auth_1.requireAuth, async (req, res) => {
    const adminId = req.user?.userId;
    const { name, email, role, department, phone, temp_password } = req.body;
    if (!name || !email || !role)
        return res.status(400).json({ error: 'name, email, role required' });
    const validRoles = ['doctor', 'nurse', 'receptionist', 'pharmacist', 'labtech', 'billing', 'admin'];
    if (!validRoles.includes(role))
        return res.status(400).json({ error: 'Invalid role' });
    try {
        const [admin] = await (0, db_1.default) `SELECT org_id, role AS admin_role FROM users WHERE id = ${adminId}`;
        if (!admin?.org_id)
            return res.status(403).json({ error: 'Not part of an organization' });
        if (!['clinic_admin', 'admin', 'clinic_manager'].includes(admin.admin_role)) {
            return res.status(403).json({ error: 'Only admins can add staff' });
        }
        const [existing] = await (0, db_1.default) `SELECT id, org_id FROM users WHERE email = ${email.toLowerCase().trim()}`;
        if (existing) {
            // User exists — just add to org if not already there
            await (0, db_1.default) `
        INSERT INTO org_members (org_id, user_id, role, department)
        VALUES (${admin.org_id}, ${existing.id}, ${role}, ${department ?? ''})
        ON CONFLICT (org_id, user_id) DO UPDATE SET role = ${role}, department = ${department ?? ''}
      `;
            await (0, db_1.default) `UPDATE users SET org_id = ${admin.org_id}, department = ${department ?? ''} WHERE id = ${existing.id}`;
            return res.json({ success: true, user_id: existing.id, existed: true });
        }
        const password = temp_password || Math.random().toString(36).slice(-8);
        const hash = await bcryptjs_1.default.hash(password, 10);
        const [org] = await (0, db_1.default) `SELECT id, name FROM clinics WHERE owner_id = ${adminId} LIMIT 1`;
        const [newUser] = await (0, db_1.default) `
      INSERT INTO users (name, email, password_hash, role, phone, department, approval_status, org_id, clinic_id)
      VALUES (
        ${name.trim()}, ${email.toLowerCase().trim()}, ${hash},
        ${role}, ${phone ?? ''}, ${department ?? ''},
        'approved', ${admin.org_id}, ${org?.id ?? null}
      )
      RETURNING id, name, email, role
    `;
        await (0, db_1.default) `
      INSERT INTO org_members (org_id, user_id, role, department)
      VALUES (${admin.org_id}, ${newUser.id}, ${role}, ${department ?? ''})
    `;
        res.json({ success: true, user_id: newUser.id, temp_password: password, existed: false });
    }
    catch (e) {
        console.error('[org/staff/add]', e);
        res.status(500).json({ error: e.message });
    }
});
// ─── PATCH /org/staff/:id ────────────────────────────────────────────────────
// Update a staff member's role or department
router.patch('/staff/:id', auth_1.requireAuth, async (req, res) => {
    const adminId = req.user?.userId;
    const targetId = Number(req.params.id);
    const { role, department } = req.body;
    try {
        const [admin] = await (0, db_1.default) `SELECT org_id, role AS admin_role FROM users WHERE id = ${adminId}`;
        if (!admin?.org_id || !['clinic_admin', 'admin', 'clinic_manager'].includes(admin.admin_role)) {
            return res.status(403).json({ error: 'Unauthorized' });
        }
        await (0, db_1.default) `
      UPDATE org_members SET role = COALESCE(${role ?? null}, role),
        department = COALESCE(${department ?? null}, department)
      WHERE org_id = ${admin.org_id} AND user_id = ${targetId}
    `;
        if (role)
            await (0, db_1.default) `UPDATE users SET role = ${role} WHERE id = ${targetId}`;
        if (department)
            await (0, db_1.default) `UPDATE users SET department = ${department} WHERE id = ${targetId}`;
        res.json({ success: true });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// ─── DELETE /org/staff/:id ───────────────────────────────────────────────────
router.delete('/staff/:id', auth_1.requireAuth, async (req, res) => {
    const adminId = req.user?.userId;
    const targetId = Number(req.params.id);
    try {
        const [admin] = await (0, db_1.default) `SELECT org_id, role AS admin_role FROM users WHERE id = ${adminId}`;
        if (!admin?.org_id || !['clinic_admin', 'admin', 'clinic_manager'].includes(admin.admin_role)) {
            return res.status(403).json({ error: 'Unauthorized' });
        }
        await (0, db_1.default) `DELETE FROM org_members WHERE org_id = ${admin.org_id} AND user_id = ${targetId}`;
        await (0, db_1.default) `UPDATE users SET org_id = NULL WHERE id = ${targetId}`;
        res.json({ success: true });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
exports.default = router;
