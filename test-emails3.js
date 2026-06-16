const sql = require('./dist/db').default;

async function createTestDoctors() {
  try {
    const bcrypt = require('bcryptjs');
    
    // Clean up old test accounts
    await sql`DELETE FROM users WHERE name LIKE 'Dr. Test%' OR email LIKE 'test-%'`;
    
    // Test 1: REJECTION test (primary email)
    const hash1 = await bcrypt.hash('test123456', 12);
    const [doc1] = await sql`
      INSERT INTO users (name, email, password_hash, role, specialty, phone, license_number, approval_status)
      VALUES ('Dr. Test Rejection', 'kaartkaroo@gmail.com', ${hash1}, 'clinic_admin', 'General Medicine', '9999999991', 'TEST-REJ-001', 'pending')
      RETURNING id, name, email, approval_status
    `;
    console.log('✅ Test 1 - REJECTION EMAIL:');
    console.log('   ID:', doc1.id);
    console.log('   Doctor:', doc1.name);
    console.log('   Email:', doc1.email);

    // Test 2: APPROVAL test (use +1 variation)
    const hash2 = await bcrypt.hash('test123456', 12);
    const email2 = 'kaartkaroo+approval@gmail.com'; // Gmail allows +variations
    const [doc2] = await sql`
      INSERT INTO users (name, email, password_hash, role, specialty, phone, license_number, approval_status)
      VALUES ('Dr. Test Approval', ${email2}, ${hash2}, 'clinic_admin', 'Cardiology', '9999999992', 'TEST-APP-001', 'pending')
      RETURNING id, name, email, approval_status
    `;
    console.log('\n✅ Test 2 - APPROVAL EMAIL:');
    console.log('   ID:', doc2.id);
    console.log('   Doctor:', doc2.name);
    console.log('   Email:', doc2.email);
    
    console.log('\n📋 NEXT STEPS:');
    console.log('1. SuperAdmin → Find both doctors');
    console.log('2. REJECT "Dr. Test Rejection" (ID: ' + doc1.id + ')');
    console.log('3. APPROVE "Dr. Test Approval" (ID: ' + doc2.id + ')');
    console.log('\n4. Check your email (kaartkaroo@gmail.com) for BOTH emails');
    console.log('   Note: Gmail sends +variations to same inbox');
    
  } catch (e) {
    console.error('Error:', e.message);
  } finally {
    process.exit();
  }
}

createTestDoctors();
