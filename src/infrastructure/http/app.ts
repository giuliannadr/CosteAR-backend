import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { getRedisClient } from '../redis/client.js';
import { getEnv } from '../config/env.js';
import { errorHandler } from './error-handler.js';
import * as Sentry from '@sentry/node';
import { nodeProfilingIntegration } from '@sentry/profiling-node';
import { registerAuthRoutes } from './routes/auth.routes.js';
import { registerAccessGateRoutes } from './routes/access-gate.routes.js';
import { registerCompanyRoutes } from './routes/company.routes.js';
import { registerCostStructureRoutes } from './routes/cost-structure.routes.js';
import { registerMacroRoutes } from './routes/macro.routes.js';
import { registerAlertRoutes } from './routes/alert.routes.js';
import { registerUserRoutes } from './routes/user.routes.js';
import { registerValidacionesRoutes } from './routes/validaciones.routes.js';
import { registerEmpresaPortalRoutes } from './routes/empresa-portal.routes.js';
import { registerCostitaChatRoutes } from './routes/costista-chat.routes.js';
import { registerAdvisorRoutes } from './routes/advisor.routes.js';
import { registerTrazabilidadRoutes } from './routes/trazabilidad.routes.js';
import { registerAllocationBaseRoutes } from './routes/allocation-base.routes.js';
import { registerProcessDepartmentRoutes } from './routes/process-department.routes.js';
import { registerProcessSetupRoutes } from './routes/process-setup.routes.js';
import { registerUnitMovementRoutes } from './routes/unit-movement.routes.js';
import { registerDepositoRoutes } from './routes/deposito.routes.js';
import { registerJointCostRoutes } from './routes/joint-cost.routes.js';
import { registerProcessCalculationRoutes } from './routes/process-calculation.routes.js';
import { registerCostPeriodRoutes } from './routes/cost-period.routes.js';
import { registerOwnerDashboardRoutes } from './routes/owner-dashboard.routes.js';
import { registerDesperdicioRoutes } from './routes/desperdicio.routes.js';
import { registerParametrosCosteoRoutes } from './routes/parametros-costeo.routes.js';
import { registerActivoAmortizableRoutes } from './routes/activo-amortizable.routes.js';
import { registerEventosLoteRoutes } from './routes/eventos-lote.routes.js';
import { registerLotesProductivosRoutes } from './routes/lotes-productivos.routes.js';
import { registerProduccionDiariaRoutes } from './routes/produccion-diaria.routes.js';
import { registerStockProductoRoutes } from './routes/stock-producto.routes.js';
import { registerCorridaProduccionRoutes } from './routes/corrida-produccion.routes.js';
import { registerVentaProductoRoutes } from './routes/venta-producto.routes.js';
import { healthPayload } from './health.js';
import { registerVaultRoutes } from './routes/vault.routes.js';
import { registerVaultProposalRoutes } from './routes/vault-proposal.routes.js';
import { registerAdminRoutes } from './routes/admin.routes.js';
import { registerSystemAlertRoutes } from './routes/system-alert.routes.js';
import { registerBenchmarkRoutes } from './routes/benchmark.routes.js';
import { registerWhatsappRoutes } from './routes/whatsapp.routes.js';
import { registerTelegramRoutes } from './routes/telegram.routes.js';
import { registerTermsRoutes } from './routes/terms.routes.js';
import { registerIndustryProfileRoutes } from './routes/industry-profile.routes.js';

/**
 * Construye la instancia Fastify con toda la cadena de seguridad montada.
 * Separado de `listen()` para que los tests de integración puedan usar
 * `app.inject()` sin abrir un puerto real.
 */
