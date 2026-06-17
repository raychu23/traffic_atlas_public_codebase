const bcrypt = require('bcryptjs');
const storage = require('../storage');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--userId' || arg === '--user-id') {
      args.userId = argv[i + 1];
      i += 1;
    } else if (arg === '--email') {
      args.email = argv[i + 1];
      i += 1;
    } else if (arg === '--password') {
      args.password = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if ((!args.userId && !args.email) || !args.password) {
    console.error('Usage: node backend/scripts/set-password.js (--userId <id> | --email <email>) --password <newPassword>');
    process.exit(1);
  }

  if (String(args.password).length < 8) {
    console.error('Password must be at least 8 characters');
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(args.password, 10);
  let updated = null;
  if (args.userId) {
    updated = await storage.setUserPasswordHashById(args.userId, passwordHash);
  } else {
    updated = await storage.setUserPasswordHashByEmail(args.email, passwordHash);
  }

  if (!updated) {
    console.error('User not found');
    process.exit(2);
  }

  console.log(JSON.stringify({
    success: true,
    userId: updated.userId,
    email: updated.email,
    updatedAt: updated.updatedAt
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
