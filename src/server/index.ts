import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootEnv = path.resolve(__dirname, '../../.env');
if (fs.existsSync(rootEnv)) {
  dotenv.config({ path: rootEnv });
}

const { startServer } = await import('./app.js');
startServer();
