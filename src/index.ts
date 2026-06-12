import 'dotenv/config';
import 'express-async-errors'; // patches Express 4 so thrown async errors reach the error middleware
import express from 'express';
import http from 'http';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import morgan from 'morgan';
import { Server as SocketIO } from 'socket.io';
import jwt from 'jsonwebtoken';
import { OAuth2Client } from 'google-auth-library';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';

import sql, { runMigrations } from './db';
import authRouter from './routes/auth';
import patientsRouter from './routes/patients';
import visitsRouter from './routes/visits';
import vitalsRouter from './routes/vitals';
import appointmentsRouter from './routes/appointments';
import clinicsRouter from './routes/clinics';
import chatRouter from './routes/chat';
import adminRouter from './routes/admin';
import staffRouter from './routes/staff';
import publicRouter from './routes/public';
import { AuthPayload } from './middleware/auth';

const app = express();
const server = http.createServer(app);

// ─── CORS ─────────────────────────────────────────────────────────────────────

const ALLOWED_ORIGINS = [
  process.env.CLIENT_ORIGIN ?? 'https://vyasa-health-os.pages.dev',
  'https://app.vyasaa.com',
  'https://vyasaa.com',
  'https://www.vyasaa.com',
  'http://localhost:5173',
  'http://localhost:3000',
];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.some(o => origin.startsWith(o))) {
      cb(null, true);
    } else {
      cb(new Error(`CORS blocked: ${origin}`));
    }
  },
  credentials: true,
}));

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '10mb' }));

// Brute-force protection on credential endpoints (per-IP)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again in a few minutes.' },
});
app.use('/auth/login', authLimiter);
app.use('/auth/register', authLimiter);
app.use('/auth/google', authLimiter);

// ─── Socket.io ────────────────────────────────────────────────────────────────

const io = new SocketIO(server, {
  cors: { origin: ALLOWED_ORIGINS, methods: ['GET', 'POST'], credentials: true },
});

io.use((socket, next) => {
  const token = socket.handshake.auth.token as string;
  if (!token) { next(new Error('Missing token')); return; }
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!) as AuthPayload;
    (socket as unknown as { user: AuthPayload }).user = payload;
    next();
  } catch {
    next(new Error('Invalid token'));
  }
});

