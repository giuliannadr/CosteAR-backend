import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * F4 / F04 — Doble período: un dato sin decisión de imputación NO se ignora en
 * silencio. Antes BLOQUEABA el cálculo (422); ahora el cálculo CORRE pero el
 * resultado se MARCA como incompleto (`incompletitud`), con el motivo y los datos
 * afectados por su nombre humano, para que el frontend pinte una advertencia en
 * vez de un margen "sano" (F04). El bloqueo duro se movió al CIERRE del período.
 * Además, la latencia de captación se calcula por área.
 */

/** Config mínima válida para que el motor corra sin faltantes. */
const configValida = {
  rawMaterialConfig: {
    wilson: { annualDemand: 100, orderCost: 10, holdingRate: 0.3, unitCost: 5 },
    stockPolicy: { minConsumption: 1, maxConsumption: 2, minLeadTime: 1, maxLeadTime: 2, safetyStock: 1 },
    initialStock: { quantity: 10, unitCost: 5 },
    movements: [],
  },
  directLaborConfig: {
    workingDays: {
      totalDaysPerYear: 365,
      unpaidAbsence: { sundays: 0, saturdays: 0, unjustifiedAbsences: 0, holidaysOnWeekend: 0 },
      paidAbsence: { holidays: 0, vacations: 0, sickness: 0, specialLeaves: 0, workAccidents: 0 },
    },
    itcs: { derivationBase: 0.27, fixedArt: 0.015, uncertainRemunerative: [], uncertainNonRemunerative: [] },
    departments: [{ name: 'D', basicRemuneration: 1000, hoursWorked: 10 }],
  },
  indirectCostConfig: {
    centers: [{ id: 'c1', name: 'C1', type: 'productive' }],
    concepts: [{ name: 'X', amount: { fixed: 10, variable: 0 }, distribution: { c1: 1 } }],
    serviceDistributions: [],
    productiveSettings: [{ centerId: 'c1', normalCapacity: 10, actualActivity: 10, actualCip: 10 }],
  },
  salesUnitPrice: 100,
  salesQuantity: 10,
};

const mockTx = {
  costStructure: { findFirst: vi.fn() },
  dataPoint: { findMany: vi.fn(), findFirst: vi.fn() },
  parametroCosteo: { findMany: vi.fn().mockResolvedValue([]) },
  // Lock de fila que persistCalculationRun toma antes de asignar runN.
  $queryRaw: vi.fn().mockResolvedValue([]),
  calculationRun: { findFirst: vi.fn(), create: vi.fn() },
  // La corrida se adjudica al período abierto de la estructura. Estas pruebas
  // son sobre la incompletitud, no sobre períodos: sin período abierto la
  // corrida queda con `periodId: null` y el cálculo sigue igual.
  costPeriod: { findFirst: vi.fn().mockResolvedValue(null) },
  calculationNode: { create: vi.fn().mockResolvedValue({ id: 'node-1' }) },
  traceAuditLog: { create: vi.fn(), count: vi.fn(), findMany: vi.fn() },
  // T-07 — la MISMA corrida escribe también la fila legada (`cost_calculations`),
  // en esta transacción, para que el número que se muestra y el árbol que lo
  // explica salgan de una sola ejecución del motor. Antes lo escribía el otro
  // endpoint, en su propia corrida.
  costCalculation: { create: vi.fn().mockResolvedValue({ id: 'calc-1' }) },
};

vi.mock('@/infrastructure/database/prisma.js', () => ({
  prisma: mockTx,
  withTenant: (_userId: string, fn: (tx: typeof mockTx) => unknown) => fn(mockTx),
}));

const actor = { id: 'user-1', role: 'COSTISTA', area: 'costista' };

