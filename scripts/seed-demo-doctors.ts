// Seed demo doctors so the public directory looks populated.
// Run: npx tsx scripts/seed-demo-doctors.ts
import sql from '../src/db';

const WEEK = (days: number[], s1: { start: string; end: string }, s2?: { start: string; end: string }, cap = 20) =>
  JSON.stringify(Array.from({ length: 7 }, (_, d) => ({
    day: d, open: days.includes(d),
    sessions: days.includes(d) ? (s2 ? [s1, s2] : [s1]) : [],
    maxPatients: cap,
  })));

const DOCTORS = [
  {
    name: 'Ananya Sharma', specialty: 'Cardiologist', degrees: 'MBBS, MD, DM (Cardiology)',
    state: 'Delhi', city: 'New Delhi', fee: 800, exp: 14, lang: 'Hindi, English',
    reg: 'DMC-48211', slug: 'ananya-sharma',
    bio: 'Interventional cardiologist with 14 years of experience in angioplasty, heart failure management and preventive cardiology. Believes prevention is the best medicine.',
    education: 'MBBS — Maulana Azad Medical College, Delhi (2008)\nMD Medicine — AIIMS New Delhi (2012)\nDM Cardiology — AIIMS New Delhi (2015)',
    services: 'Cardiac Consultation, ECG, Echocardiography, Angioplasty Follow-up, Hypertension Management, Preventive Heart Checkup',
    awards: 'Fellow, Cardiological Society of India\nBest Paper Award — CSI Annual Conference 2019',
    clinic: { name: 'HeartCare Clinic', address: '24 Green Park Extension, New Delhi – 110016', phone: '+91 98101 22334', timings: 'Mon–Sat 10am–1pm · 5pm–8pm', sched: WEEK([1,2,3,4,5,6], { start: '10:00', end: '13:00' }, { start: '17:00', end: '20:00' }, 25) },
  },
  {
    name: 'Rajesh Iyer', specialty: 'Pediatrician', degrees: 'MBBS, MD (Pediatrics)',
    state: 'Karnataka', city: 'Bengaluru', fee: 600, exp: 11, lang: 'English, Kannada, Tamil, Hindi',
    reg: 'KMC-77654', slug: 'rajesh-iyer',
    bio: 'Pediatrician focused on newborn care, vaccinations and childhood nutrition. Known for patiently answering every parent question.',
    education: 'MBBS — Bangalore Medical College (2011)\nMD Pediatrics — St. Johns Medical College, Bengaluru (2015)',
    services: 'Child Consultation, Vaccination, Newborn Care, Growth & Nutrition Counselling, Asthma & Allergy Care',
    awards: 'Member, Indian Academy of Pediatrics',
    clinic: { name: 'Little Stars Child Clinic', address: '5th Block, Koramangala, Bengaluru – 560095', phone: '+91 98450 99887', timings: 'Mon–Sat 9am–1pm · 4pm–7pm', sched: WEEK([1,2,3,4,5,6], { start: '09:00', end: '13:00' }, { start: '16:00', end: '19:00' }, 30) },
  },
  {
    name: 'Priya Deshmukh', specialty: 'Gynecologist', degrees: 'MBBS, MS (OBG)',
    state: 'Maharashtra', city: 'Pune', fee: 700, exp: 12, lang: 'Marathi, Hindi, English',
    reg: 'MMC-33421', slug: 'priya-deshmukh',
    bio: 'Obstetrician & gynecologist specialising in high-risk pregnancy, PCOS management and laparoscopic surgery.',
    education: 'MBBS — B.J. Medical College, Pune (2010)\nMS Obstetrics & Gynaecology — KEM Hospital, Mumbai (2014)',
    services: 'Pregnancy Care, PCOS Management, Infertility Counselling, Laparoscopic Surgery, Menopause Care',
    awards: 'Member, FOGSI',
    clinic: { name: 'Aarogya Women’s Clinic', address: 'FC Road, Shivajinagar, Pune – 411005', phone: '+91 98220 11223', timings: 'Mon–Sat 10am–2pm · 6pm–9pm', sched: WEEK([1,2,3,4,5,6], { start: '10:00', end: '14:00' }, { start: '18:00', end: '21:00' }, 25) },
  },
  {
    name: 'Arjun Reddy', specialty: 'Orthopedic Surgeon', degrees: 'MBBS, MS (Ortho)',
    state: 'Telangana', city: 'Hyderabad', fee: 750, exp: 15, lang: 'Telugu, Hindi, English',
    reg: 'TSMC-55678', slug: 'arjun-reddy',
    bio: 'Orthopedic surgeon with special interest in joint replacement, sports injuries and arthroscopy. 2000+ successful surgeries.',
    education: 'MBBS — Osmania Medical College, Hyderabad (2007)\nMS Orthopaedics — NIMS Hyderabad (2011)\nFellowship in Joint Replacement — Seoul, South Korea (2013)',
    services: 'Knee Replacement, Hip Replacement, Arthroscopy, Fracture Care, Sports Injury Treatment, Spine Consultation',
    awards: 'Fellow, Indian Orthopaedic Association',
    clinic: { name: 'OrthoPlus Centre', address: 'Road No. 12, Banjara Hills, Hyderabad – 500034', phone: '+91 98490 44556', timings: 'Mon–Sat 10am–1pm · 5pm–8pm', sched: WEEK([1,2,3,4,5,6], { start: '10:00', end: '13:00' }, { start: '17:00', end: '20:00' }, 20) },
  },
  {
    name: 'Meera Krishnan', specialty: 'Dermatologist', degrees: 'MBBS, MD (Dermatology)',
    state: 'Tamil Nadu', city: 'Chennai', fee: 650, exp: 9, lang: 'Tamil, English, Hindi',
    reg: 'TNMC-66789', slug: 'meera-krishnan',
    bio: 'Dermatologist treating acne, pigmentation, hair loss and skin allergies with evidence-based care. Special interest in pediatric dermatology.',
    education: 'MBBS — Madras Medical College (2013)\nMD Dermatology — CMC Vellore (2017)',
    services: 'Acne Treatment, Hair Loss Treatment, Skin Allergy Care, Pigmentation Treatment, Pediatric Dermatology, Chemical Peels',
    awards: 'Member, Indian Association of Dermatologists',
    clinic: { name: 'SkinScience Clinic', address: 'T. Nagar, Chennai – 600017', phone: '+91 98410 77665', timings: 'Mon–Sat 10am–1pm · 4pm–7pm', sched: WEEK([1,2,3,4,5,6], { start: '10:00', end: '13:00' }, { start: '16:00', end: '19:00' }, 22) },
  },
  {
    name: 'Vikram Singh', specialty: 'General Physician', degrees: 'MBBS, MD (General Medicine)',
    state: 'Uttar Pradesh', city: 'Lucknow', fee: 400, exp: 18, lang: 'Hindi, English',
    reg: 'UPMC-11234', slug: 'vikram-singh',
    bio: 'Family physician managing diabetes, hypertension, thyroid and everyday illness for three generations of families in Lucknow.',
    education: 'MBBS — King George’s Medical University, Lucknow (2004)\nMD General Medicine — KGMU Lucknow (2008)',
    services: 'General Consultation, Diabetes Management, Hypertension Care, Thyroid Disorders, Fever & Infection Treatment, Health Checkups',
    awards: 'Member, Association of Physicians of India',
    clinic: { name: 'Singh Medical Centre', address: 'Hazratganj, Lucknow – 226001', phone: '+91 94150 33445', timings: 'Mon–Sat 9am–2pm · 5pm–8pm', sched: WEEK([1,2,3,4,5,6], { start: '09:00', end: '14:00' }, { start: '17:00', end: '20:00' }, 35) },
  },
  {
    name: 'Sneha Banerjee', specialty: 'Psychiatrist', degrees: 'MBBS, MD (Psychiatry)',
    state: 'West Bengal', city: 'Kolkata', fee: 900, exp: 10, lang: 'Bengali, Hindi, English',
    reg: 'WBMC-88990', slug: 'sneha-banerjee',
    bio: 'Psychiatrist providing compassionate care for anxiety, depression, OCD and sleep disorders. Strong believer in combining therapy with medication only when needed.',
    education: 'MBBS — Calcutta Medical College (2012)\nMD Psychiatry — NIMHANS Bengaluru (2016)',
    services: 'Anxiety & Depression Treatment, OCD Management, Sleep Disorder Care, Stress Counselling, De-addiction Support',
    awards: 'Member, Indian Psychiatric Society',
    clinic: { name: 'MindWell Clinic', address: 'Salt Lake Sector V, Kolkata – 700091', phone: '+91 98300 55667', timings: 'Tue–Sun 11am–2pm · 5pm–8pm', sched: WEEK([0,2,3,4,5,6], { start: '11:00', end: '14:00' }, { start: '17:00', end: '20:00' }, 15) },
  },
  {
    name: 'Karan Patel', specialty: 'ENT Specialist', degrees: 'MBBS, MS (ENT)',
    state: 'Gujarat', city: 'Ahmedabad', fee: 550, exp: 8, lang: 'Gujarati, Hindi, English',
    reg: 'GMC-44321', slug: 'karan-patel',
    bio: 'ENT surgeon treating sinusitis, tonsillitis, hearing problems and performing endoscopic sinus surgery.',
    education: 'MBBS — B.J. Medical College, Ahmedabad (2014)\nMS ENT — Civil Hospital, Ahmedabad (2018)',
    services: 'Sinusitis Treatment, Tonsillitis Care, Hearing Tests, Vertigo Treatment, Endoscopic Sinus Surgery, Snoring & Sleep Apnea',
    awards: 'Member, Association of Otolaryngologists of India',
    clinic: { name: 'ClearTone ENT Clinic', address: 'C.G. Road, Navrangpura, Ahmedabad – 380009', phone: '+91 98250 88990', timings: 'Mon–Sat 10am–1pm · 5pm–8pm', sched: WEEK([1,2,3,4,5,6], { start: '10:00', end: '13:00' }, { start: '17:00', end: '20:00' }, 24) },
  },
  {
    name: 'Lakshmi Nair', specialty: 'Diabetologist', degrees: 'MBBS, MD, Fellowship in Diabetology',
    state: 'Kerala', city: 'Kochi', fee: 600, exp: 13, lang: 'Malayalam, English, Hindi',
    reg: 'TCMC-22113', slug: 'lakshmi-nair',
    bio: 'Diabetologist helping patients reverse type-2 diabetes through medication, diet planning and continuous glucose monitoring.',
    education: 'MBBS — Government Medical College, Thiruvananthapuram (2009)\nMD General Medicine — GMC Kozhikode (2013)\nFellowship in Diabetology — CMC Vellore (2015)',
    services: 'Diabetes Reversal Program, Insulin Management, Diabetic Foot Care, Diet Counselling, Thyroid Care, Obesity Management',
    awards: 'Member, Research Society for the Study of Diabetes in India',
    clinic: { name: 'SugarFree Diabetes Centre', address: 'M.G. Road, Ernakulam, Kochi – 682016', phone: '+91 98470 11220', timings: 'Mon–Sat 9am–1pm · 4pm–7pm', sched: WEEK([1,2,3,4,5,6], { start: '09:00', end: '13:00' }, { start: '16:00', end: '19:00' }, 28) },
  },
];