io.on('connection', socket => {
  const user = (socket as unknown as { user: AuthPayload }).user;
  const clinicId = user.clinicId;

  // Join clinic room
  socket.join(`clinic:${clinicId}`);

  // Join patient room on request
  socket.on('join_patient', (patientId: string) => {
    socket.join(`patient:${patientId}`);
  });

  socket.on('leave_patient', (patientId: string) => {
    socket.leave(`patient:${patientId}`);
  });

  // Chat message
  socket.on('chat_message', async (data: { patientId: string; message: string; type?: string }) => {
    const id = `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const time = new Date().toISOString();
    const msg = {
      id, patientId: data.patientId, clinicId,
      senderId: user.userId, senderName: user.name, senderRole: user.role,
      message: data.message, type: data.type ?? 'message', time,
    };
    // Persist to DB — never let a DB failure crash the socket or drop silently
    try {
      await sql`
        INSERT INTO chat_messages (id, patient_id, clinic_id, sender_id, sender_name, sender_role, message, type, time)
        VALUES (${id}, ${data.patientId}, ${clinicId}, ${user.userId}, ${user.name}, ${user.role},
                ${data.message}, ${data.type ?? 'message'}, ${time})
      `;
    } catch (err) {
      console.error('[chat_message persist failed]', err);
      socket.emit('chat_error', { id, error: 'Message could not be saved. Please retry.' });
      return;
    }
    // Broadcast to everyone in the patient room
    io.to(`patient:${data.patientId}`).emit('chat_message', msg);
  });

  socket.on('vitals_update', (data: unknown) => {
    socket.to(`clinic:${clinicId}`).emit('vitals_update', data);
  });

  socket.on('patient_status_change', (data: unknown) => {
    socket.to(`clinic:${clinicId}`).emit('patient_status_change', data);
  });

  socket.on('disconnect', () => {
    // cleanup handled by socket.io
  });
});

// ─── Google OAuth ─────────────────────────────────────────────────────────────

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

app.post('/auth/google', async (req, res) => {
  const { idToken, accessToken: googleAccessToken, lat, lng, locationLabel } = req.body as {
    idToken?: string; accessToken?: string;
    lat?: number; lng?: number; locationLabel?: string;
  };

  let googleEmail = '', googleName = 'Doctor';

  // Try ID token first (from GoogleLogin component)
  if (idToken) {
    try {
      const ticket = await googleClient.verifyIdToken({ idToken, audience: process.env.GOOGLE_CLIENT_ID });
      const payload = ticket.getPayload()!;
      googleEmail = payload.email!;
      googleName = payload.name ?? 'Doctor';
    } catch { /* fall through to access token */ }
  }

  // Fall back to access token (from useGoogleLogin hook with flow='implicit')
  if (!googleEmail && googleAccessToken) {
    try {
      const r = await fetch(`https://www.googleapis.com/oauth2/v3/userinfo`, {
        headers: { Authorization: `Bearer ${googleAccessToken}` },
      });
      if (r.ok) {
        const info = await r.json() as { email?: string; name?: string };
        googleEmail = info.email ?? '';
        googleName = info.name ?? 'Doctor';
      }
    } catch { /* fall through */ }
  }

  if (!googleEmail) {
    res.status(401).json({ error: 'Invalid Google token' });
    return;
  }

  // Check if user exists
  const [existing] = await sql`SELECT * FROM users WHERE email = ${googleEmail}`;

  if (existing) {
    // User exists — return tokens
    const p: AuthPayload = {
      userId: existing.id as number,
      email: existing.email as string,
      role: existing.role as string,
      clinicId: (existing.clinic_id as string) ?? '',
      name: existing.name as string,
    };
    const accessToken = jwt.sign(p, process.env.JWT_SECRET!, { expiresIn: '15m' });
    const refreshToken = uuidv4();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    await sql`INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES (${existing.id}, ${refreshToken}, ${expiresAt})`;

    // Log this login session
    const ip = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ?? req.socket.remoteAddress ?? null;
    sql`INSERT INTO login_sessions (user_id, user_name, user_email, user_role, ip_address, user_agent, lat, lng, location_label)
        VALUES (${existing.id}, ${existing.name as string}, ${existing.email as string}, ${existing.role as string},
                ${ip}, ${req.headers['user-agent'] ?? null}, ${lat ?? null}, ${lng ?? null}, ${locationLabel ?? null})`.catch(() => {});

    res.json({
      accessToken, refreshToken,
      user: { id: existing.id, name: existing.name, email: existing.email, role: existing.role, clinicId: existing.clinic_id, approvalStatus: existing.approval_status },
      isNewUser: false,
    });
  } else {
    // New user — return partial data so frontend shows registration form
    res.json({
      isNewUser: true,
      googleEmail,
      googleName,
    });
  }
});

// ─── Routes ───────────────────────────────────────────────────────────────────

app.use('/auth', authRouter);
app.use('/patients', patientsRouter);
app.use('/visits', visitsRouter);
app.use('/vitals', vitalsRouter);
app.use('/appointments', appointmentsRouter);
app.use('/clinics', clinicsRouter);
app.use('/chat', chatRouter);
app.use('/admin', adminRouter);
app.use('/staff', staffRouter);
app.use('/public', publicRouter);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// ─── Public profile settings (authenticated) ──────────────────────────────────
import { requireAuth } from './middleware/auth';

