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
  googleId: z.string().optional(),
});

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

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
  const { name, email, password, role, specialty, degrees, phone, licenseNumber, googleId } = parsed.data;

  // Check existing
  const existing = await sql`SELECT id FROM users WHERE email = ${email}`;
  if (existing.length > 0) {
    res.status(409).json({ error: 'Email already registered' });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const effectiveRole = role ?? 'clinic_admin';
  // Superadmins are auto-approved; all others start as pending until license verified
  const approvalStatus = effectiveRole === 'superadmin' ? 'approved' : 'pending';

  // Insert user
  const [user] = await sql`
    INSERT INTO users (name, email, password_hash, role, specialty, degrees, phone, license_number, google_id, approval_status)
    VALUES (${name}, ${email}, ${passwordHash}, ${effectiveRole}, ${specialty ?? null}, ${degrees ?? null}, ${phone ?? null},
            ${licenseNumber ?? null}, ${googleId ?? null}, ${approvalStatus})
    RETURNING id, name, email, role, specialty, degrees, phone, clinic_id, approval_status
  `;

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
  const { email, password } = parsed.data;

  const [user] = await sql`
    SELECT id, name, email, role, password_hash, specialty, degrees, phone, clinic_id, approval_status
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

  const payload: AuthPayload = {
    userId: user.id as number,
    email: user.email as string,
    role: user.role as string,
    clinicId: (user.clinic_id as string) ?? '',
    name: user.name as string,
  };

  const { accessToken, refreshToken } = makeTokens(payload);

  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await sql`
    INSERT INTO refresh_tokens (user_id, token, expires_at)
    VALUES (${user.id}, ${refreshToken}, ${expiresAt})
  `;

  res.json({
    accessToken,
    refreshToken,
    user: { id: user.id, name: user.name, email: user.email, role: user.role, clinicId: user.clinic_id, specialty: user.specialty, degrees: user.degrees, approvalStatus: user.approval_status },
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

// ─── Me ──────────────────────────────────────────────────────────────────────

router.get('/me', requireAuth, async (req: Request, res: Response) => {
  const [user] = await sql`
    SELECT u.id, u.name, u.email, u.role, u.specialty, u.degrees, u.phone, u.reg_number, u.clinic_id,
           ps.doctor_name, ps.degrees AS pad_degrees, ps.specialty AS pad_specialty, ps.reg_number AS pad_reg,
           ps.address, ps.phone AS pad_phone, ps.timings, ps.clinic_name, ps.footer_note,
           ps.quote, ps.show_quote, ps.show_timings, ps.theme, ps.custom_fields
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

export default router;
