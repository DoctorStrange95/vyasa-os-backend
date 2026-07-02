import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import sql from '../db';
import { requireAuth, AuthPayload } from '../middleware/auth';

const router = Router();

const RegisterSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(6),
  role: z.string().optional(),
  specialty: z.string().optional(),
  degrees: z.string().optional(),
  phone: z.string().optional(),
  licenseNumber: z.string().optional(),
  medicalCouncil: z.string().optional(),
  regState: z.string().optional(),
  state: z.string().optional(),
  city: z.string().optional(),
  googleId: z.string().optional(),
  profilePhotoUrl: z.string().optional(),
  clinicIds: z.string().optional(),
  clinicName: z.string().optional(),
  invitedByUserId: z.number().optional(),
});

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
  lat: z.number().optional(),
  lng: z.number().optional(),
  locationLabel: z.string().optional(),
});

async function logLoginSession(
  req: Request,
  user: { id: number; name: string; email: string; role: string },
  geo?: { lat?: number; lng?: number; locationLabel?: string },
) {
  const ip = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim()
    ?? req.socket.remoteAddress ?? null;
  const ua = req.headers['user-agent'] ?? null;
  await sql`
    INSERT INTO login_sessions (user_id, user_name, user_email, user_role, ip_address, user_agent, lat, lng, location_label)
    VALUES (${user.id}, ${user.name}, ${user.email}, ${user.role},
            ${ip}, ${ua}, ${geo?.lat ?? null}, ${geo?.lng ?? null}, ${geo?.locationLabel ?? null})
  `;
}

function makeTokens(payload: AuthPayload) {
  const accessToken = jwt.sign(payload, process.env.JWT_SECRET!, { expiresIn: '15m' });
  const refreshToken = uuidv4();
  return { accessToken, refreshToken };
}

// ─── Register ────────────────────────────────────────────────────────────────

