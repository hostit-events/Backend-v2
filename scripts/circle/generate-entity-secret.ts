/**
 * One-time: generate a 32-byte entity secret for Circle developer-controlled wallets.
 *
 * Usage: pnpm circle:generate-secret
 *
 * Output: prints a hex string to stdout. Paste it into .env as CIRCLE_ENTITY_SECRET,
 * then run `pnpm circle:register-secret` to register its ciphertext with Circle.
 *
 * SECURITY:
 *   - Do NOT commit this value. It signs every Circle transaction for the platform.
 *   - Store in secrets manager (1Password, AWS Secrets Manager, etc) in addition to .env.
 *   - A lost entity secret means lost access to all wallets in the set — treat like a root key.
 */
import { generateEntitySecret } from '@circle-fin/developer-controlled-wallets';

function main() {
  const secret = generateEntitySecret();
  // generateEntitySecret prints the secret internally; re-emit for clarity.
  console.log('\nCIRCLE_ENTITY_SECRET=' + (secret ?? '(see above)'));
  console.log(
    '\nNext steps:\n' +
      '  1. Copy the hex value above (64 chars) into .env as CIRCLE_ENTITY_SECRET\n' +
      '  2. Store a backup copy in your secrets manager\n' +
      '  3. Run: pnpm circle:register-secret\n',
  );
}

main();
