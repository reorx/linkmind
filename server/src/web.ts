/**
 * Web server: composes all route modules and starts Express.
 */

import path from 'path';
import express from 'express';
import cookieParser from 'cookie-parser';
import { Sentry } from './sentry.js';
import { logger } from './logger.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerApiRoutes } from './routes/api.js';
import { registerProbeRoutes } from './routes/probe.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerPageRoutes } from './routes/pages.js';

const log = logger.child({ module: 'web' });

// Re-export for use in pipeline (probe SSE push)
export { pushEventToProbe } from './routes/probe.js';

export function startWebServer(port: number): void {
  const app = express();

  // Access log middleware
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - start;
      log.info(
        { method: req.method, url: req.originalUrl, status: res.statusCode, ms },
        `${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms`,
      );
    });
    next();
  });

  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(cookieParser());

  // Serve images from data/images directory (legacy)
  const imagesDir = path.resolve(import.meta.dirname, '../data/images');
  app.use('/images', express.static(imagesDir));

  // Serve files from object storage
  app.get('/files/{*key}', async (req, res) => {
    try {
      const { getStorage } = await import('./storage/index.js');
      const storage = getStorage();
      const keyParts = req.params.key;
      const key = Array.isArray(keyParts) ? keyParts.join('/') : keyParts;
      if (!key) {
        res.status(400).send('Missing key');
        return;
      }
      const data = await storage.get(key);
      // Guess content type from extension
      const ext = key.split('.').pop()?.toLowerCase();
      const ct =
        ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'application/octet-stream';
      res.type(ct).send(data);
    } catch {
      res.status(404).send('Not found');
    }
  });

  // Register all route modules
  registerAuthRoutes(app, port);
  registerApiRoutes(app);
  registerAdminRoutes(app);
  registerProbeRoutes(app);
  registerPageRoutes(app);

  Sentry.setupExpressErrorHandler(app);

  const server = app.listen(port, () => {
    log.info({ port }, `Server listening on http://localhost:${port}`);
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      log.fatal({ port }, `Port ${port} is already in use`);
      process.exit(1);
    }
    throw err;
  });
}