router.post('/register', async (req: Request, res: Response) => {
  const parsed = RegisterSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }
  const { name, email, password, role, specialty, degrees, phone, licenseNumber, medicalCouncil, regState, state, city, googleId, profilePhotoUrl, clinicIds, clinicName: invitedClinicName, invitedByUserId } = parsed.data;

  const passwordHash = await bcrypt.hash(password, 12);
  const effectiveRole = role ?? 'clinic_admin';
  // Superadmins are auto-approved; all others start as pending until license verified
  const approvalStatus = effectiveRole === 'superadmin' ? 'approved' : 'pending';

  // Check existing. A previously REJECTED account is allowed to reapply — we
  // reuse the same row (overwriting it with the new application and resetting
  // to pending) instead of deleting, which avoids any foreign-key issues.
  // Active / pending / blocked (suspended) accounts still cannot re-register.
  const [existing] = await sql`SELECT id, approval_status FROM users WHERE email = ${email}`;
  if (existing && existing.approval_status !== 'rejected') {
    res.status(409).json({ error: 'Email already registered' });
    return;
  }

  let user;
  if (existing) {
    // Re-application of a rejected doctor — refresh their record back to pending
    [user] = await sql`
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
  } else {
    [user] = await sql`
      INSERT INTO users (name, email, password_hash, role, specialty, degrees, phone, license_number, medical_council, reg_state, state, city, google_id, profile_photo_url, approval_status, invited_clinic_ids, invited_clinic_name, invited_by_user_id)
      VALUES (${name}, ${email}, ${passwordHash}, ${effectiveRole}, ${specialty ?? null}, ${degrees ?? null}, ${phone ?? null},
              ${licenseNumber ?? null}, ${medicalCouncil ?? null}, ${regState ?? null}, ${state ?? null}, ${city ?? null}, ${googleId ?? null}, ${profilePhotoUrl ?? null}, ${approvalStatus},
              ${clinicIds ?? null}, ${invitedClinicName ?? null}, ${invitedByUserId ?? null})
      RETURNING id, name, email, role, specialty, degrees, phone, clinic_id, approval_status
    `;
  }

  // Auto-create a default clinic for clinic_admin
  let clinicId = user.clinic_id as string | null;
  if (effectiveRole === 'clinic_admin' && !clinicId) {
    clinicId = `clinic_${user.id}`;
    const clinicName = `${name}'s Clinic`;
    await sql`
      INSERT INTO clinics (id, owner_id, name, address, fee, max_patients)
      VALUES (${clinicId}, ${user.id}, ${clinicName}, '', 200, 30)
      ON CONFLICT DO NOTHING
    `;
    await sql`UPDATE users SET clinic_id = ${clinicId} WHERE id = ${user.id}`;
    await sql`
      INSERT INTO pad_settings (user_id, doctor_name, clinic_name)
      VALUES (${user.id}, ${name}, ${clinicName})
      ON CONFLICT DO NOTHING
    `;
  }

  const payload: AuthPayload = {
    userId: user.id as number,
    email: user.email as string,
    role: user.role as string,
    clinicId: clinicId ?? '',
    name: user.name as string,
    approvalStatus: user.approval_status as string,
  };

  const { accessToken, refreshToken } = makeTokens(payload);

  // Store refresh token (30 days)
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await sql`
    INSERT INTO refresh_tokens (user_id, token, expires_at)
    VALUES (${user.id}, ${refreshToken}, ${expiresAt})
  `;

  // Send notification email to SuperAdmin (fire-and-forget)
  if (effectiveRole === 'clinic_admin') {
    try {
      const { newUserRegistrationEmail, sendMail } = await import('../lib/mailer');
      const [superadmin] = await sql`SELECT email FROM users WHERE role = 'superadmin' LIMIT 1`;
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
        sendMail(superadmin.email as string, emailData.subject, emailData.html);
      }
    } catch (err) {
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

router.post('/login', async (req: Request, res: Response) => {
  const parsed = LoginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }
  const { email, password, lat, lng, locationLabel } = parsed.data;

  const [user] = await sql`
    SELECT id, name, email, role, password_hash, specialty, degrees, phone, clinic_id, approval_status, consent_given_at
    FROM users WHERE email = ${email}
  `;
  if (!user) {
    res.status(401).json({ error: 'Invalid email or password' });
    return;
  }

  const valid = await bcrypt.compare(password, user.password_hash as string);
  if (!valid) {
    res.status(401).json({ error: 'Invalid email or password' });
    return;
  }

  // ✅ Check approval status - only approved users can login
  const approvalStatus = user.approval_status as string;
  // Blocked by superadmin — no one with a suspended account may log in (any role)
  if (approvalStatus === 'suspended') {
    res.status(403).json({ error: 'Your account has been blocked. Please contact support at support@vyasaa.com.' });
    return;
  }
  if (user.role === 'clinic_admin' && approvalStatus !== 'approved') {
    if (approvalStatus === 'pending') {
      res.status(403).json({ error: 'Your account is pending approval. You will receive an email once approved.' });
    } else if (approvalStatus === 'rejected') {
      res.status(403).json({ error: 'Your account was rejected. Please contact support or reapply with corrected information.' });
    }
    return;
  }

  const payload: AuthPayload = {
    userId: user.id as number,
    email: user.email as string,
    role: user.role as string,
    clinicId: (user.clinic_id as string) ?? '',
    name: user.name as string,
  };

  const { accessToken, refreshToken } = makeTokens(payload);

  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await sql`INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES (${user.id}, ${refreshToken}, ${expiresAt})`;

  // Fire-and-forget session log (don't block the response)
  logLoginSession(req, { id: user.id as number, name: user.name as string, email: user.email as string, role: user.role as string }, { lat, lng, locationLabel }).catch(() => {});

  res.json({
    accessToken,
    refreshToken,
    user: { id: user.id, name: user.name, email: user.email, role: user.role, clinicId: user.clinic_id, specialty: user.specialty, degrees: user.degrees, approvalStatus: user.approval_status, consentGivenAt: user.consent_given_at ?? null },
  });
});

// ─── Refresh ─────────────────────────────────────────────────────────────────

router.post('/refresh', async (req: Request, res: Response) => {
  const { refreshToken } = req.body;
  if (!refreshToken) {
    res.status(400).json({ error: 'Missing refresh token' });
    return;
  }

  const [row] = await sql`
    SELECT rt.user_id, rt.expires_at, u.name, u.email, u.role, u.clinic_id, u.specialty, u.degrees
    FROM refresh_tokens rt
    JOIN users u ON u.id = rt.user_id
    WHERE rt.token = ${refreshToken} AND rt.expires_at > NOW()
  `;
  if (!row) {
    res.status(401).json({ error: 'Invalid or expired refresh token' });
    return;
  }

  const payload: AuthPayload = {
    userId: row.user_id as number,
    email: row.email as string,
    role: row.role as string,
    clinicId: (row.clinic_id as string) ?? '',
    name: row.name as string,
  };

  const accessToken = jwt.sign(payload, process.env.JWT_SECRET!, { expiresIn: '15m' });

  res.json({ accessToken });
});

// ─── Logout ──────────────────────────────────────────────────────────────────

router.post('/logout', async (req: Request, res: Response) => {
  const { refreshToken } = req.body;
  if (refreshToken) {
    await sql`DELETE FROM refresh_tokens WHERE token = ${refreshToken}`;
  }
  res.json({ ok: true });
});

// ─── Record user consent to Privacy Policy & Terms ──────────────────────────

router.post('/consent', requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  await sql`UPDATE users SET consent_given_at = NOW() WHERE id = ${userId} AND consent_given_at IS NULL`;
  res.json({ ok: true, consentGivenAt: new Date().toISOString() });
});

