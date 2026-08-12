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
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const uuid_1 = require("uuid");
const zod_1 = require("zod");
const db_1 = __importDefault(require("../db"));
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
const RegisterSchema = zod_1.z.object({
    name: zod_1.z.string().min(2),
    email: zod_1.z.string().email(),
    password: zod_1.z.string().min(6),
    role: zod_1.z.string().optional(),
    specialty: zod_1.z.string().optional(),
    degrees: zod_1.z.string().optional(),
    phone: zod_1.z.string().optional(),
    licenseNumber: zod_1.z.string().optional(),
    medicalCouncil: zod_1.z.string().optional(),
    regState: zod_1.z.string().optional(),
    state: zod_1.z.string().optional(),
    city: zod_1.z.string().optional(),
    googleId: zod_1.z.string().optional(),
    profilePhotoUrl: zod_1.z.string().optional(),
    clinicIds: zod_1.z.string().optional(),
    clinicName: zod_1.z.string().optional(),
    invitedByUserId: zod_1.z.number().optional(),
});
const LoginSchema = zod_1.z.object({
    email: zod_1.z.string().min(1), // accepts email OR phone — validated below
    password: zod_1.z.string(),
    lat: zod_1.z.number().optional(),
    lng: zod_1.z.number().optional(),
    locationLabel: zod_1.z.string().optional(),
});
async function logLoginSession(req, user, geo) {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
        ?? req.socket.remoteAddress ?? null;
    const ua = req.headers['user-agent'] ?? null;
    await (0, db_1.default) `
    INSERT INTO login_sessions (user_id, user_name, user_email, user_role, ip_address, user_agent, lat, lng, location_label)
    VALUES (${user.id}, ${user.name}, ${user.email}, ${user.role},
            ${ip}, ${ua}, ${geo?.lat ?? null}, ${geo?.lng ?? null}, ${geo?.locationLabel ?? null})
  `;
}
function makeTokens(payload) {
    const accessToken = jsonwebtoken_1.default.sign(payload, process.env.JWT_SECRET, { expiresIn: '15m' });
    const refreshToken = (0, uuid_1.v4)();
    return { accessToken, refreshToken };
}
// ─── Register ────────────────────────────────────────────────────────────────
router.post('/register', async (req, res) => {
    const parsed = RegisterSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0].message });
        return;
    }
    const { name, email, password, role, specialty, degrees, phone, licenseNumber, medicalCouncil, regState, state, city, googleId, profilePhotoUrl, clinicIds, clinicName: invitedClinicName, invitedByUserId } = parsed.data;
    const passwordHash = await bcryptjs_1.default.hash(password, 12);
    const effectiveRole = role ?? 'clinic_admin';
    // Superadmins are auto-approved; all others start as pending until license verified
    // Superadmins and clinic managers are auto-approved; all others start as pending until license verified
    const approvalStatus = (effectiveRole === 'superadmin' || effectiveRole === 'clinic_manager') ? 'approved' : 'pending';
    // Check existing. A previously REJECTED account is allowed to reapply — we
    // reuse the same row (overwriting it with the new application and resetting
    // to pending) instead of deleting, which avoids any foreign-key issues.
    // Active / pending / blocked (suspended) accounts still cannot re-register.
    const [existing] = await (0, db_1.default) `SELECT id, approval_status FROM users WHERE email = ${email}`;
    if (existing && existing.approval_status !== 'rejected') {
        res.status(409).json({ error: 'Email already registered' });
        return;
    }
    let user;
    if (existing) {
        // Re-application of a rejected doctor — refresh their record back to pending
        [user] = await (0, db_1.default) `
      UPDATE users SET
        name = ${name}, password_hash = ${passwordHash}, role = ${effectiveRole},
        specialty = ${specialty ?? null}, degrees = ${degrees ?? null}, phone = ${phone ?? null},
        license_number = ${licenseNumber ?? null}, medical_council = ${medicalCouncil ?? null},
        reg_state = ${regState ?? null}, state = ${state ?? null}, city = ${city ?? null},
        google_id = ${googleId ?? null}, approval_status = ${approvalStatus}, rejection_reason = NULL,
        profile_photo_url = COALESCE(NULLIF(${profilePhotoUrl ?? null}, ''), profile_photo_url),
        invited_clinic_ids = ${clinicIds ?? null}, invited_clinic_name = ${invitedClinicName ?? null},
        invited_by_user_id = ${invitedByUserId ?? null}, created_at = NOW()
      WHERE id = ${existing.id}
      RETURNING id, name, email, role, specialty, degrees, phone, clinic_id, approval_status
    `;
    }
    else {
        [user] = await (0, db_1.default) `
      INSERT INTO users (name, email, password_hash, role, specialty, degrees, phone, license_number, medical_council, reg_state, state, city, google_id, profile_photo_url, approval_status, invited_clinic_ids, invited_clinic_name, invited_by_user_id)
      VALUES (${name}, ${email}, ${passwordHash}, ${effectiveRole}, ${specialty ?? null}, ${degrees ?? null}, ${phone ?? null},
              ${licenseNumber ?? null}, ${medicalCouncil ?? null}, ${regState ?? null}, ${state ?? null}, ${city ?? null}, ${googleId ?? null}, ${profilePhotoUrl ?? null}, ${approvalStatus},
              ${clinicIds ?? null}, ${invitedClinicName ?? null}, ${invitedByUserId ?? null})
      RETURNING id, name, email, role, specialty, degrees, phone, clinic_id, approval_status
    `;
    }
    // Auto-create a default clinic for clinic_admin
    let clinicId = user.clinic_id;
    if (effectiveRole === 'clinic_admin' && !clinicId) {
        clinicId = `clinic_${user.id}`;
        const clinicName = `${name}'s Clinic`;
        await (0, db_1.default) `
      INSERT INTO clinics (id, owner_id, name, address, fee, max_patients)
      VALUES (${clinicId}, ${user.id}, ${clinicName}, '', 200, 30)
      ON CONFLICT DO NOTHING
    `;
        await (0, db_1.default) `UPDATE users SET clinic_id = ${clinicId} WHERE id = ${user.id}`;
        await (0, db_1.default) `
      INSERT INTO pad_settings (user_id, doctor_name, clinic_name)
      VALUES (${user.id}, ${name}, ${clinicName})
      ON CONFLICT DO NOTHING
    `;
    }
    const payload = {
        userId: user.id,
        email: user.email,
        role: user.role,
        clinicId: clinicId ?? '',
        name: user.name,
        approvalStatus: user.approval_status,
    };
    const { accessToken, refreshToken } = makeTokens(payload);
    // Store refresh token (30 days)
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    await (0, db_1.default) `
    INSERT INTO refresh_tokens (user_id, token, expires_at)
    VALUES (${user.id}, ${refreshToken}, ${expiresAt})
  `;
    // Send notification email to SuperAdmin (fire-and-forget)
    if (effectiveRole === 'clinic_admin') {
        try {
            const { newUserRegistrationEmail, sendMail } = await Promise.resolve().then(() => __importStar(require('../lib/mailer')));
            const [superadmin] = await (0, db_1.default) `SELECT email FROM users WHERE role = 'superadmin' LIMIT 1`;
            if (superadmin && superadmin.email) {
                const emailData = newUserRegistrationEmail({
                    doctorName: name,
                    email,
                    phone: phone || 'Not provided',
                    specialty: specialty || 'Not specified',
                    degrees: degrees || 'Not specified',
                    regNumber: licenseNumber || 'Not provided',
                    regState: regState || 'Not specified',
                    city: city || undefined,
                    state: state || undefined,
                });
                sendMail(superadmin.email, emailData.subject, emailData.html);
            }
        }
        catch (err) {
            console.error('Failed to send SuperAdmin notification:', err);
        }
    }
    res.status(201).json({
        accessToken,
        refreshToken,
        user: {
            id: user.id, name: user.name, email: user.email, role: user.role,
            clinicId, specialty: user.specialty, degrees: user.degrees,
            approvalStatus: user.approval_status,
        },
    });
});
// ─── Login ───────────────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
    const parsed = LoginSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0].message });
        return;
    }
    const { email, password, lat, lng, locationLabel } = parsed.data;
    // Accept email OR phone number in the identifier field
    const identifier = email.trim().toLowerCase();
    const isPhone = /^\+?[\d\s\-()]{7,15}$/.test(identifier.replace(/\s/g, ''));
    const [user] = isPhone
        ? await (0, db_1.default) `
        SELECT id, name, email, role, password_hash, specialty, degrees, phone, clinic_id, approval_status, consent_given_at
        FROM users WHERE REGEXP_REPLACE(phone, '[^0-9]', '', 'g') = REGEXP_REPLACE(${identifier}, '[^0-9]', '', 'g')
        ORDER BY id LIMIT 1
      `
        : await (0, db_1.default) `
        SELECT id, name, email, role, password_hash, specialty, degrees, phone, clinic_id, approval_status, consent_given_at
        FROM users WHERE email = ${identifier}
      `;
    if (!user) {
        res.status(401).json({ error: 'Invalid email or password' });
        return;
    }
    const valid = await bcryptjs_1.default.compare(password, user.password_hash);
    if (!valid) {
        res.status(401).json({ error: 'Invalid email or password' });
        return;
    }
    // ✅ Check approval status - only approved users can login
    const approvalStatus = user.approval_status;
    // Blocked by superadmin — no one with a suspended account may log in (any role)
    if (approvalStatus === 'suspended') {
        res.status(403).json({ error: 'Your account has been blocked. Please contact support at support@vyasaa.com.' });
        return;
    }
    if (user.role === 'clinic_admin' && approvalStatus !== 'approved') {
        if (approvalStatus === 'pending') {
            res.status(403).json({ error: 'Your account is pending approval. You will receive an email once approved.' });
        }
        else if (approvalStatus === 'rejected') {
            res.status(403).json({ error: 'Your account was rejected. Please contact support or reapply with corrected information.' });
        }
        return;
    }
    const payload = {
        userId: user.id,
        email: user.email,
        role: user.role,
        clinicId: user.clinic_id ?? '',
        name: user.name,
    };
    const { accessToken, refreshToken } = makeTokens(payload);
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    await (0, db_1.default) `INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES (${user.id}, ${refreshToken}, ${expiresAt})`;
    // Fire-and-forget session log (don't block the response)
    logLoginSession(req, { id: user.id, name: user.name, email: user.email, role: user.role }, { lat, lng, locationLabel }).catch(() => { });
    res.json({
        accessToken,
        refreshToken,
        user: { id: user.id, name: user.name, email: user.email, role: user.role, clinicId: user.clinic_id, specialty: user.specialty, degrees: user.degrees, approvalStatus: user.approval_status, consentGivenAt: user.consent_given_at ?? null },
    });
});
// ─── Refresh ─────────────────────────────────────────────────────────────────
router.post('/refresh', async (req, res) => {
    const { refreshToken } = req.body;
    if (!refreshToken) {
        res.status(400).json({ error: 'Missing refresh token' });
        return;
    }
    const [row] = await (0, db_1.default) `
    SELECT rt.user_id, rt.expires_at, u.name, u.email, u.role, u.clinic_id, u.specialty, u.degrees
    FROM refresh_tokens rt
    JOIN users u ON u.id = rt.user_id
    WHERE rt.token = ${refreshToken} AND rt.expires_at > NOW()
  `;
    if (!row) {
        res.status(401).json({ error: 'Invalid or expired refresh token' });
        return;
    }
    const payload = {
        userId: row.user_id,
        email: row.email,
        role: row.role,
        clinicId: row.clinic_id ?? '',
        name: row.name,
    };
    const accessToken = jsonwebtoken_1.default.sign(payload, process.env.JWT_SECRET, { expiresIn: '15m' });
    res.json({ accessToken });
});
// ─── Logout ──────────────────────────────────────────────────────────────────
router.post('/logout', async (req, res) => {
    const { refreshToken } = req.body;
    if (refreshToken) {
        await (0, db_1.default) `DELETE FROM refresh_tokens WHERE token = ${refreshToken}`;
    }
    res.json({ ok: true });
});
// ─── Record user consent to Privacy Policy & Terms ──────────────────────────
router.post('/consent', auth_1.requireAuth, async (req, res) => {
    const userId = req.user.userId;
    await (0, db_1.default) `UPDATE users SET consent_given_at = NOW() WHERE id = ${userId} AND consent_given_at IS NULL`;
    res.json({ ok: true, consentGivenAt: new Date().toISOString() });
});
// ─── Me ──────────────────────────────────────────────────────────────────────
router.get('/me', auth_1.requireAuth, async (req, res) => {
    const [user] = await (0, db_1.default) `
    SELECT u.id, u.name, u.email, u.role, u.specialty, u.degrees, u.phone, u.department,
           COALESCE(u.reg_number, u.license_number) AS reg_number,
           u.clinic_id, u.approval_status AS "approvalStatus",
           ps.doctor_name, ps.degrees AS pad_degrees, ps.specialty AS pad_specialty,
           COALESCE(ps.reg_number, u.license_number) AS pad_reg,
           ps.address, ps.phone AS pad_phone, ps.timings, ps.clinic_name, ps.footer_note,
           ps.quote, ps.show_quote, ps.show_timings, ps.show_email, ps.theme, ps.custom_fields
    FROM users u
    LEFT JOIN pad_settings ps ON ps.user_id = u.id
    WHERE u.id = ${req.user.userId}
  `;
    if (!user) {
        res.status(404).json({ error: 'User not found' });
        return;
    }
    res.json(user);
});
// ─── Update profile ───────────────────────────────────────────────────────────
router.patch('/me', auth_1.requireAuth, async (req, res) => {
    const { name, email, phone, specialty, degrees, regNumber, clinic_name, department, bio } = req.body;
    const userId = req.user.userId;
    // Update users table
    await (0, db_1.default) `
    UPDATE users SET
      name = COALESCE(${name ?? null}, name),
      email = COALESCE(${email ?? null}, email),
      phone = COALESCE(${phone ?? null}, phone),
      specialty = COALESCE(${specialty ?? null}, specialty),
      degrees = COALESCE(${degrees ?? null}, degrees),
      reg_number = COALESCE(${regNumber ?? null}, reg_number),
      clinic_name = COALESCE(${clinic_name ?? null}, clinic_name),
      department = COALESCE(${department ?? null}, department),
      bio = COALESCE(${bio ?? null}, bio)
    WHERE id = ${userId}
  `;
    // Mirror to pad_settings too (for doctors with PAD)
    await (0, db_1.default) `
    UPDATE pad_settings SET
      doctor_name = COALESCE(${name ?? null}, doctor_name),
      specialty = COALESCE(${specialty ?? null}, specialty),
      degrees = COALESCE(${degrees ?? null}, degrees),
      reg_number = COALESCE(${regNumber ?? null}, reg_number)
    WHERE user_id = ${userId}
  `;
    res.json({ ok: true });
});
// ─── Consult page section preferences ─────────────────────────────────────────
// Which sections a doctor wants always open in the Consult page, on top of the
// 5 core ones. Follows the doctor across devices — separate table from
// pad_settings since this is a UI preference, not print/letterhead data.
router.get('/me/consult-prefs', auth_1.requireAuth, async (req, res) => {
    const [row] = await (0, db_1.default) `SELECT pinned_sections FROM user_consult_prefs WHERE user_id = ${req.user.userId}`;
    res.json({ pinnedSections: row?.pinned_sections ?? [] });
});
router.put('/me/consult-prefs', auth_1.requireAuth, async (req, res) => {
    const { pinnedSections } = req.body;
    if (!Array.isArray(pinnedSections)) {
        res.status(400).json({ error: 'pinnedSections must be an array of section ids' });
        return;
    }
    await (0, db_1.default) `
    INSERT INTO user_consult_prefs (user_id, pinned_sections, updated_at)
    VALUES (${req.user.userId}, ${JSON.stringify(pinnedSections)}, NOW())
    ON CONFLICT (user_id) DO UPDATE
      SET pinned_sections = EXCLUDED.pinned_sections, updated_at = NOW()
  `;
    res.json({ ok: true });
});
exports.default = router;
