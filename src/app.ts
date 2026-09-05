import express, { Application, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import path from 'path';
import swaggerUi from 'swagger-ui-express';
import { v1Router } from './routes/v1';
import { errorHandler } from './middleware/errorHandler';
import { apiRateLimiter } from './middleware/rateLimiter';
import { swaggerDocument } from './config/swagger';
import { env } from './config/env';

export const app: Application = express();

// 1. Security & Core Middlewares
app.use(
  helmet({
    contentSecurityPolicy: false, // Allows embedded dashboard scripts and Swagger UI assets
  })
);
app.use(cors({ origin: env.CORS_ORIGIN }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

if (env.NODE_ENV !== 'test') {
  app.use(morgan('dev'));
}

// 2. Swagger OpenAPI Documentation at /docs
app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

// 3. Static Assets for Live War-Room Dashboard at /dashboard
const publicDir = path.join(__dirname, '../public');
app.use('/dashboard', express.static(publicDir));
app.get('/', (_req: Request, res: Response) => {
  res.redirect('/dashboard');
});

// 4. API v1 Routes with Rate Limiting
app.use('/api/v1', apiRateLimiter, v1Router);

// 5. Health Check Endpoint
app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'HEALTHY',
    service: 'WaveShift Nexus',
    timestamp: new Date().toISOString(),
  });
});

// 6. Centralized Error Handler (Must be registered last)
app.use(errorHandler);
