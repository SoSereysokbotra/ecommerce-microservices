const bcrypt = require('bcrypt');
const { Client } = require('pg');

async function seedAdmin() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is not set!');
    process.exit(1);
  }

  const client = new Client({
    connectionString,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();

  const password = 'Password123!';
  const hash = await bcrypt.hash(password, 10);

  // 1. Admin account
  await client.query(
    `INSERT INTO users (email, name, password_hash, role, status, is_email_verified)
     VALUES ('admin@example.com', 'Admin User', $1, 'admin', 'active', true)
     ON CONFLICT (email)
     DO UPDATE SET password_hash = $1, role = 'admin', status = 'active'`,
    [hash],
  );

  // 2. Staff account
  await client.query(
    `INSERT INTO users (email, name, password_hash, role, status, is_email_verified)
     VALUES ('staff@example.com', 'Staff User', $1, 'staff', 'active', true)
     ON CONFLICT (email)
     DO UPDATE SET password_hash = $1, role = 'staff', status = 'active'`,
    [hash],
  );

  console.log('✅ Accounts seeded successfully:');
  console.log('   Admin: admin@example.com / Password123!');
  console.log('   Staff: staff@example.com / Password123!');

  await client.end();
}

seedAdmin().catch((err) => {
  console.error('❌ Error seeding accounts:', err);
  process.exit(1);
});
