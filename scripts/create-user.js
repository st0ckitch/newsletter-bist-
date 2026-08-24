// Create a staff account from the command line:
//   npm run create-user -- --email t@bist.ge --name "T Teacher" --role primary --password secret123
const bcrypt = require('bcryptjs');
const { db } = require('../src/db');

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
}

const { email, name, role, password } = args;
const ROLES = ['primary', 'secondary', 'principal', 'admin'];

if (!email || !name || !ROLES.includes(role) || !password || password.length < 8) {
  console.error(
    'Usage: npm run create-user -- --email <email> --name <name> --role <primary|secondary|principal|admin> --password <8+ chars>'
  );
  process.exit(1);
}

try {
  db.prepare('INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, ?)').run(
    email,
    name,
    bcrypt.hashSync(password, 10),
    role
  );
  console.log(`Created ${role} account for ${email}`);
} catch (err) {
  console.error('Failed:', err.message);
  process.exit(1);
}
