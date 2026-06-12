// WhatsApp notifications via Meta's WhatsApp Cloud API (HTTPS — works on Render).
// Env:
//   WHATSAPP_TOKEN     — permanent access token from the Meta app
//   WHATSAPP_PHONE_ID  — the "Phone number ID" of your WhatsApp business number
// Business-initiated messages MUST use templates pre-approved in Meta Business
// Manager. Template names + variable order are defined below; create them with
// the exact same names and {{n}} placeholders.
// If unconfigured, sends are skipped with a console warning (app keeps working).

const TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_ID = process.env.WHATSAPP_PHONE_ID;
const configured = Boolean(TOKEN && PHONE_ID);

if (configured) {
  console.log('💬 WhatsApp ready: Meta Cloud API');
} else {
  console.warn('💬 WHATSAPP_TOKEN/WHATSAPP_PHONE_ID not set — WhatsApp notifications disabled.');
}

// Normalise an Indian mobile number to E.164 without "+" (Cloud API format)
function toWaNumber(phone: string): string | null {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 12 && digits.startsWith('91')) return digits;
  return null;
}

// Fire-and-forget template send — never block or fail a request
export function sendWhatsApp(toPhone: string, template: string, params: string[]): void {
  if (!configured) { console.warn(`💬 skipped (unconfigured): ${template} → ${toPhone}`); return; }
  const to = toWaNumber(toPhone);
  if (!to) { console.warn(`💬 skipped (bad number): ${template} → ${toPhone}`); return; }

  console.log(`💬 sending ${template} → ${to}…`);
  fetch(`https://graph.facebook.com/v21.0/${PHONE_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: template,
        language: { code: 'en' },
        components: [{
          type: 'body',
          parameters: params.map(text => ({ type: 'text', text })),
        }],
      },
    }),
  })
    .then(async res => {
      if (res.ok) { console.log(`💬 sent ${template} → ${to}`); return; }
      console.error(`💬 FAILED ${template} → ${to}: ${res.status} ${await res.text()}`);
    })
    .catch(err => console.error(`💬 FAILED ${template} → ${to}:`, err.message));
}

// ─── Template helpers ─────────────────────────────────────────────────────────
// Create these templates in Meta Business Manager (Utility category) with the
// exact names and bodies below, then they're auto-approved usually in minutes.

// Template "new_booking_doctor":
//   New appointment request on Vyasa 🩺
//   Patient: {{1}} ({{2}})
//   When: {{3}} at {{4}}
//   Manage: https://app.vyasaa.com/app/bookings
export function waNewBookingDoctor(doctorPhone: string, d: {
  patientName: string; patientPhone: string; date: string; time: string;
}): void {
  sendWhatsApp(doctorPhone, 'new_booking_doctor', [d.patientName, d.patientPhone, d.date, d.time]);
}

// Template "booking_confirmed_patient":
//   Your appointment is confirmed ✅
//   Doctor: Dr. {{1}}
//   When: {{2}} at {{3}}
//   Clinic: {{4}}
//   Please arrive 10 minutes early.
export function waBookingConfirmedPatient(patientPhone: string, d: {
  doctorName: string; date: string; time: string; clinicName: string;
}): void {
  sendWhatsApp(patientPhone, 'booking_confirmed_patient', [d.doctorName, d.date, d.time, d.clinicName || 'the clinic']);
}
