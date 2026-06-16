const sql = require('./dist/db').default;

async function createTestDoctors() {
  try {
    const bcrypt = require('bcryptjs');
    
    // Test 1: Doctor for REJECTION test
    const hash1 = await bcrypt.hash('test123456', 12);
    const [doc1] = await sql`
      INSERT INTO users (name, email, password_hash, role, specialty, phone, license_number, approval_status)
      VALUES ('Dr. Rejection Test', 'rejection-test@test.com', ${hash1}, 'clinic_admin', 'General Medicine', '9999999991', 'TEST-REJ-001', 'pending')
      RETURNING id, name, email, approval_status
    `;
    console.log('✅ Created for rejection test:', doc1);

    // Test 2: Doctor for APPROVAL test
    const hash2 = await bcrypt.hash('test123456', 12);
    const [doc2] = await sql`
      INSERT INTO users (name, email, password_hash, role, specialty, phone, license_number, approval_status)
      VALUES ('Dr. Approval Test', 'approval-test@test.com', ${hash2}, 'clinic_admin', 'Cardiology', '9999999992', 'TEST-APP-001', 'pending')
      RETURNING id, name, email, approval_status
    `;
    console.log('✅ Created for approval test:', doc2);
    
    console.log('\nNow:');
    console.log('1. Go to SuperAdmin page');
    console.log('2. REJECT "Dr. Rejection Test" - check email');
    console.log('3. APPROVE "Dr. Approval Test" - check email');
    
  } catch (e) {
    console.error('Error:', e.message);
  } finally {
    process.exit();
  }
}

createTestDoctors();
