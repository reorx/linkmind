#!/usr/bin/env node
import { Command } from 'commander';
import { loadConfig, saveConfig, isAuthenticated, isRunning, stopDaemon, readPid } from './config.js';

const program = new Command();

program.name('linkmind-probe').description('Local scraping daemon for LinkMind').version('0.1.0');

program
  .command('login')
  .description('Authenticate with LinkMind server')
  .option('--api-base <url>', 'LinkMind API base URL')
  .action(async (opts) => {
    const { deviceAuthFlow } = await import('./auth.js');

    const config = loadConfig();

    if (opts.apiBase) {
      config.api_base = opts.apiBase.replace(/\/+$/, '');
      saveConfig(config);
    }

    if (!config.api_base) {
      // Prompt-like: just require it via --api-base
      console.error('Error: --api-base is required for first login.');
      process.exit(1);
    }

    const ok = await deviceAuthFlow(config);
    if (!ok) process.exit(1);
  });

program
  .command('run')
  .description('Start the probe daemon')
  .option('-f, --foreground', 'Run in foreground instead of daemonizing')
  .action(async (opts) => {
    const config = loadConfig();
    if (!isAuthenticated(config)) {
      console.error("Not logged in. Run 'linkmind-probe login' first.");
      process.exit(1);
    }

    if (!opts.foreground && isRunning()) {
      console.log(`Daemon already running (pid ${readPid()})`);
      return;
    }

    if (opts.foreground) {
      const { runForeground } = await import('./daemon.js');
      runForeground(config);
    } else {
      const { runDaemon } = await import('./daemon.js');
      const pid = await runDaemon(config);
      if (pid === null) {
        console.error('Daemon exited immediately, check ~/.linkmind-probe/probe.log');
        process.exit(1);
      }
      console.log(`Daemon started (pid ${pid})`);
    }
  });

program
  .command('stop')
  .description('Stop the probe daemon')
  .action(() => {
    if (!isRunning()) {
      console.log('Daemon is not running.');
      return;
    }

    const pid = readPid();
    if (stopDaemon()) {
      console.log(`Sent SIGTERM to daemon (pid ${pid})`);
    } else {
      console.error('Failed to stop daemon.');
    }
  });

program
  .command('status')
  .description('Check if the probe daemon is running')
  .action(() => {
    if (isRunning()) {
      console.log(`Running (pid ${readPid()})`);
    } else {
      console.log('Not running');
    }
  });

program
  .command('logout')
  .description('Clear saved authentication token')
  .action(() => {
    const config = loadConfig();
    if (!isAuthenticated(config)) {
      console.log('Not logged in.');
      return;
    }

    config.access_token = '';
    config.user_id = '';
    saveConfig(config);
    console.log('Logged out.');
  });

program.parse();
