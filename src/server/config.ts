import fs from 'fs';
import crypto from 'crypto';
import { getConfigPath, getAppDataDir } from './paths.js';
import { PORT } from '../shared/schemas.js';

export interface AppConfig {
  token: string;
  port: number;
  baseUrl: string;
  createdAt: string;
}

export function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function loadConfig(): AppConfig {
  const configPath = getConfigPath();
  if (fs.existsSync(configPath)) {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as AppConfig;
    return raw;
  }
  const config: AppConfig = {
    token: generateToken(),
    port: PORT,
    baseUrl: `http://127.0.0.1:${PORT}`,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  return config;
}

export function getConfig(): AppConfig {
  return loadConfig();
}

export function regenerateToken(): AppConfig {
  const config = loadConfig();
  config.token = generateToken();
  fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), 'utf-8');
  return config;
}

export { getAppDataDir };
