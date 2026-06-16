import nodemailer from 'nodemailer';

// Email transport, in order of preference:
//   1. BREVO_API_KEY — Brevo HTTP API over port 443. REQUIRED on Render free
//      tier, which blocks ALL outbound SMTP ports (25/465/587).
//   2. SMTP_HOST/PORT/USER/PASS — classic SMTP (works on hosts without the block)
// SMTP_FROM is used by both, e.g. 'Vyasa Health <support@vyasaa.com>'.
// If neither is configured, emails are skipped with a console warning.

const BREVO_KEY = process.env.BREVO_API_KEY;
const smtpConfigured = Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);

const transporter = !BREVO_KEY && smtpConfigured
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT ?? 587),
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      // Fail fast instead of hanging silently when the SMTP host is unreachable
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
    })
  : null;

if (BREVO_KEY) {
  console.log('✉️  Mailer ready: Brevo HTTP API (port 443)');
} else if (transporter) {
  transporter.verify()
    .then(() => console.log(`✉️  SMTP ready (${process.env.SMTP_HOST} as ${process.env.SMTP_USER})`))
    .catch(err => console.error(`✉️  SMTP VERIFY FAILED (${process.env.SMTP_HOST}): ${err.message}`));
} else {
  console.warn('✉️  No BREVO_API_KEY or SMTP_* env vars — transactional emails are disabled.');
}

const FROM = process.env.SMTP_FROM ?? 'Vyasa Health <no-reply@vyasaa.com>';

function parseFrom(): { name?: string; email: string } {
  const m = FROM.match(/^(.*)<(.+)>\s*$/);
  return m ? { name: m[1].trim().replace(/^"|"$/g, ''), email: m[2].trim() } : { email: FROM.trim() };
}

async function sendViaBrevoApi(to: string, subject: string, html: string): Promise<void> {
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': BREVO_KEY!, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ sender: parseFrom(), to: [{ email: to }], subject, htmlContent: html }),
  });
  if (!res.ok) throw new Error(`Brevo API ${res.status}: ${await res.text()}`);
}
const TEAL = '#0d9488';
const NAVY = '#0f2040';

