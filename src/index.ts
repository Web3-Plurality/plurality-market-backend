import express, { Application } from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import * as dotenv from 'dotenv';
import swaggerUi from 'swagger-ui-express';
import * as swaggerDocument from './swagger.json';
import { AppDataSource } from './data-source';
// auth service routers (wallet-only stack — auth-otp not mounted)
import { authSiweRouter } from './services/auth-service/controllers/auth-siwe-controller';
// user service routers
import { userAccountRouter } from './services/user-service/controllers/user-account-controller';
// ai service routers
import { contextRouter } from './services/ai-service/controllers/context-controller';
import { profileRouter } from './services/ai-service/controllers/profile-controller';
import { mcpRouter } from './services/ai-service/controllers/mcp-controller';
// token service router (PATs)
import { tokenRouter } from './services/token-service/controllers/token-controller';
import Logger from './lib/logger';
import { errorHandler, notFoundHandler } from './middlewares/error-handler';
// blockchain service router
import { blockchainRouter } from './services/blockchain-service/controllers/blockchain-controller';

dotenv.config();

export const app: Application = express();
const PORT = process.env.PORT;

app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));
app.use(helmet());
app.use(cookieParser());
// CORS — locked to the marketplace UI origin (set MARKETPLACE_UI_ORIGIN in env).
// Falls back to the Phase 1 dev default if unset, so local dev still works.
const allowedOrigin = process.env.MARKETPLACE_UI_ORIGIN || 'http://localhost:3001';
app.use(cors({ origin: allowedOrigin, credentials: true }));

// auth service routers (wallet-only — no /auth/otp mount; OAuth removed)
app.use('/auth/siwe', authSiweRouter);

// user service routers
app.use('/user/account', userAccountRouter);

// ai service router
app.use('/ai/context', contextRouter);
app.use('/ai/profile', profileRouter);

// mcp router (semantic-search proxy used by the MCP server's search_memory tool)
app.use('/mcp', mcpRouter);

// blockchain service router
app.use('/blockchain', blockchainRouter);

// token service router (PATs — verify endpoint at /pat/tokens/verify is what MCP calls)
app.use('/pat/tokens', tokenRouter);

// swagger docs — hidden in production by default (set ENABLE_SWAGGER_DOCS=true
// to expose for internal debugging). Avoids leaking the API surface publicly.
const enableSwagger = process.env.ENABLE_SWAGGER_DOCS === 'true' || process.env.NODE_ENV !== 'production';

if (enableSwagger) {
  // Override the `servers` block at runtime so a single swagger.json works for
  // local + prod (the env value is read per-environment, not baked at gen time).
  const swaggerDocWithServers = {
    ...swaggerDocument,
    servers: [
      {
        url: process.env.PLURALITY_BACKEND || 'http://localhost:5000',
        description: '',
      },
    ],
  };
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocWithServers));
  Logger.info('[SWAGGER] Docs enabled at /docs');
} else {
  Logger.info('[SWAGGER] Docs disabled (NODE_ENV=production, set ENABLE_SWAGGER_DOCS=true to enable)');
}

// 404 handler - must be after all routes
app.use(notFoundHandler);

// Global error handler - must be last middleware
app.use(errorHandler);

// Set trust proxy for reverse proxy (Nginx/ALB)
app.set('trust proxy', 1);

AppDataSource.initialize()
  .then(async () => {
    app.listen(PORT, (): void => {
      Logger.info(`Server is running on http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    Logger.error('Database initialization failed:', error);
  });
