/**
 * One-time: register the entity secret ciphertext with Circle.
 *
 * Usage: pnpm circle:register-secret
 *
 * Reads CIRCLE_API_KEY + CIRCLE_ENTITY_SECRET from .env. Posts the RSA-encrypted
 * ciphertext to Circle and downloads a recovery file to ~/.circle/recovery-file.json.
 *
 * RUN ONCE PER ENVIRONMENT. Re-running on the same entity secret returns an error
 * from Circle — if you need to rotate, follow Circle's rotation docs instead.
 *
 * SECURITY:
 *   - The recovery file is your last-resort restore if you lose the entity secret.
 *     Upload it to a secure location (1Password, encrypted cloud storage).
 *   - NEVER commit the recovery file to git.
 *   - `.circle/` is ignored via .gitignore out of the box.
 */
import { registerEntitySecretCiphertext } from '@circle-fin/developer-controlled-wallets';
import * as dotenv from 'dotenv';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

dotenv.config();

async function main() {
  const apiKey = process.env.CIRCLE_API_KEY;
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET;

  if (!apiKey) {
    throw new Error('CIRCLE_API_KEY is not set in .env');
  }
  if (!entitySecret) {
    throw new Error(
      'CIRCLE_ENTITY_SECRET is not set in .env — run `pnpm circle:generate-secret` first',
    );
  }

  const recoveryDir = path.join(os.homedir(), '.circle');
  fs.mkdirSync(recoveryDir, { recursive: true });

  console.log(`Registering entity secret ciphertext...`);
  console.log(`Recovery file will be written under: ${recoveryDir}`);

  const response = await registerEntitySecretCiphertext({
    apiKey,
    entitySecret,
    recoveryFileDownloadPath: recoveryDir,
  });

  if (response.data?.recoveryFile) {
    console.log('\n✓ Entity secret registered successfully.');
    console.log(`✓ Recovery file saved in: ${recoveryDir}`);
    console.log(
      '\nIMPORTANT: back this file up to a secrets manager. If you lose both the ' +
        'entity secret AND this recovery file, all wallets become unusable.\n',
    );
    console.log('Next: run `pnpm circle:bootstrap-wallet-set` to create the wallet set.');
  } else {
    console.error('Unexpected response shape:', response);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Registration failed:', err?.response?.data ?? err);
  process.exit(1);
});
