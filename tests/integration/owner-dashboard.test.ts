import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OwnerDashboardService } from '@/application/cost-structures/owner-dashboard-service.js';
import { withTenant } from '@/infrastructure/database/prisma.js';
import { createTenant, disconnect, type Tenant } from './helpers/tenants.js';

let A: Tenant;
let B: Tenant;

beforeAll(async () => {
  A = await createTenant('tablero-dueno-a');
  B = await createTenant('tablero-dueno-b');
  await withTenant(A.userId, async (tx) => {
    await tx.unidadMedida.create({
      data: { companyId: A.companyId, userId: A.userId, codigo: 'cajon', nombre: 'Cajón de prueba', factor: 12 },
    });
    await tx.costPeriod.update({ where: { id: A.periodId }, data: { productionQuantity: 24, salesQuantity: 24 } });
    await tx.calculationRun.create({
      data: {
        structureId: A.structureId, periodId: A.periodId, runN: 1, engineVersion: 'test', executedBy: A.userId,
        inputsSnapshot: {},
        results: {
          grossMargin: 12,
          incompletitud: { incompleto: false, motivos: [] },
          detail: { unitCost: { unitFinishedGoodsCost: 5, basadoEn: 'producidas' } },
          contribucionMarginal: {
            incompleta: false, precioUnitario: 4, unidadesVendidas: 24, costoVariableUnitario: 2,
            contribucionMarginalUnitaria: 2,
            componentes: [{ importeAbsorcion: 36, comportamientoVolumen: 'FIJO', parametroId: null }],
          },
          puntoEquilibrio: { incompleta: false, unidadesEquilibrio: 24, fechaUltimoRecalculo: '2026-09-02T00:00:00.000Z' },
        },
      },
    });
  });
});

afterAll(disconnect);

describe('A-07 — tablero del dueño por período', () => {
  it('compone los seis números en cajones desde una corrida ya persistida', async () => {
    const tablero = await new OwnerDashboardService().get(A.userId, A.periodId);
    expect(tablero).toMatchObject({
      costoPorCajon: { variable: { valor: 24, completo: true }, fijo: { valor: 18, completo: true }, total: { valor: 60, completo: true } },
      precioPromedioVenta: { valor: 48, completo: true },
      contribucionMarginalPorCajon: { valor: 24, completo: true },
      puntoEquilibrioCajones: { valor: 2, completo: true, fechaUltimoRecalculo: '2026-09-02T00:00:00.000Z' },
      producidoCajones: { valor: 2, completo: true },
      resultadoPeriodo: { valor: 12, completo: true },
    });
    expect(tablero.costoPorCajon.variable).toMatchObject({ parametrosSinConfirmar: false, parametrosSinConfirmarDetalle: [] });
    expect(tablero.pendientes).toEqual([]);
  });

  it('marca incompletos los indicadores comerciales si no hay ventas', async () => {
    await withTenant(A.userId, async (tx) => {
      await tx.costPeriod.update({ where: { id: A.periodId }, data: { salesQuantity: 0 } });
      await tx.calculationRun.create({
        data: {
          structureId: A.structureId, periodId: A.periodId, runN: 2, engineVersion: 'test', executedBy: A.userId,
          validated: true, inputsSnapshot: {},
          results: {
            grossMargin: 0,
            incompletitud: { incompleto: false, motivos: [] },
            detail: { unitCost: { unitFinishedGoodsCost: 5, basadoEn: 'producidas' } },
            contribucionMarginal: {
              incompleta: true, precioUnitario: 0, unidadesVendidas: 0, costoVariableUnitario: null,
              contribucionMarginalUnitaria: null, componentes: [],
              motivos: ['Falta una cantidad vendida mayor a cero para obtener el costo variable unitario.'],
            },
            puntoEquilibrio: { incompleta: true, unidadesEquilibrio: null, fechaUltimoRecalculo: '2026-09-02T00:00:00.000Z', motivos: ['Falta ventas.'] },
          },
        },
      });
    });
    const tablero = await new OwnerDashboardService().get(A.userId, A.periodId);
    expect(tablero.precioPromedioVenta).toMatchObject({ valor: null, completo: false });
    expect(tablero.contribucionMarginalPorCajon).toMatchObject({ valor: null, completo: false });
    expect(tablero.resultadoPeriodo).toMatchObject({ valor: null, completo: false });
    expect(tablero.precioPromedioVenta.motivos).toContain('Falta cargar ventas del período para obtener este indicador.');
  });

  it('no filtra el período de otro tenant', async () => {
    await expect(new OwnerDashboardService().get(B.userId, A.periodId)).rejects.toThrow(/Período de costos no encontrado/);
  });

  it('enumera el parámetro sin confirmar que afecta cada número', async () => {
    const parametro = await withTenant(A.userId, (tx) => tx.parametroCosteo.create({
      data: {
        companyId: A.companyId,
        userId: A.userId,
        structureId: A.structureId,
        periodId: A.periodId,
        clave: 'rendimiento_operativo',
        descripcion: 'Rendimiento operativo',
        valorNum: 1,
        confirmado: false,
      },
    }));
    await withTenant(A.userId, (tx) => tx.calculationRun.create({
      data: {
        structureId: A.structureId, periodId: A.periodId, runN: 3, engineVersion: 'test', executedBy: A.userId,
        validated: true, inputsSnapshot: {},
        results: {
          grossMargin: 12,
          incompletitud: { incompleto: false, motivos: [] },
          detail: { unitCost: { unitFinishedGoodsCost: 5, basadoEn: 'producidas' } },
          contribucionMarginal: {
            incompleta: false, precioUnitario: 4, unidadesVendidas: 24, costoVariableUnitario: 2,
            contribucionMarginalUnitaria: 2,
            componentes: [{ importeAbsorcion: 36, comportamientoVolumen: 'FIJO', parametroId: parametro.id }],
          },
          puntoEquilibrio: { incompleta: false, unidadesEquilibrio: 24, fechaUltimoRecalculo: '2026-09-02T00:00:00.000Z' },
        },
      },
    }));

    const tablero = await new OwnerDashboardService().get(A.userId, A.periodId);
    const detalle = [{ id: parametro.id, nombre: 'Rendimiento operativo' }];
    expect(tablero.costoPorCajon.variable).toMatchObject({ parametrosSinConfirmar: true, parametrosSinConfirmarDetalle: detalle });
    expect(tablero.precioPromedioVenta).toMatchObject({ parametrosSinConfirmar: true, parametrosSinConfirmarDetalle: detalle });
    expect(tablero.producidoCajones).toMatchObject({ parametrosSinConfirmar: false, parametrosSinConfirmarDetalle: [] });
  });
});