describe('CalculationRunService — dato sin imputar marca el resultado incompleto (no lo bloquea)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('CALCULA igual, pero marca el resultado incompleto con el motivo y los datos afectados', async () => {
    const { CalculationRunService } = await import('@/application/cost-structures/calculation-run-service.js');
    const service = new CalculationRunService(mockTx as never);

    mockTx.costStructure.findFirst.mockResolvedValue({ id: 'st-1', userId: 'user-1', ...configValida });
    mockTx.dataPoint.findMany.mockResolvedValue([
      { id: 'dp-1', label: 'Compra — Proveedor Sur, 27/06' },
    ]);
    mockTx.calculationRun.findFirst.mockResolvedValue(null);
    mockTx.calculationRun.create.mockResolvedValue({ id: 'run-1', runN: 1 });

    const result = await service.calculate('user-1', 'st-1', actor);

    // El cálculo NO se bloquea: hay corrida.
    expect(result.run.runN).toBe(1);
    // Y el resultado viene marcado como incompleto, con el dato por su NOMBRE.
    expect(result.incompletitud.incompleto).toBe(true);
    expect(result.incompletitud.datosPendientes).toEqual([
      { id: 'dp-1', nombre: 'Compra — Proveedor Sur, 27/06' },
    ]);
    expect(result.incompletitud.motivos).toHaveLength(1);
    expect(result.incompletitud.motivos[0]).toContain('Compra — Proveedor Sur, 27/06');
    // La marca viaja DENTRO de results (lo que se persiste con la corrida).
    expect((result.results as { incompletitud: unknown }).incompletitud).toEqual(result.incompletitud);

    // Regla #7: ni endpoints ni ids internos en el mensaje al costista.
    const motivo = result.incompletitud.motivos[0]!;
    expect(motivo).not.toMatch(/POST|\/data-points|:id/);
    expect(motivo).not.toContain('dp-1');
  });

  it('sin data points pendientes, el resultado NO queda marcado (incompleto: false)', async () => {
    const { CalculationRunService } = await import('@/application/cost-structures/calculation-run-service.js');
    const service = new CalculationRunService(mockTx as never);

    mockTx.costStructure.findFirst.mockResolvedValue({ id: 'st-1', userId: 'user-1', ...configValida });
    mockTx.dataPoint.findMany.mockResolvedValue([]); // sin pendientes
    mockTx.calculationRun.findFirst.mockResolvedValue(null);
    mockTx.calculationRun.create.mockResolvedValue({ id: 'run-1', runN: 1 });

    const result = await service.calculate('user-1', 'st-1', actor);
    expect(result.run.runN).toBe(1);
    expect(result.incompletitud.incompleto).toBe(false);
    expect(result.incompletitud.datosPendientes).toEqual([]);
    expect(mockTx.traceAuditLog.create).toHaveBeenCalled();
  });
});

describe('DataPointService.getAudit — latencia de captación por área', () => {
  beforeEach(() => vi.clearAllMocks());

  it('promedia fechaCaptacion - fechaHecho en días, agrupado por sourceArea', async () => {
    const { DataPointService } = await import('@/application/trazabilidad/data-point-service.js');
    const db = {
      costStructure: { findFirst: vi.fn().mockResolvedValue({ id: 'st-1', userId: 'user-1' }) },
      dataPoint: {
        findMany: vi.fn().mockImplementation(({ select }: { select?: Record<string, boolean> }) => {
          if (select) {
            return Promise.resolve([
              { sourceArea: 'deposito', fechaHecho: new Date('2026-06-01'), fechaCaptacion: new Date('2026-06-03') },
              { sourceArea: 'deposito', fechaHecho: new Date('2026-06-05'), fechaCaptacion: new Date('2026-06-06') },
              { sourceArea: 'contaduria', fechaHecho: new Date('2026-06-01'), fechaCaptacion: new Date('2026-06-11') },
            ]);
          }
          return Promise.resolve([]);
        }),
      },
      calculationRun: { findMany: vi.fn().mockResolvedValue([]) },
      traceAuditLog: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
    };
    const service = new DataPointService(db as never);

    const audit = await service.getAudit('user-1', 'st-1', 1, 50);

    const deposito = audit.latencyByArea.find((a) => a.area === 'deposito')!;
    const contaduria = audit.latencyByArea.find((a) => a.area === 'contaduria')!;
    expect(deposito.avgDays).toBe(1.5); // (2 + 1) / 2
    expect(deposito.count).toBe(2);
    expect(contaduria.avgDays).toBe(10);
  });
});
