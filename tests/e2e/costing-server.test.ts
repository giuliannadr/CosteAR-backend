import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const PORT = 4310;
const BASE_URL = `http://127.0.0.1:${PORT}/api/v1`;
let server: ChildProcess | undefined;
let serverOutput = '';

function ephemeralSecrets(): Record<string, string> {
  const output = execFileSync(process.execPath, ['scripts/generate-keys.mjs'], { encoding: 'utf8' });
  return Object.fromEntries(output.trim().split('\n').map((line) => {
    const separator = line.indexOf('=');
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
}

async function request(path: string, options: RequestInit = {}) {
  return fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...options.headers },
  });
}

async function json(response: Response): Promise<{ data: Record<string, unknown> }> {
  expect(response.headers.get('content-type')).toContain('application/json');
  return response.json() as Promise<{ data: Record<string, unknown> }>;
}

async function waitForServer(): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) return;
    } catch {
      // El binario todavia esta iniciando; la proxima consulta confirma que escucha.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`El servidor compilado no respondio /health en 30 segundos: ${serverOutput}`);
}

async function registerAndLogin(suffix: string): Promise<string> {
  const terms = await json(await request('/terms/current'));
  const email = `e2e-${suffix}@test.local`;
  const password = 'PruebaE2E2026';
  const cuit = randomUUID().replace(/\D/g, '').padEnd(11, '0').slice(0, 11);
  const register = await request('/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      email, password, name: 'Cuenta de prueba', cuit, professionalType: 'OTRO',
      acceptedTerms: true, termsVersionId: terms.data.id,
    }),
  });
  expect(register.status).toBe(201);
  const login = await request('/auth/login', { method: 'POST', body: JSON.stringify({ identifier: email, password }) });
  expect(login.status).toBe(200);
  return (await json(login)).data.accessToken as string;
}

function authorization(token: string): HeadersInit {
  return { authorization: `Bearer ${token}` };
}

async function assertApplicationRole(): Promise<void> {
  const db = new PrismaClient();
  try {
    const [role] = await db.$queryRaw<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
    `;
    // Si esta conexion fuera superusuario, la prueba de aislamiento pasaria por
    // los filtros de aplicacion aunque Postgres no estuviera aplicando RLS.
    expect(role).toMatchObject({ rolsuper: false, rolbypassrls: false });
  } finally {
    await db.$disconnect();
  }
}

beforeAll(async () => {
  await assertApplicationRole();
  server = spawn(process.execPath, ['dist/infrastructure/http/server.js'], {
    env: {
      ...process.env,
      ...ephemeralSecrets(),
      NODE_ENV: 'test',
      PORT: String(PORT),
      // No se usa el duenio: esta es la conexion que debe obedecer las politicas.
      DATABASE_URL: process.env.DATABASE_URL,
    },
    stdio: 'pipe',
  });
  server.stdout?.on('data', (chunk: Buffer) => { serverOutput += chunk.toString(); });
  server.stderr?.on('data', (chunk: Buffer) => { serverOutput += chunk.toString(); });
  await waitForServer();
});

afterAll(async () => {
  if (!server || server.exitCode !== null) return;
  server.kill('SIGTERM');
  await new Promise<void>((resolve) => server!.once('exit', () => resolve()));
});

describe('E2E: costeo por ordenes contra el servidor compilado', () => {
  it('autentica, abre el periodo, calcula y no filtra datos entre empresas', async () => {
    const tokenA = await registerAndLogin(randomUUID());
    const companyResponse = await request('/companies', {
      method: 'POST', headers: authorization(tokenA), body: JSON.stringify({ name: 'Empresa de prueba', periodicity: 'MONTHLY' }),
    });
    expect(companyResponse.status).toBe(201);
    const companyId = (await json(companyResponse)).data.id as string;

    const structureResponse = await request(`/companies/${companyId}/cost-structures`, {
      method: 'POST', headers: authorization(tokenA),
      body: JSON.stringify({ productName: 'Producto de prueba', period: '2026-08', costingSystem: 'ORDERS' }),
    });
    expect(structureResponse.status).toBe(201);
    const structureId = (await json(structureResponse)).data.id as string;

    const periodResponse = await request(`/structures/${structureId}/periods`, {
      method: 'POST', headers: authorization(tokenA), body: JSON.stringify({ carryAmounts: false }),
    });
    expect(periodResponse.status).toBe(201);

    const rawMaterial = await request(`/cost-structures/${structureId}/raw-material`, {
      method: 'PUT', headers: authorization(tokenA),
      body: JSON.stringify({ materials: [{
        name: 'Insumo de prueba', unit: 'unidad',
        wilson: { annualDemand: 100, orderCost: 10, holdingRate: 0.3, unitCost: 4 },
        stockPolicy: { minConsumption: 1, maxConsumption: 2, minLeadTime: 1, maxLeadTime: 2, safetyStock: 1 },
        initialStock: { quantity: 10, unitCost: 4 },
        movements: [{ date: '2026-08-10', type: 'consumption', detail: 'Consumo de prueba', quantity: 6 }],
      }] }),
    });
    expect(rawMaterial.status).toBe(200);

    const directLabor = await request(`/cost-structures/${structureId}/direct-labor`, {
      method: 'PUT', headers: authorization(tokenA),
      body: JSON.stringify({
        workingDays: {
          totalDaysPerYear: 365,
          unpaidAbsence: { sundays: 0, saturdays: 0, unjustifiedAbsences: 0, holidaysOnWeekend: 0 },
          paidAbsence: { holidays: 0, vacations: 0, sickness: 0, specialLeaves: 0, workAccidents: 0 },
        },
        itcs: { derivationBase: 0, fixedArt: 0, uncertainRemunerative: [], uncertainNonRemunerative: [] },
        departments: [{ name: 'Operacion', basicRemuneration: 24, hoursWorked: 8 }],
      }),
    });
    expect(directLabor.status).toBe(200);

    const indirectCosts = await request(`/cost-structures/${structureId}/indirect-costs`, {
      method: 'PUT', headers: authorization(tokenA),
      body: JSON.stringify({
        centers: [{ id: 'centro-prueba', name: 'Centro de prueba', type: 'productive' }],
        concepts: [{ name: 'Servicio de prueba', amount: { fixed: 12, variable: 0 }, distribution: { 'centro-prueba': 1 } }],
        serviceDistributions: [],
        productiveSettings: [{ centerId: 'centro-prueba', normalCapacity: 6, actualActivity: 6, actualCip: 12 }],
      }),
    });
    expect(indirectCosts.status).toBe(200);

    const sales = await request(`/cost-structures/${structureId}/sales`, {
      method: 'PUT', headers: authorization(tokenA),
      body: JSON.stringify({ salesUnitPrice: 15, salesQuantity: 6, productionQuantity: 6 }),
    });
    expect(sales.status).toBe(200);

    const calculation = await request(`/cost-structures/${structureId}/calculate`, {
      method: 'POST', headers: authorization(tokenA), body: JSON.stringify({}),
    });
    expect(calculation.status).toBe(200);
    const result = (await json(calculation)).data.result as {
      productionCost: number;
      detail: { unitCost: { unitProductionCost: number; basadoEn: string } };
    };
    expect(result.productionCost).toBe(62);
    expect(result.detail.unitCost).toMatchObject({ unitProductionCost: 10.33, basadoEn: 'producidas' });

    const tokenB = await registerAndLogin(randomUUID());
    const crossTenant = await request(`/companies/${companyId}/cost-structures`, { headers: authorization(tokenB) });
    expect(crossTenant.status).toBe(404);
  });
});
