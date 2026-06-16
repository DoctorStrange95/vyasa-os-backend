// Create pending test doctors for email testing
// Run: npx tsx scripts/create-test-doctors.ts

import 'dotenv/config';
import sql from '../src/db';
import bcrypt from 'bcryptjs';

async function createTestDoctors() {
  try {
    const password = await bcrypt.hash('test123456', 10);
    const timestamp = Date.now();

    // Test Doctor 1
    const user1 = await sql`
      INSERT INTO users (
        email, password_hash, name, role, specialty, degrees,
        approval_status, phone, reg_number
      ) VALUES (
        ${'testdoc1.' + timestamp + '@test.com'},
        ${password},
        'Test Doctor One (Approve)',
        'doctor',
        'Cardiologist',
        'MBBS, MD',
        'pending',
        '+919876543210',
        'TEST-DOC-001'
      )
      RETURNING id, email, name, approval_status
    `;

    // Test Doctor 2
    const user2 = await sql`
      INSERT INTO users (
        email, password_hash, name, role, specialty, degrees,
        approval_status, phone, reg_number
      ) VALUES (
        ${'testdoc2.' + timestamp + '@test.com'},
        ${password},
        'Test Doctor Two (Reject)',
        'doctor',
        'Orthopedic Surgeon',
        'MBBS, MS',
        'pending',
        '+919876543211',
        'TEST-DOC-002'
      )
      RETURNING id, email, name, approval_status
    `;

    console.log('✅ Test Doctors Created:');
    console.log('Doctor 1:', user1[0]);
    console.log('Doctor 2:', user2[0]);
    console.log('\nEmail: kaartkaroo@gmail.com');
    console.log('Password: test123456');
    console.log('\nGo to SuperAdmin → /app/admin → Approve or Reject these doctors');

    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

createTestDoctors();