async function run() {
  for (const d of DOCTORS) {
    const email = `${d.slug}.demo@vyasaa.com`;
    const existing = await sql`SELECT id FROM users WHERE email = ${email}`;
    if (existing.length) { console.log('skip (exists):', d.name); continue; }

    const [u] = await sql`
      INSERT INTO users (name, email, password_hash, role, specialty, degrees, phone,
        reg_number, license_number, approval_status, state, city, profile_slug,
        bio, languages, accepting_patients, public_profile_enabled,
        years_experience, consultation_fee, education, services, awards)
      VALUES (${d.name}, ${email}, '', 'clinic_admin', ${d.specialty}, ${d.degrees}, ${d.clinic.phone},
        ${d.reg}, ${d.reg}, 'approved', ${d.state}, ${d.city}, ${d.slug},
        ${d.bio}, ${d.lang}, true, true,
        ${d.exp}, ${d.fee}, ${d.education}, ${d.services}, ${d.awards})
      RETURNING id
    `;
    const uid = u.id as number;
    const clinicId = `clinic_${uid}`;

    await sql`
      INSERT INTO clinics (id, owner_id, name, address, phone, fee, max_patients, timings, schedule)
      VALUES (${clinicId}, ${uid}, ${d.clinic.name}, ${d.clinic.address}, ${d.clinic.phone},
              ${d.fee}, 30, ${d.clinic.timings}, ${d.clinic.sched}::jsonb)
      ON CONFLICT (id) DO NOTHING
    `;
    await sql`UPDATE users SET clinic_id = ${clinicId} WHERE id = ${uid}`;
    await sql`
      INSERT INTO pad_settings (user_id, doctor_name, degrees, specialty, reg_number,
        clinic_name, address, phone, timings)
      VALUES (${uid}, ${d.name}, ${d.degrees}, ${d.specialty}, ${d.reg},
        ${d.clinic.name}, ${d.clinic.address}, ${d.clinic.phone}, ${d.clinic.timings})
      ON CONFLICT (user_id) DO NOTHING
    `;
    console.log('seeded:', d.name, '→ /dr/' + d.slug);
  }
  console.log('done');
  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