app.patch('/auth/me/public-profile', requireAuth, async (req, res) => {
  const userId = req.user!.userId;
  const {
    bio, languages, accepting_patients, public_profile_enabled,
    gbp_url, years_experience, consultation_fee, profile_photo_url,
    education, services, awards, state, city,
  } = req.body as Record<string, unknown>;
  try {
    const ap  = accepting_patients   != null ? Boolean(accepting_patients)   : null;
    const ppe = public_profile_enabled != null ? Boolean(public_profile_enabled) : null;
    const ye  = years_experience      != null ? Math.round(Number(years_experience)) : null;
    const cf  = consultation_fee      != null ? Math.round(Number(consultation_fee)) : null;
    const rows = await sql`
      UPDATE users SET
        bio                    = COALESCE(${(bio            ?? null) as string | null}::text,    bio),
        languages              = COALESCE(${(languages      ?? null) as string | null}::text,    languages),
        accepting_patients     = COALESCE(${ap}::boolean,   accepting_patients),
        public_profile_enabled = COALESCE(${ppe}::boolean,  public_profile_enabled),
        gbp_url                = COALESCE(${(gbp_url        ?? null) as string | null}::text,    gbp_url),
        years_experience       = COALESCE(${ye}::integer,   years_experience),
        consultation_fee       = COALESCE(${cf}::integer,   consultation_fee),
        profile_photo_url      = COALESCE(${(profile_photo_url ?? null) as string | null}::text, profile_photo_url),
        education              = COALESCE(${(education      ?? null) as string | null}::text,    education),
        services               = COALESCE(${(services       ?? null) as string | null}::text,    services),
        awards                 = COALESCE(${(awards         ?? null) as string | null}::text,    awards),
        state                  = COALESCE(${(state          ?? null) as string | null}::text,    state),
        city                   = COALESCE(${(city           ?? null) as string | null}::text,    city)
      WHERE id = ${userId}
      RETURNING profile_slug, accepting_patients, public_profile_enabled, bio,
                gbp_url, languages, years_experience, consultation_fee, profile_photo_url,
                education, services, awards, state, city
    `;
    res.json(rows[0] ?? {});
  } catch (e: any) {
    console.error('[public-profile PATCH]', e);
    res.status(500).json({ error: e.message ?? 'Database error' });
  }
});

app.get('/auth/me/public-profile', requireAuth, async (req, res) => {
  const userId = req.user!.userId;
  try {
    const rows = await sql`
      SELECT profile_slug, accepting_patients, public_profile_enabled, bio,
             gbp_url, languages, years_experience, consultation_fee, profile_photo_url,
             education, services, awards, state, city
      FROM users WHERE id = ${userId}
    `;
    res.json(rows[0] ?? null);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── Booking requests (authenticated) ────────────────────────────────────────
app.get('/booking-requests', requireAuth, async (req, res) => {
  const userId = req.user!.userId;
  const { status } = req.query;
  try {
    const rows = status
      ? await sql`
          SELECT br.*, c.name AS clinic_name FROM booking_requests br
          LEFT JOIN clinics c ON c.id = br.clinic_id
          WHERE br.doctor_id = ${userId} AND br.status = ${status as string}
          ORDER BY br.created_at DESC`
      : await sql`
          SELECT br.*, c.name AS clinic_name FROM booking_requests br
          LEFT JOIN clinics c ON c.id = br.clinic_id
          WHERE br.doctor_id = ${userId}
          ORDER BY br.created_at DESC LIMIT 200`;
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.patch('/booking-requests/:id', requireAuth, async (req, res) => {
  const userId = req.user!.userId;
  const { status, notes } = req.body;
  if (!['confirmed', 'cancelled', 'pending'].includes(status)) {
    res.status(400).json({ error: 'Invalid status' }); return;
  }
  try {
    const rows = await sql`
      UPDATE booking_requests
      SET status = ${status}::text,
          notes = COALESCE(${notes ?? null}::text, notes),
          confirmed_at = CASE WHEN ${status}::text = 'confirmed' THEN NOW() ELSE NULL END,
          confirmed_by = CASE WHEN ${status}::text = 'confirmed' THEN ${userId}::integer ELSE NULL END
      WHERE id = ${Number(req.params.id)} AND doctor_id = ${userId}
      RETURNING *
    `;
    if (!rows.length) { res.status(404).json({ error: 'Not found' }); return; }
    res.json(rows[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── Global error handler (catches sync + async route errors) ────────────────

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[unhandled route error]', err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT ?? 3001);

async function start() {
  await runMigrations();

  // Ensure superadmin exists
  const [sa] = await sql`SELECT id FROM users WHERE role = 'superadmin' LIMIT 1`;
  if (!sa) {
    const saEmail = process.env.SUPERADMIN_EMAIL ?? 'admin@vyasa.health';
    const saPass = process.env.SUPERADMIN_PASSWORD ?? 'VyasaAdmin2024!';
    const hash = await bcrypt.hash(saPass, 12);
    await sql`
      INSERT INTO users (name, email, password_hash, role, approval_status)
      VALUES ('Vyasa Admin', ${saEmail}, ${hash}, 'superadmin', 'approved')
      ON CONFLICT DO NOTHING
    `;
    console.log(`🔑 Superadmin created: ${saEmail}`);
  }

  server.listen(PORT, () => {
    console.log(`🚀 Vyasa backend running on port ${PORT}`);
  });
}

start().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
