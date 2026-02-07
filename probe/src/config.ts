import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const STATE_DIR = path.join(os.homedir(), '.linkmind-probe');
const CONFIG_PATH = path.join(STATE_DIR, 'config.json');
const PID_PATH = path.join(STATE_DIR, 'probe.pid');
const LOG_PATH = path.join(STATE_DIR, 'probe.log');

export { STATE_DIR, CONFIG_PATH, PID_PATH, LOG_PATH };

export interface Config {
  api_base: string;
  access_token: string;
  user_id: string;
}

export function ensureStateDir(): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

export function loadConfig(): Config {
  if (!fs.existsSync(CONFIG_PATH)) {
    return { api_base: '', access_token: '', user_id: '' };
  }
  const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
  const data = JSON.parse(raw);
  return {
    api_base: data.api_base || '',
    access_token: data.access_token || '',
    user_id: data.user_id || '',
  };
}

export function saveConfig(config: Config): void {
  ensureStateDir();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}

export function isAuthenticated(config: Config): boolean {
  return !!config.access_token;
}

// PID management

export function writePid(): void {
  ensureStateDir();
  fs.writeFileSync(PID_PATH, String(process.pid));
}

export function removePid(): void {
  if (fs.existsSync(PID_PATH)) {
    fs.unlinkSync(PID_PATH);
  }
}

export function readPid(): number | null {
  if (!fs.existsSync(PID_PATH)) return null;
  const text = fs.readFileSync(PID_PATH, 'utf-8').trim();
  if (!text) return null;
  return parseInt(text, 10);
}

export function isRunning(): boolean {
  const pid = readPid();
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    if (e.code === 'ESRCH') {
      removePid();
      return false;
    }
    // EPERM means the process exists but we can't signal it
    return true;
  }
}

export function stopDaemon(): boolean {
  const pid = readPid();
  if (pid === null) return false;
  try {
    process.kill(pid, 'SIGTERM');
    return true;
  } catch (e: any) {
    if (e.code === 'ESRCH') {
      removePid();
    }
    return false;
  }
}