export async function buildApp(): Promise<FastifyInstance> {
  const env = getEnv();

  if (env.SENTRY_DSN) {
    Sentry.init({
      dsn: env.SENTRY_DSN,
      integrations: [nodeProfilingIntegration()],
      tracesSampleRate: 1.0,
      profilesSampleRate: 1.0,
    });
  }

  const app = Fastify({
    logger:
      env.NODE_ENV === 'development'
        ? { transport: { target: 'pino-pretty' } }
        : env.NODE_ENV === 'test'
          ? false
          : true,
    trustProxy: true, // detrás de un reverse proxy (Railway/Fly), para IP real
    bodyLimit: 1_048_576, // 1 MiB: un costeo no necesita más; corta payloads abusivos
  });

  app.setErrorHandler(errorHandler);

  if (env.SENTRY_DSN) {
    Sentry.setupFastifyErrorHandler(app);
  }

  // --- Seguridad de transporte y cabeceras ---
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    hsts: { maxAge: 31_536_000, includeSubDomains: true, preload: true },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  });

  // --- CORS: lista blanca explícita, nunca '*' con credenciales ---
  // CORS_ORIGIN puede ser una lista separada por comas: "https://foo.vercel.app,http://localhost:5173"
  const allowedOrigins = env.CORS_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean);
  // Dominios de Vercel del frontend (producción + previews) y localhost: se permiten
  // SIEMPRE, para no depender de que CORS_ORIGIN esté bien seteado en el deploy.
  // Cubre los dos nombres del proyecto ("costear-frontend" y "coste-ar-frontend")
  // y sus URLs de preview. Ej: coste-ar-frontend.vercel.app, coste-ar-frontend-xxx.vercel.app
  // Nota: no hace falta una entrada para sentry.io acá — el webhook de Sentry
  // es server-to-server (sin header Origin), CORS no aplica a esa llamada.
  // Había una entrada así antes (/^https:\/\/.*sentry\.io$/) que además era
  // bypasseable con dominios tipo "evilsentry.io" — se saca directamente.
  const alwaysAllowed = [
    /^https:\/\/costear-frontend[a-z0-9-]*\.vercel\.app$/,
    /^https:\/\/coste-ar-frontend[a-z0-9-]*\.vercel\.app$/,
    /^http:\/\/localhost:\d+$/,
  ];
  const isAllowed = (origin: string) =>
    allowedOrigins.includes(origin) || alwaysAllowed.some((re) => re.test(origin));
  await app.register(cors, {
    origin: (origin, cb) => {
      // Requests sin origin (curl, Postman, server-to-server) siempre pasan.
      if (!origin) return cb(null, true);
      if (isAllowed(origin)) return cb(null, true);
      app.log.warn({ origin, allowedOrigins }, 'CORS: origen rechazado');
      cb(new Error(`Origin ${origin} no permitido por CORS`), false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  // --- Cookies firmadas (refresh token httpOnly) ---
  await app.register(cookie, {
    secret: env.COOKIE_SECRET,
    parseOptions: {},
  });

  // --- Rate limiting global respaldado por Redis ---
  // En test usamos el store en memoria para no requerir Redis.
  if (env.NODE_ENV !== 'test') {
    // retryStrategy: null → falla inmediato si no hay conexión, no reintenta.
    // connectTimeout: 4 000 ms → no bloquea el startup indefinidamente.
    const redis = getRedisClient();
    await app.register(rateLimit, {
      global: true,
      max: 120,
      timeWindow: '1 minute',
      redis: redis.status === 'ready' ? redis : undefined,
    });
  } else {
    await app.register(rateLimit, { global: true, max: 1000, timeWindow: '1 minute' });
  }

  // --- Healthcheck ---
  // Devuelve QUÉ VERSIÓN está corriendo, no solo que el proceso está vivo.
  // El payload vive en `health.ts` para poder testearlo sin construir la app
  // entera (que necesita base, y el CI unitario no la levanta).
  app.get('/health', async () => healthPayload());

  // --- Demo de Trazabilidad Total v1 ---
  // Arnés de verificación estático (HTML+JS vanilla, sin build step) porque
  // el repo del frontend real de CosteAR no está disponible en este checkout
  // — ver DECISIONES.md. Sirve same-origin para no pelear con CORS/CSP.
  const demoDir = fileURLToPath(new URL('../../../public/demo/', import.meta.url));
  const demoFiles: Record<string, { file: string; type: string }> = {
    '/demo': { file: 'index.html', type: 'text/html; charset=utf-8' },
    '/demo/': { file: 'index.html', type: 'text/html; charset=utf-8' },
    '/demo/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
    '/demo/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
    '/demo/app.js': { file: 'app.js', type: 'application/javascript; charset=utf-8' },
  };
  for (const [route, { file, type }] of Object.entries(demoFiles)) {
    app.get(route, async (_request, reply) => {
      const content = await readFile(demoDir + file, 'utf-8');
      reply.header('Content-Type', type).send(content);
    });
  }

  // --- Webhooks ---
  await app.register(registerWhatsappRoutes);
  await app.register(registerTelegramRoutes);

  // --- Rutas de la API (versionadas) ---
  const prefix = `/api/${env.API_VERSION}`;
  await app.register(
    async (api) => {
      await registerAccessGateRoutes(api);
      await registerAuthRoutes(api);
      await registerCompanyRoutes(api);
      await registerCostStructureRoutes(api);
      await registerMacroRoutes(api);
      await registerAlertRoutes(api);
      await registerUserRoutes(api);
      await registerValidacionesRoutes(api);
      await registerEmpresaPortalRoutes(api);
      await registerBenchmarkRoutes(api);
      await registerCostitaChatRoutes(api);
      await registerAdvisorRoutes(api);
      await registerTrazabilidadRoutes(api);
      await registerAllocationBaseRoutes(api);
      await registerProcessDepartmentRoutes(api);
      await registerProcessSetupRoutes(api);
      await registerUnitMovementRoutes(api);
      await registerDepositoRoutes(api);
      await registerJointCostRoutes(api);
      await registerProcessCalculationRoutes(api);
      await registerCostPeriodRoutes(api);
      await registerOwnerDashboardRoutes(api);
      await registerDesperdicioRoutes(api);
      await registerParametrosCosteoRoutes(api);
      await registerActivoAmortizableRoutes(api);
      await registerEventosLoteRoutes(api);
      await registerLotesProductivosRoutes(api);
      await registerProduccionDiariaRoutes(api);
      await registerStockProductoRoutes(api);
      await registerCorridaProduccionRoutes(api);
      await registerVentaProductoRoutes(api);
      await registerVaultRoutes(api);
      await registerVaultProposalRoutes(api);
      await registerAdminRoutes(api);
      await registerSystemAlertRoutes(api);
      await registerTermsRoutes(api);
      await registerIndustryProfileRoutes(api);
    },
    { prefix },
  );

  return app;
}
