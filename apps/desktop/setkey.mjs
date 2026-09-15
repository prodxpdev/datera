import { app, safeStorage } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

await app.whenReady();
const ws = join(app.getPath('userData'), 'workspaces', 'default');
const file = join(ws, 'credentials.enc');

if (!safeStorage.isEncryptionAvailable()) {
  console.error('safeStorage unavailable');
  app.exit(1);
} else {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, safeStorage.encryptString(JSON.stringify({
    'model.apiKey.anthropic': process.env.ANTHROPIC_API_KEY,
  })));
  console.log('stored encrypted at', file.replace(process.env.HOME, '~'));
  app.exit(0);
}
