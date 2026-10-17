// Generate the ADMIN_PASSWORD_HASH for the standalone payments dashboard.
// Usage:
//   npm run pay:pass -- "my dashboard password"
// (or run with no argument and it prompts — input is hidden.)
//
// Paste the printed line into Backend/.env and set the SAME value on Render.
// The hash is scrypt (format scrypt$salt$hash); the raw password is never stored.

import "dotenv/config";
import crypto from "node:crypto";
import readline from "node:readline";

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const onData = (char) => {
      // Mask the typed characters on the terminal.
      const s = String(char);
      if (s === "\n" || s === "\r" || s === "\u0004") return;
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
      process.stdout.write(question + "*".repeat(rl.line.length));
    };
    process.stdin.on("data", onData);
    rl.question(question, (answer) => {
      process.stdin.removeListener("data", onData);
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

async function main() {
  const arg = process.argv.slice(2).join(" ").trim();
  const password = arg || (await promptHidden("Dashboard password: "));
  if (!password || password.length < 8) {
    console.error("[pay:pass] Password must be at least 8 characters.");
    process.exit(1);
  }
  const hash = hashPassword(password);
  console.log("\n[pay:pass] Add this line to Backend/.env (and Render env):\n");
  console.log(`ADMIN_PASSWORD_HASH=${hash}\n`);
  console.log("[pay:pass] Keep it secret. Re-run to rotate the password anytime.");
  process.exit(0);
}

main().catch((err) => {
  console.error("[pay:pass] failed:", err?.message || err);
  process.exit(1);
});