function layout(title: string, body: string): string {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 0">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:14px;overflow:hidden">
        <tr><td style="background:${NAVY};padding:18px 28px">
          <table cellpadding="0" cellspacing="0"><tr>
            <td><img src="https://www.vyasaa.com/logo.png" width="36" height="36" alt="Vyasa" style="display:block;border-radius:8px" /></td>
            <td style="padding-left:12px"><span style="color:#ffffff;font-size:18px;font-weight:bold">Vyasa Integrated Healthcare</span></td>
          </tr></table>
        </td></tr>
        <tr><td style="padding:28px">
          <h2 style="margin:0 0 14px;color:#0f172a;font-size:20px">${title}</h2>
          ${body}
        </td></tr>
        <tr><td style="padding:16px 28px;border-top:1px solid #f1f5f9">
          <p style="margin:0;color:#94a3b8;font-size:12px">Vyasa Integrated Healthcare · <a href="https://vyasaa.com" style="color:${TEAL};text-decoration:none">vyasaa.com</a></p>
        </td></tr>
      </table>
    </td></tr>
  </table></body></html>`;
}

// Fire-and-forget — never block or fail a request because of email
export function sendMail(to: string, subject: string, html: string): void {
  if (!BREVO_KEY && !transporter) { console.warn(`✉️  skipped (mailer unconfigured): "${subject}" → ${to}`); return; }
  if (!to) { console.warn(`✉️  skipped (no recipient): "${subject}"`); return; }
  console.log(`✉️  sending "${subject}" → ${to}…`);
  const send = BREVO_KEY
    ? sendViaBrevoApi(to, subject, html)
    : transporter!.sendMail({ from: FROM, to, subject, html }).then(() => undefined);
  send
    .then(() => console.log(`✉️  sent "${subject}" → ${to}`))
    .catch(err => console.error(`✉️  FAILED "${subject}" → ${to}:`, err.message));
}

// ─── Templates ────────────────────────────────────────────────────────────────

export function approvalEmail(doctorName: string): { subject: string; html: string } {
  return {
    subject: '🎉 Your Vyasa account is verified — welcome aboard!',
    html: layout('Congratulations, Dr. ' + doctorName + '!', `
      <p style="color:#475569;font-size:14px;line-height:1.7">
        Your medical registration has been <strong>verified</strong> and your account is now active.
        You can sign in and start using the full Vyasa Health OS platform — digital prescriptions,
        your public booking page, patient records, and more.
      </p>
      <p style="margin:22px 0">
        <a href="https://app.vyasaa.com/login" style="background:${TEAL};color:#fff;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:10px;font-size:14px">Open Vyasa Health OS →</a>
      </p>
      <p style="color:#94a3b8;font-size:12px;line-height:1.6">
        Tip: complete your public profile (photo, services, schedule) under My Profile → Public Profile
        so patients can find and book you at vyasaa.com.
      </p>`),
  };
}

export function rejectionEmail(doctorName: string, reason: string): { subject: string; html: string } {
  return {
    subject: 'Your Vyasa registration — updates needed',
    html: layout('Registration update needed', `
      <p style="color:#475569;font-size:14px;line-height:1.7">Hi Dr. ${doctorName},</p>
      <p style="color:#475569;font-size:14px;line-height:1.7">
        Thank you for registering with Vyasa Integrated Healthcare. Your account requires updates before approval.
      </p>
      <p style="background:#fef2f2;border-left:4px solid #dc2626;padding:14px;border-radius:4px;color:#7f1d1d;font-size:13px;line-height:1.6">
        <strong>Reason:</strong> ${reason}
      </p>
      <p style="color:#475569;font-size:14px;line-height:1.7">
        Please update your information and reapply. If you have questions, contact our support team at <strong>support@vyasaa.com</strong>.
      </p>
      <p style="margin:22px 0">
        <a href="https://app.vyasaa.com/login" style="background:${TEAL};color:#fff;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:10px;font-size:14px">Reapply now →</a>
      </p>`),
  };
}

export function newBookingDoctorEmail(d: {
  doctorName: string; patientName: string; patientPhone: string;
  date: string; time: string; clinicName?: string; reason?: string;
}): { subject: string; html: string } {
  return {
    subject: `🩺 New booking request — ${d.patientName}, ${d.date} ${d.time}`,
    html: layout('New appointment request', `
      <p style="color:#475569;font-size:14px;line-height:1.7">Dr. ${d.doctorName}, a patient just requested an appointment:</p>
      <table cellpadding="6" style="font-size:14px;color:#0f172a">
        <tr><td style="color:#94a3b8">Patient</td><td><strong>${d.patientName}</strong></td></tr>
        <tr><td style="color:#94a3b8">Phone</td><td>+91 ${d.patientPhone}</td></tr>
        <tr><td style="color:#94a3b8">When</td><td><strong>${d.date} at ${d.time}</strong></td></tr>
        ${d.clinicName ? `<tr><td style="color:#94a3b8">Clinic</td><td>${d.clinicName}</td></tr>` : ''}
        ${d.reason ? `<tr><td style="color:#94a3b8">Reason</td><td>${d.reason}</td></tr>` : ''}
      </table>
      <p style="margin:22px 0 0">
        <a href="https://app.vyasaa.com/app/bookings" style="background:${TEAL};color:#fff;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:10px;font-size:14px">Confirm or manage →</a>
      </p>`),
  };
}

export function bookingConfirmedPatientEmail(d: {
  patientName: string; doctorName: string; date: string; time: string;
  clinicName?: string; clinicAddress?: string; clinicPhone?: string; fee?: number | null;
}): { subject: string; html: string } {
  return {
    subject: `✅ Appointment confirmed — Dr. ${d.doctorName}, ${d.date} ${d.time}`,
    html: layout('Your appointment is confirmed', `
      <p style="color:#475569;font-size:14px;line-height:1.7">Hi ${d.patientName}, Dr. ${d.doctorName} has confirmed your appointment.</p>
      <table cellpadding="6" style="font-size:14px;color:#0f172a">
        <tr><td style="color:#94a3b8">Date & time</td><td><strong>${d.date} at ${d.time}</strong></td></tr>
        ${d.clinicName ? `<tr><td style="color:#94a3b8">Clinic</td><td>${d.clinicName}</td></tr>` : ''}
        ${d.clinicAddress ? `<tr><td style="color:#94a3b8">Address</td><td>${d.clinicAddress}</td></tr>` : ''}
        ${d.clinicPhone ? `<tr><td style="color:#94a3b8">Contact</td><td>${d.clinicPhone}</td></tr>` : ''}
        ${d.fee ? `<tr><td style="color:#94a3b8">Consultation fee</td><td>₹${d.fee}</td></tr>` : ''}
      </table>
      <p style="color:#94a3b8;font-size:12px;line-height:1.6;margin-top:18px">
        Please arrive 10 minutes early. If you need to reschedule, call the clinic directly.
      </p>`),
  };
}
