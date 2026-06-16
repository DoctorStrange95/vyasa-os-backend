const sql = require('./dist/db').default;

async function setup() {
  try {
    const bcrypt = require('bcryptjs');
    
    // Delete clinics for test users first
    await sql`DELETE FROM clinics WHERE owner_id IN (SELECT id FROM users WHERE name LIKE 'Dr. Test%')`;
    // Then delete users
    await sql`DELETE FROM users WHERE name LIKE 'Dr. Test%'`;
    
    // Test 1: REJECTION test
    const hash1 = await bcrypt.hash('test123456', 12);
    const [doc1] = await sql`
      INSERT INTO users (name, email, password_hash, role, specialty, phone, license_number, approval_status, clinic_id)
      VALUES ('Dr. Test Rejection', 'kaartkaroo@gmail.com', ${hash1}, 'clinic_admin', 'General Medicine', '9999999991', 'TEST-REJ', 'pending', null)
      RETURNING id, name, email, approval_status
    `;
    console.log('✅ REJECTION TEST ACCOUNT:');
    console.log('   ID:', doc1.id);
    console.log('   Doctor:', doc1.name);
    console.log('   Email: kaartkaroo@gmail.com');
    console.log('   Status:', doc1.approval_status);

    // Test 2: APPROVAL test  
    const hash2 = await bcrypt.hash('test123456', 12);
    const [doc2] = await sql`
      INSERT INTO users (name, email, password_hash, role, specialty, phone, license_number, approval_status, clinic_id)
      VALUES ('Dr. Test Approval', 'kaartkaroo+approval@gmail.com', ${hash2}, 'clinic_admin', 'Cardiology', '9999999992', 'TEST-APP', 'pending', null)
      RETURNING id, name, email, approval_status
    `;
    console.log('\n✅ APPROVAL TEST ACCOUNT:');
    console.log('   ID:', doc2.id);
    console.log('   Doctor:', doc2.name);
    console.log('   Email: kaartkaroo+approval@gmail.com');
    console.log('   Status:', doc2.approval_status);
    
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📋 TEST PLAN - DO ONE BY ONE:');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('\n1️⃣  FIRST - TEST REJECTION EMAIL:');
    console.log('   → Go to SuperAdmin page');
    console.log('   → Find "Dr. Test Rejection"');
    console.log('   → Click REJECT button');
    console.log('   → Enter reason: "Test rejection"');
    console.log('   → Check inbox: Should get rejection email');
    console.log('   → Screenshot the rejection email');
    
    console.log('\n2️⃣  THEN - TEST APPROVAL EMAIL:');
    console.log('   → Go back to SuperAdmin');
    console.log('   → Find "Dr. Test Approval"');
    console.log('   → Click APPROVE button');
    console.log('   → Check inbox: Should get approval email');
    console.log('   → Screenshot the approval email');
    
    console.log('\n✉️  Both emails go to kaartkaroo@gmail.com');
    console.log('   (Gmail +variations arrive in same inbox)\n');
    
  } catch (e) {
    console.error('❌ Error:', e.message);
  } finally {
    process.exit();
  }
}

setup();
