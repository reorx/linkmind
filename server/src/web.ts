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

  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(cookieParser());

  // Serve images from data/images directory
  const imagesDir = path.resolve(import.meta.dirname, '../data/images');
  app.use('/images', express.static(imagesDir));

  // Register all route modules
  registerAuthRoutes(app, port);
  registerApiRoutes(app);
  registerAdminRoutes(app);
  registerProbeRoutes(app);
  registerPageRoutes(app);

  Sentry.setupExpressErrorHandler(app);

  app.listen(port, () => {
    log.info({ port }, `Server listening on http://localhost:${port}`);
  });
}
