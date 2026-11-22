import 'dotenv/config';
import http from 'node:http';
import path from 'node:path';
import cookieParser from 'cookie-parser';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import { registerAuthRoutes } from './server/auth.ts';
import { initDatabase } from './server/db.ts';
import { registerMediaRoutes } from './server/media.ts';
import { registerApiRoutes } from './server/routes.ts';
import {
  corsMiddleware,
  requestContextMiddleware,
  sendApiError,
  verifyCsrfForMutations,
} from './server/security.ts';

async function startServer() {
  const app = express();
  const server = http.createServer(app);
  const port = Number(process.env.PORT || 3000);
  const isProd = process.env.NODE_ENV === 'production';

  app.set('trust proxy', 1);
  app.use(requestContextMiddleware);
  app.use(corsMiddleware);
  app.use(cookieParser());
  app.use(express.json({ limit: '4mb' }));
  app.use(verifyCsrfForMutations);

  initDatabase();

  registerAuthRoutes(app);
  registerMediaRoutes(app);
  registerApiRoutes(app);

  app.all('/api/*', (_req, res) => {
    sendApiError(res, 404, 'API_NOT_FOUND', 'API endpoint not found.');
  });

  if (!isProd) {
    const hmrDisabled = process.env.DISABLE_HMR === 'true';
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        allowedHosts: true,
        hmr: !hmrDisabled,
        ws: { server, path: '/__vite_hmr' },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  server.listen(port, '0.0.0.0', () => {
    console.info(`[zephyrix] Server listening on http://0.0.0.0:${port} (${isProd ? 'production' : 'development'})`);
  });
}

startServer().catch((err) => {
  console.error('[zephyrix] Failed to start server:', err);
  process.exit(1);
});
