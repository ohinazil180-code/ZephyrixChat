import 'dotenv/config';
import http from 'node:http';
import path from 'node:path';
import cookieParser from 'cookie-parser';
import express from 'express';
import { WebSocketServer } from 'ws';
import { authenticateWsRequest, registerAuthRoutes } from './server/auth.ts';
import { closeDatabase, initDatabase, isDatabaseReady } from './server/db.ts';
import { addWebSocketClient, removeWebSocketClient } from './server/events.ts';
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

  // Real-time WebSocket upgrade handler on /api/v1/ws
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    let pathname = '/';
    try {
      pathname = new URL(request.url || '/', 'http://localhost').pathname;
    } catch {
      socket.destroy();
      return;
    }

    if (pathname !== '/api/v1/ws') {
      return;
    }

    const auth = authenticateWsRequest(request);
    if (!auth) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      addWebSocketClient(auth.userId, ws);
      try {
        ws.send(JSON.stringify({ type: 'ws:connected', userId: auth.userId }));
      } catch {
        // ignore
      }

      const heartbeat = setInterval(() => {
        if (ws.readyState === ws.OPEN) {
          ws.ping();
        }
      }, 25000);

      ws.on('close', () => {
        clearInterval(heartbeat);
        removeWebSocketClient(auth.userId, ws);
      });

      ws.on('error', () => {
        clearInterval(heartbeat);
        removeWebSocketClient(auth.userId, ws);
      });
    });
  });

  app.get('/healthz', (_req, res) => {
    const ready = isDatabaseReady();
    res.status(ready ? 200 : 503).json({ ok: ready });
  });

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
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
    app.use(
      express.static(distDir, {
        setHeaders: (res, filePath) => {
          if (filePath.endsWith('.html') || filePath.endsWith('sw.js') || filePath.endsWith('manifest.webmanifest')) {
            res.setHeader('Cache-Control', 'no-cache');
          } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          }
        },
      })
    );
    app.get('*', (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  server.listen(port, '0.0.0.0', () => {
    console.info(`[zephyrix] Server listening on http://0.0.0.0:${port} (${isProd ? 'production' : 'development'})`);
  });

  const shutdown = (signal: string) => {
    console.info(`[zephyrix] Received ${signal}, shutting down gracefully...`);
    wss.close();
    server.close(() => {
      closeDatabase();
      process.exit(0);
    });
    setTimeout(() => {
      closeDatabase();
      process.exit(0);
    }, 5000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

startServer().catch((err) => {
  console.error('[zephyrix] Failed to start server:', err);
  process.exit(1);
});