// ─── Me ──────────────────────────────────────────────────────────────────────

router.get('/me', requireAuth, async (req: Request, res: Response) => {
  const [user] = await sql`
    SELECT u.id, u.name, u.email, u.role, u.specialty, u.degrees, u.phone, u.department,
           COALESCE(u.reg_number, u.license_number) AS reg_number,
           u.clinic_id, u.approval_status AS "approvalStatus",
           ps.doctor_name, ps.degrees AS pad_degrees, ps.specialty AS pad_specialty,
           COALESCE(ps.reg_number, u.license_number) AS pad_reg,
           ps.address, ps.phone AS pad_phone, ps.timings, ps.clinic_name, ps.footer_note,
           ps.quote, ps.show_quote, ps.show_timings, ps.show_email, ps.theme, ps.custom_fields
    FROM users u
    LEFT JOIN pad_settings ps ON ps.user_id = u.id
    WHERE u.id = ${req.user!.userId}
  `;
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  res.json(user);
});

// ─── Update profile ───────────────────────────────────────────────────────────

router.patch('/me', requireAuth, async (req: Request, res: Response) => {
  const { name, email, phone, specialty, degrees, regNumber, clinic_name, department, bio } = req.body as {
    name?: string; email?: string; phone?: string; specialty?: string; degrees?: string; regNumber?: string;
    clinic_name?: string; department?: string; bio?: string;
  };
  const userId = req.user!.userId;

  // Update users table
  await sql`
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
  await sql`
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

router.get('/me/consult-prefs', requireAuth, async (req: Request, res: Response) => {
  const [row] = await sql`SELECT pinned_sections FROM user_consult_prefs WHERE user_id = ${req.user!.userId}`;
  res.json({ pinnedSections: row?.pinned_sections ?? [] });
});

router.put('/me/consult-prefs', requireAuth, async (req: Request, res: Response) => {
  const { pinnedSections } = req.body as { pinnedSections?: string[] };
  if (!Array.isArray(pinnedSections)) {
    res.status(400).json({ error: 'pinnedSections must be an array of section ids' });
    return;
  }
  await sql`
    INSERT INTO user_consult_prefs (user_id, pinned_sections, updated_at)
    VALUES (${req.user!.userId}, ${JSON.stringify(pinnedSections)}, NOW())
    ON CONFLICT (user_id) DO UPDATE
      SET pinned_sections = EXCLUDED.pinned_sections, updated_at = NOW()
  `;
  res.json({ ok: true });
});

export default router;
