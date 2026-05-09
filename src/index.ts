import express, { Application } from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import * as dotenv from 'dotenv';
import session from 'express-session';
import passport from 'passport';
import swaggerUi from 'swagger-ui-express';
import * as swaggerDocument from './swagger.json';
import { AppDataSource } from './data-source';
// auth service routers
import { authOTPRouter } from './services/auth-service/controllers/auth-otp-controller';
import { authSiweRouter } from './services/auth-service/controllers/auth-siwe-controller';
import { authGoogleRouter } from './services/auth-service/controllers/auth-google-controller';
import { authHydraRouter } from './services/oauth-provider-service/controllers/auth-hydra-controller';
import { mcpOAuthRouter } from './services/oauth-provider-service/controllers/mcp-oauth-controller';
// user service routers
import { userOnboardingRouter } from './services/user-service/controllers/user-onboarding-controller';
import { userAccountRouter } from './services/user-service/controllers/user-account-controller';
// ai service routers
import { contextRouter } from './services/ai-service/controllers/context-controller';
import { profileRouter } from './services/ai-service/controllers/profile-controller';
import { profileAccessRouter } from './services/ai-service/controllers/profile-access-controller';
import { mcpRouter } from './services/ai-service/controllers/mcp-controller';
import { activityRouter } from './services/ai-service/controllers/activity-controller';
import { notificationRouter } from './services/ai-service/controllers/notification-controller';
// Metrics
import { metricsMiddleware } from './middlewares/metrics-middleware';
import { register } from './lib/metrics';
import Logger from './lib/logger';
import { errorHandler, notFoundHandler } from './middlewares/error-handler';
// subscription service routers
import { subscriptionRouter } from './services/subscription-service/controllers/subscription-controller';
import { appSumoRouter } from './services/subscription-service/controllers/appsumo-controller';
// token service router
import { tokenRouter } from './services/token-service/controllers/token-controller';

dotenv.config();

export const app: Application = express();
const PORT = process.env.PORT;

// Use JSON body parser for all routes except Stripe/AppSumo webhook endpoints
// (those need raw body for signature verification and apply express.raw() inline)
app.use((req, res, next) => {
  if (req.path === '/subscription/webhook' || req.path === '/appsumo/webhook') {
    next();
  } else {
    bodyParser.json({ limit: '50mb' })(req, res, next);
  }
});
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));
app.use(helmet());
app.use(cookieParser());
app.use(cors({ origin: true, credentials: true }));
app.use(passport.initialize());
app.use(session({ secret: 'keyboard cat', resave: false, saveUninitialized: false }));
app.use(passport.session());

// Metrics middleware (must be before routes)
app.use(metricsMiddleware);

// auth service routers
app.use('/auth/otp', authOTPRouter);
app.use('/auth/siwe', authSiweRouter);
app.use('/auth/google', authGoogleRouter);
app.use('/auth/hydra', authHydraRouter);

// oauth-provider service routers (MCP OAuth metadata + DCR proxy — root-level paths)
app.use(mcpOAuthRouter);

// user service routers
app.use('/user/onboarding', userOnboardingRouter);
app.use('/user/account', userAccountRouter);

// ai service router
app.use('/ai/context', contextRouter);
app.use('/ai/profile', profileAccessRouter);
app.use('/ai/profile', profileRouter);
app.use('/ai/activity', activityRouter);
app.use('/ai/notifications', notificationRouter);

// mcp service router
app.use('/mcp', mcpRouter);

// subscription service router
app.use('/subscription', subscriptionRouter);
app.use('/appsumo', appSumoRouter);

// token service router (Personal Access Tokens for headless agents)
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

// Metrics endpoint for Prometheus
// eslint-disable-next-line @typescript-eslint/no-explicit-any
app.get('/metrics', async (req: any, res: any) => {
  // #swagger.ignore = true
  try {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (error) {
    res.status(500).end(error);
  }
});

// Success page
app.get('/success', (req, res) => {
  res.send(`
    <html>
      <body>
        <h1>Payment Successful!</h1>
        <p>Thank you for your purchase.</p>
        <a href="/">Go back to home</a>
      </body>
    </html>
  `);
});

// Cancel page
app.get('/cancel', (req, res) => {
  res.send(`
    <html>
      <body>
        <h1>Payment Cancelled</h1>
        <p>Your payment was cancelled.</p>
        <a href="/">Go back to home</a>
      </body>
    </html>
  `);
});

// AppSumo login — redirect to frontend activation page
app.get('/appsumo/login', (req, res) => {
  // #swagger.tags = ['AppSumo']
  const loginUrl = process.env.APPSUMO_LOGIN_URL ?? '/login';
  const licenseKey = (req.query.appsumo_license_key as string) ?? '';
  const separator = loginUrl.includes('?') ? '&' : '?';
  const params = licenseKey ? `${separator}appsumo_license_key=${encodeURIComponent(licenseKey)}` : '';
  res.redirect(`${loginUrl}${params}`);
});

// AppSumo success — redirect to frontend
app.get('/appsumo/success', (req, res) => {
  // #swagger.tags = ['AppSumo']
  const successUrl = process.env.APPSUMO_SUCCESS_URL ?? '/';
  const alreadyActive = req.query.already_active === 'true' ? '?already_active=true' : '';
  res.redirect(`${successUrl}${alreadyActive}`);
});

// AppSumo error — redirect to frontend
app.get('/appsumo/error', (req, res) => {
  // #swagger.tags = ['AppSumo']
  const errorUrl = process.env.APPSUMO_ERROR_URL ?? '/';
  const error = encodeURIComponent(String(req.query.error ?? 'unknown_error'));
  res.redirect(`${errorUrl}?error=${error}`);
});

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
