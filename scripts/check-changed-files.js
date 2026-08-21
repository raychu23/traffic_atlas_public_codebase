const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const repositoryRoot = path.resolve(__dirname, "..");
const mode = process.argv[2];
const supportedModes = new Set(["lint", "format-check", "format-write"]);

if (!supportedModes.has(mode)) {
  console.error("Usage: node scripts/check-changed-files.js <lint|format-check|format-write>");
  process.exit(2);
}

function git(args) {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  })
    .split(/\r?\n/)
    .filter(Boolean);
}

function collectChangedFiles() {
  const files = new Set();
  const baseReference = process.env.QUALITY_BASE_REF;
  let comparedWithBase = false;

  if (baseReference) {
    try {
      git(["diff", "--name-only", "--diff-filter=ACMR", `${baseReference}...HEAD`]).forEach(
        (file) => files.add(file),
      );
      comparedWithBase = true;
    } catch {
      console.warn(`Unable to compare against ${baseReference}; checking local changes instead.`);
    }
  }

  git(["diff", "--name-only", "--diff-filter=ACMR"]).forEach((file) => files.add(file));
  git(["diff", "--cached", "--name-only", "--diff-filter=ACMR"]).forEach((file) => files.add(file));
  git(["ls-files", "--others", "--exclude-standard"]).forEach((file) => files.add(file));

  if (files.size === 0 && (!baseReference || !comparedWithBase)) {
    try {
      git(["diff", "--name-only", "--diff-filter=ACMR", "HEAD^", "HEAD"]).forEach((file) =>
        files.add(file),
      );
    } catch {
      // A new repository may not have a parent commit.
    }
  }

  return [...files].filter((file) => fs.existsSync(path.join(repositoryRoot, file)));
}

const changedFiles = collectChangedFiles();
// Whole-file formatting for these legacy modules belongs in a dedicated migration.
const legacyFormatExclusions = new Set([
  "backend/index.js",
  "backend/storage.js",
  "frontend/src/components/DatasetDetail.js",
  "frontend/src/components/UploadMetadata.js",
]);
const files = changedFiles.filter((file) => {
  if (mode === "lint") return file.endsWith(".js");
  if (/package-lock\.json$/.test(file)) return false;
  if (legacyFormatExclusions.has(file)) return false;
  return /\.(?:css|js|json|md|ya?ml)$/.test(file);
});

if (files.length === 0) {
  console.log(`No changed files require ${mode}.`);
  process.exit(0);
}

const executable = mode === "lint" ? "eslint" : "prettier";
const argumentsForCommand =
  mode === "lint" ? files : [mode === "format-write" ? "--write" : "--check", ...files];
const executablePath = path.join(
  repositoryRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? `${executable}.cmd` : executable,
);
const result = spawnSync(executablePath, argumentsForCommand, {
  cwd: repositoryRoot,
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
