import { exec } from 'node:child_process';
import { type Config, saveConfig } from './config.js';

/**
 * Run the device authorization flow.
 * Returns true on success, false on failure.
 */
export async function deviceAuthFlow(config: Config): Promise<boolean> {
  const apiBase = config.api_base;
  if (!apiBase) {
    console.error('Error: api_base not configured. Run with --api-base or set it in config.');
    return false;
  }

  // Step 1: Request device code
  console.log('Requesting device code...');
  const deviceResp = await fetch(`${apiBase}/api/auth/device`, { method: 'POST' });
  if (!deviceResp.ok) {
    console.error(`Error requesting device code: ${deviceResp.status} ${await deviceResp.text()}`);
    return false;
  }

  const deviceData = (await deviceResp.json()) as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    expires_in?: number;
    interval?: number;
  };
  const { device_code, user_code, verification_uri } = deviceData;
  const expiresIn = deviceData.expires_in ?? 900;
  const interval = deviceData.interval ?? 5;

  // Step 2: Show code and open browser
  console.log(`\nYour authorization code: \x1b[1m${user_code}\x1b[0m`);
  console.log('Opening browser to complete authorization...');

  const url = `${verification_uri}?code=${user_code}`;
  // Open browser (macOS)
  exec(`open "${url}"`);

  console.log(`\nIf the browser didn't open, visit: ${url}`);
  console.log('Waiting for authorization...');

  // Step 3: Poll for token
  const deadline = Date.now() + expiresIn * 1000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval * 1000));

    const tokenResp = await fetch(`${apiBase}/api/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_code }),
    });

    const tokenData = (await tokenResp.json()) as {
      error?: string;
      access_token?: string;
      user_id?: string;
    };

    if (tokenResp.status === 400) {
      const error = tokenData.error || '';
      if (error === 'authorization_pending') continue;
      if (error === 'expired_token') {
        console.error('Authorization expired. Please try again.');
        return false;
      }
      console.error(`Error: ${error}`);
      return false;
    }

    if (!tokenResp.ok) {
      console.error(`Error polling for token: ${tokenResp.status}`);
      return false;
    }

    // Success
    config.access_token = tokenData.access_token!;
    config.user_id = tokenData.user_id!;
    saveConfig(config);
    console.log('\n\x1b[32mLogin successful!\x1b[0m');
    return true;
  }

  console.error('Authorization timed out. Please try again.');
  return false;
}
