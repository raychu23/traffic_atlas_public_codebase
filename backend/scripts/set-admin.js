const storage = require('../storage');

function parseArgs(argv) {
  const args = { isAdmin: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--userId' || arg === '--user-id') {
      args.userId = argv[i + 1];
      i += 1;
    } else if (arg === '--email') {
      args.email = argv[i + 1];
      i += 1;
    } else if (arg === '--remove') {
      args.isAdmin = false;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.userId && !args.email) {
    console.error('Usage: node backend/scripts/set-admin.js --userId <id> | --email <email> [--remove]');
    process.exit(1);
  }

  let updated = null;
  if (args.userId) {
    updated = await storage.setUserAdminById(args.userId, args.isAdmin);
  } else {
    updated = await storage.setUserAdminByEmail(args.email, args.isAdmin);
  }

  if (!updated) {
    console.error('User not found');
    process.exit(2);
  }

  console.log(JSON.stringify({
    success: true,
    userId: updated.userId,
    email: updated.email,
    role: updated.role,
    isAdmin: Boolean(updated.isAdmin)
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
