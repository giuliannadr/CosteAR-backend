import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';

const USER = 'user-1';
const PERIOD_ID = '00000000-0000-0000-0000-000000000001';

const { db } = vi.hoisted(() => ({
  db: {
    costPeriod: { findFirst: vi.fn() },
    calculationRun: { findFirst: vi.fn() },
    unidadMedida: { findFirst: vi.fn() },
    parametroCosteo: { findMany: vi.fn() },
  },
}));

vi.mock('@/infrastructure/database/prisma.js', () => ({
  prisma: db,
  withTenant: async (_userId: string, fn: (tx: unknown) => unknown) => fn(db),
}));

vi.mock('@/infrastructure/http/plugins/authenticate.js', () => ({
  authenticate: async (request: FastifyRequest, _reply: FastifyReply) => {
    (request as FastifyRequest & { authUser: object }).authUser = { id: USER, role: 'COSTISTA', jobTitle: null };
  },
}));

async function app() {
  const Fastify = (await import('fastify')).default;
  const { registerOwnerDashboardRoutes } = await import('@/infrastructure/http/routes/owner-dashboard.routes.js');
  const { errorHandler } = await import('@/infrastructure/http/error-handler.js');
  const server = Fastify({ logger: false });
  server.setErrorHandler(errorHandler);
  await server.register(registerOwnerDashboardRoutes);
  await server.ready();
  return server;
}

beforeEach(() => {
  vi.clearAllMocks();
  db.costPeriod.findFirst.mockResolvedValue({ id: PERIOD_ID, code: '2026-09', companyId: 'company-1', productionQuantity: 24, salesQuantity: 24 });
  db.unidadMedida.findFirst.mockResolvedValue({ factor: 12 });
  db.parametroCosteo.findMany.mockResolvedValue([]);
  db.calculationRun.findFirst.mockResolvedValue({
    id: 'run-1', validated: true, executedAt: new Date('2026-09-02T00:00:00.000Z'),
    results: {
      grossMargin: 12, incompletitud: { incompleto: false, motivos: [] },
      detail: { unitCost: { unitFinishedGoodsCost: 5, basadoEn: 'producidas' } },
      contribucionMarginal: { incompleta: false, precioUnitario: 4, unidadesVendidas: 24, costoVariableUnitario: 2, contribucionMarginalUnitaria: 2, componentes: [] },
      puntoEquilibrio: { incompleta: false, unidadesEquilibrio: 24, fechaUltimoRecalculo: '2026-09-02T00:00:00.000Z' },
    },
  });
});

