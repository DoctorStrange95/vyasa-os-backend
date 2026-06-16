const sql = require('./dist/db').default;

async function createTestDoctors() {
  try {
    const bcrypt = require('bcryptjs');
    
    // Delete old test accounts first
    await sql`DELETE FROM users WHERE email IN ('rejection-test@test.com', 'approval-test@test.com')`;
    
    // Test 1: Doctor for REJECTION test (using user's email)
    const hash1 = await bcrypt.hash('test123456', 12);
    const [doc1] = await sql`
      INSERT INTO users (name, email, password_hash, role, specialty, phone, license_number, approval_status)
      VALUES ('Dr. Test Rejection', 'kaartkaroo@gmail.com', ${hash1}, 'clinic_admin', 'General Medicine', '9999999991', 'TEST-REJ-001', 'pending')
      RETURNING id, name, email, approval_status
    `;
    console.log('✅ Test 1 - Rejection Email:');
    console.log('   Doctor:', doc1.name);
    console.log('   Email:', doc1.email);
    console.log('   ID:', doc1.id);

    // Test 2: Doctor for APPROVAL test (using user's email)
    const hash2 = await bcrypt.hash('test123456', 12);
    const [doc2] = await sql`
      INSERT INTO users (name, email, password_hash, role, specialty, phone, license_number, approval_status)
      VALUES ('Dr. Test Approval', 'kaartkaroo@gmail.com', ${hash2}, 'clinic_admin', 'Cardiology', '9999999992', 'TEST-APP-001', 'pending')
      RETURNING id, name, email, approval_status
    `;
    console.log('\n✅ Test 2 - Approval Email:');
    console.log('   Doctor:', doc2.name);
    console.log('   Email:', doc2.email);
    console.log('   ID:', doc2.id);
    
    console.log('\n📋 NEXT STEPS:');
    console.log('1. Go to SuperAdmin → Approvals & Users');
    console.log('2. Find "Dr. Test Rejection" → REJECT it');
    console.log('   → Check your email for REJECTION message');
    console.log('3. Find "Dr. Test Approval" → APPROVE it');
    console.log('   → Check your email for APPROVAL message');
    
  } catch (e) {
    console.error('Error:', e.message);
  } finally {
    process.exit();
  }
}

createTestDoctors();
