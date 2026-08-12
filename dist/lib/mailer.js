"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendMail = sendMail;
exports.partnerApplicationNotification = partnerApplicationNotification;
exports.approvalEmail = approvalEmail;
exports.rejectionEmail = rejectionEmail;
exports.approvalEmailWithTime = approvalEmailWithTime;
exports.newUserRegistrationEmail = newUserRegistrationEmail;
exports.newBookingDoctorEmail = newBookingDoctorEmail;
exports.bookingConfirmedPatientEmail = bookingConfirmedPatientEmail;
const nodemailer_1 = __importDefault(require("nodemailer"));
// Email transport, in order of preference:
//   1. BREVO_API_KEY — Brevo HTTP API over port 443. REQUIRED on Render free
//      tier, which blocks ALL outbound SMTP ports (25/465/587).
//   2. SMTP_HOST/PORT/USER/PASS — classic SMTP (works on hosts without the block)
// SMTP_FROM is used by both, e.g. 'Vyasa Health <support@vyasaa.com>'.
// If neither is configured, emails are skipped with a console warning.
const BREVO_KEY = process.env.BREVO_API_KEY;
const smtpConfigured = Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
const transporter = !BREVO_KEY && smtpConfigured
    ? nodemailer_1.default.createTransport({
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
}
else if (transporter) {
    transporter.verify()
        .then(() => console.log(`✉️  SMTP ready (${process.env.SMTP_HOST} as ${process.env.SMTP_USER})`))
        .catch(err => console.error(`✉️  SMTP VERIFY FAILED (${process.env.SMTP_HOST}): ${err.message}`));
}
else {
    console.warn('✉️  No BREVO_API_KEY or SMTP_* env vars — transactional emails are disabled.');
}
const FROM = process.env.SMTP_FROM ?? 'Vyasa Health <no-reply@vyasaa.com>';
function parseFrom() {
    const m = FROM.match(/^(.*)<(.+)>\s*$/);
    return m ? { name: m[1].trim().replace(/^"|"$/g, ''), email: m[2].trim() } : { email: FROM.trim() };
}
async function sendViaBrevoApi(to, subject, html, cc = []) {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': BREVO_KEY, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
            sender: parseFrom(),
            to: [{ email: to }],
            ...(cc.length ? { cc: cc.map(email => ({ email })) } : {}),
            subject,
            htmlContent: html,
        }),
    });
    if (!res.ok)
        throw new Error(`Brevo API ${res.status}: ${await res.text()}`);
}
const TEAL = '#0d9488';
const NAVY = '#0f2040';
function layout(title, body) {
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
function sendMail(to, subject, html, cc = []) {
    if (!BREVO_KEY && !transporter) {
        console.warn(`✉️  skipped (mailer unconfigured): "${subject}" → ${to}`);
        return;
    }
    if (!to) {
        console.warn(`✉️  skipped (no recipient): "${subject}"`);
        return;
    }
    console.log(`✉️  sending "${subject}" → ${to}…`);
    const send = BREVO_KEY
        ? sendViaBrevoApi(to, subject, html, cc)
        : transporter.sendMail({ from: FROM, to, cc, subject, html }).then(() => undefined);
    send
        .then(() => console.log(`✉️  sent "${subject}" → ${to}`))
        .catch(err => console.error(`✉️  FAILED "${subject}" → ${to}:`, err.message));
}
function escapeHtml(value) {
    return value.replace(/[&<>"']/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[char]));
}
function partnerApplicationNotification(application) {
    const type = application.partnerType === 'lab' ? 'Laboratory' : 'Pharmacy';
    const field = (label, value) => `<p style="margin:0 0 10px;color:#475569;font-size:14px"><strong style="color:#0f172a">${label}:</strong> ${escapeHtml(value || '—')}</p>`;
    return {
        subject: `New ${type.toLowerCase()} partnership interest — ${application.organisation}`,
        html: layout(`New ${type} partnership interest`, `
      <p style="color:#475569;font-size:14px;line-height:1.7">A new partnership interest was saved in Vyasa Super Admin.</p>
      ${field('Organisation', application.organisation)}
      ${field('Contact', application.contactName)}
      ${field('Email', application.email)}
      ${field('Phone', application.phone)}
      ${field('Location', application.location)}
      ${field('Notes', application.note)}
      <p style="margin:22px 0"><a href="https://app.vyasaa.com/app/admin" style="background:${TEAL};color:#fff;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:10px;font-size:14px">Review in Super Admin →</a></p>`),
    };
}
// ─── Templates ────────────────────────────────────────────────────────────────
function approvalEmail(doctorName) {
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
function rejectionEmail(doctorName, reason, rejectedAt) {
    const timestamp = rejectedAt ? new Date(rejectedAt).toLocaleString('en-IN', {
        day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit'
    }) : '—';
    return {
        subject: 'Your Vyasa registration — updates needed',
        html: layout('Registration update needed', `
      <p style="color:#475569;font-size:14px;line-height:1.7">Hi Dr. ${doctorName},</p>
      <p style="color:#475569;font-size:14px;line-height:1.7">
        Thank you for registering with Vyasa Integrated Healthcare. Your account requires updates before approval.
      </p>
      <p style="background:#fef2f2;border-left:4px solid #dc2626;padding:14px;border-radius:4px;color:#7f1d1d;font-size:13px;line-height:1.6">
        <strong>Reason:</strong> ${reason}<br>
        <strong style="font-size:12px;color:#9f1239">Decision on:</strong> <span style="font-size:12px">${timestamp}</span>
      </p>
      <p style="color:#475569;font-size:14px;line-height:1.7">
        Please update your information and reapply. If you have questions, contact our support team at <strong>support@vyasaa.com</strong>.
      </p>
      <p style="margin:22px 0">
        <a href="https://app.vyasaa.com/login" style="background:${TEAL};color:#fff;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:10px;font-size:14px">Reapply now →</a>
      </p>`),
    };
}
function approvalEmailWithTime(doctorName, approvedAt) {
    const timestamp = approvedAt ? new Date(approvedAt).toLocaleString('en-IN', {
        day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit'
    }) : '—';
    return {
        subject: '🎉 Your Vyasa account is verified — welcome aboard!',
        html: layout('Congratulations, Dr. ' + doctorName + '!', `
      <p style="color:#475569;font-size:14px;line-height:1.7">
        Your medical registration has been <strong>verified</strong> and your account is now active.
        You can sign in and start using the full Vyasa Health OS platform — digital prescriptions,
        your public booking page, patient records, and more.
      </p>
      <p style="background:#f0fdf4;border-left:4px solid #16a34a;padding:14px;border-radius:4px;color:#166534;font-size:12px;line-height:1.6">
        <strong>Approved on:</strong> ${timestamp}
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
function newUserRegistrationEmail(d) {
    return {
        subject: `📝 New doctor registration: Dr. ${d.doctorName}`,
        html: layout('New Registration Pending Review', `
      <p style="color:#475569;font-size:14px;line-height:1.7">
        A new doctor has registered and is awaiting verification. Please review their details below.
      </p>
      <table cellpadding="8" style="font-size:13px;color:#0f172a;width:100%;border-collapse:collapse">
        <tr style="background:#f1f5f9"><td style="padding:10px;font-weight:bold;color:#64748b">Name</td><td style="padding:10px">${d.doctorName}</td></tr>
        <tr><td style="padding:10px;font-weight:bold;color:#64748b">Email</td><td style="padding:10px">${d.email}</td></tr>
        <tr style="background:#f1f5f9"><td style="padding:10px;font-weight:bold;color:#64748b">Phone</td><td style="padding:10px">${d.phone}</td></tr>
        <tr><td style="padding:10px;font-weight:bold;color:#64748b">Specialty</td><td style="padding:10px">${d.specialty}</td></tr>
        <tr style="background:#f1f5f9"><td style="padding:10px;font-weight:bold;color:#64748b">Degrees</td><td style="padding:10px">${d.degrees}</td></tr>
        <tr><td style="padding:10px;font-weight:bold;color:#64748b">MCI / License</td><td style="padding:10px"><strong>${d.regNumber}</strong></td></tr>
        <tr style="background:#f1f5f9"><td style="padding:10px;font-weight:bold;color:#64748b">State (Registration)</td><td style="padding:10px">${d.regState}</td></tr>
        ${d.city ? `<tr><td style="padding:10px;font-weight:bold;color:#64748b">City</td><td style="padding:10px">${d.city}</td></tr>` : ''}
        ${d.state ? `<tr style="background:#f1f5f9"><td style="padding:10px;font-weight:bold;color:#64748b">State (Practice)</td><td style="padding:10px">${d.state}</td></tr>` : ''}
      </table>
      <p style="margin:22px 0">
        <a href="https://app.vyasaa.com/app/admin" style="background:${TEAL};color:#fff;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:10px;font-size:14px">Review Registration →</a>
      </p>
      <p style="color:#94a3b8;font-size:12px;line-height:1.6;margin-top:18px">
        Verify medical credentials and approve or request corrections.
      </p>`),
    };
}
function newBookingDoctorEmail(d) {
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
function bookingConfirmedPatientEmail(d) {
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
