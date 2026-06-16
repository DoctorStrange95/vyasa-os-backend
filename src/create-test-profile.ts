import 'dotenv/config';
import sql from './db';
import bcrypt from 'bcryptjs';

async function createTestProfile() {
  try {
    const password = await bcrypt.hash('test123456', 10);
    const timestamp = Date.now();

    const result = await sql`
      INSERT INTO users (
        email, password_hash, name, role, specialty, degrees,
        approval_status, phone, reg_number, reg_state
      ) VALUES (
        ${'stats4u.co@gmail.com'},
        ${password},
        ${'Dr. Test Doctor'},
        ${'clinic_admin'},
        ${'General Medicine'},
        ${'MBBS, MD'},
        ${'pending'},
        ${'+919999999999'},
        ${'TEST-' + timestamp},
        ${'Delhi'}
      )
      RETURNING id, email, name, approval_status
    `;

    console.log('✅ Test doctor profile created successfully!\n');
    console.log('Profile Details:');
    console.log('  Name: Dr. Test Doctor');
    console.log('  Email: stats4u.co@gmail.com');
    console.log('  Status: Pending Approval');
    console.log('\n🔐 Login Credentials:');
    console.log('  Email: stats4u.co@gmail.com');
    console.log('  Password: test123456');
    console.log('\n📧 To test approval email:');
    console.log('  1. Go to SuperAdmin page (app.vyasaa.com/app/admin)');
    console.log('  2. Find "Dr. Test Doctor" in Pending approvals');
    console.log('  3. Click Approve');
    console.log('  4. Check stats4u.co@gmail.com for approval email');
    console.log('\n✨ The approval email should arrive in ~30 seconds!');
    process.exit(0);
  } catch (err) {
    console.error('❌ Error:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

createTestProfile();