describe('GET /periods/:id/tablero-dueno', () => {
  it('devuelve en una llamada el contrato de los seis indicadores', async () => {
    const server = await app();
    const response = await server.inject({ method: 'GET', url: `/periods/${PERIOD_ID}/tablero-dueno` });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { data: Record<string, unknown> };
    expect(body.data).toHaveProperty('costoPorCajon');
    expect(body.data).toHaveProperty('precioPromedioVenta');
    expect(body.data).toHaveProperty('contribucionMarginalPorCajon');
    expect(body.data).toHaveProperty('puntoEquilibrioCajones');
    expect(body.data).toHaveProperty('producidoCajones');
    expect(body.data).toHaveProperty('resultadoPeriodo');
    expect(body.data).toMatchObject({ pendientes: [] });
    expect(body.data.costoPorCajon).toMatchObject({
      variable: { parametrosSinConfirmar: false, parametrosSinConfirmarDetalle: [] },
    });
  });

  it('enumera los parámetros sin confirmar sin consultas por indicador', async () => {
    db.calculationRun.findFirst.mockResolvedValue({
      id: 'run-1', validated: true, executedAt: new Date('2026-09-02T00:00:00.000Z'),
      results: {
        grossMargin: 12, incompletitud: { incompleto: false, motivos: [] },
        detail: { unitCost: { unitFinishedGoodsCost: 5, basadoEn: 'producidas' } },
        contribucionMarginal: {
          incompleta: false, precioUnitario: 4, unidadesVendidas: 24, costoVariableUnitario: 2, contribucionMarginalUnitaria: 2,
          componentes: [{ importeAbsorcion: 36, comportamientoVolumen: 'FIJO', parametroId: 'parametro-1' }],
        },
        puntoEquilibrio: { incompleta: false, unidadesEquilibrio: 24, fechaUltimoRecalculo: '2026-09-02T00:00:00.000Z' },
      },
    });
    db.parametroCosteo.findMany.mockResolvedValue([{ id: 'parametro-1', clave: 'rendimiento_operativo', descripcion: 'Rendimiento operativo' }]);

    const server = await app();
    const response = await server.inject({ method: 'GET', url: `/periods/${PERIOD_ID}/tablero-dueno` });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { data: { costoPorCajon: { variable: Record<string, unknown> } } };
    expect(body.data.costoPorCajon.variable).toMatchObject({
      parametrosSinConfirmar: true,
      parametrosSinConfirmarDetalle: [{ id: 'parametro-1', nombre: 'Rendimiento operativo' }],
    });
    expect(db.parametroCosteo.findMany).toHaveBeenCalledTimes(1);
  });

  it('devuelve los pendientes estructurados sin alterar los motivos de cada indicador', async () => {
    db.costPeriod.findFirst.mockResolvedValue({ id: PERIOD_ID, code: '2026-09', companyId: 'company-1', productionQuantity: 0, salesQuantity: 0 });
    db.unidadMedida.findFirst.mockResolvedValue(null);
    db.calculationRun.findFirst.mockResolvedValue({
      id: 'run-1', validated: true, executedAt: new Date('2026-09-02T00:00:00.000Z'),
      results: {
        grossMargin: null,
        incompletitud: {
          incompleto: true,
          motivos: ['Hay un dato sin imputar.'],
          datosPendientes: [{ id: 'dato-1', nombre: 'Compra de prueba' }],
        },
        detail: { unitCost: { unitFinishedGoodsCost: null, basadoEn: 'producidas' } },
        contribucionMarginal: {
          incompleta: true, precioUnitario: 0, unidadesVendidas: 0, costoVariableUnitario: null, contribucionMarginalUnitaria: null,
          componentes: [{ etiqueta: 'Materia prima', importeAbsorcion: 0, comportamientoVolumen: null, parametroId: null }],
          motivos: [
            'Falta clasificar frente al volumen el rubro Materia prima.',
            'Falta una cantidad vendida mayor a cero para obtener el costo variable unitario.',
          ],
        },
        puntoEquilibrio: {
          incompleta: false, unidadesEquilibrio: null, fechaUltimoRecalculo: '2026-09-02T00:00:00.000Z',
          motivos: [
            'Falta clasificar frente al volumen el rubro Materia prima.',
            'Falta una cantidad vendida mayor a cero para obtener el costo variable unitario.',
          ],
          motivoSinEquilibrio: 'La contribución marginal unitaria es cero o negativa; no existe punto de equilibrio.',
        },
      },
    });

    const server = await app();
    const response = await server.inject({ method: 'GET', url: `/periods/${PERIOD_ID}/tablero-dueno` });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { data: { pendientes: Array<{ area: string; dato: string; periodo: { id: string; codigo: string } }>; precioPromedioVenta: { motivos: string[] } } };
    expect(body.data.pendientes).toEqual(expect.arrayContaining([
      { area: 'imputacion', dato: 'Compra de prueba', periodo: { id: PERIOD_ID, codigo: '2026-09' } },
      { area: 'configuracion', dato: 'unidad de venta "cajon" con factor de conversión', periodo: { id: PERIOD_ID, codigo: '2026-09' } },
      { area: 'produccion', dato: 'cantidad producida mayor a cero', periodo: { id: PERIOD_ID, codigo: '2026-09' } },
      { area: 'ventas', dato: 'ventas del período', periodo: { id: PERIOD_ID, codigo: '2026-09' } },
      { area: 'costeo', dato: 'clasificación frente al volumen del rubro Materia prima', periodo: { id: PERIOD_ID, codigo: '2026-09' } },
      { area: 'costeo', dato: 'contribución marginal unitaria positiva', periodo: { id: PERIOD_ID, codigo: '2026-09' } },
      { area: 'costeo', dato: 'resultado de costos de la corrida', periodo: { id: PERIOD_ID, codigo: '2026-09' } },
    ]));
    expect(body.data.pendientes.filter((pendiente) => pendiente.area === 'ventas')).toHaveLength(1);
    expect(body.data.precioPromedioVenta.motivos).toContain('Falta cargar ventas del período para obtener este indicador.');
  });

  it('expone la falta de corrida como pendiente de cálculo', async () => {
    db.calculationRun.findFirst.mockResolvedValue(null);

    const server = await app();
    const response = await server.inject({ method: 'GET', url: `/periods/${PERIOD_ID}/tablero-dueno` });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { data: { pendientes: unknown[]; resultadoPeriodo: { motivos: string[] } } };
    expect(body.data.pendientes).toEqual([
      { area: 'calculo', dato: 'corrida de cálculo', periodo: { id: PERIOD_ID, codigo: '2026-09' } },
    ]);
    expect(body.data.resultadoPeriodo.motivos).toEqual(['No hay una corrida de cálculo para este período.']);
  });
});
