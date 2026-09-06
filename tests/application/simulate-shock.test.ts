import { describe, it, expect, vi } from 'vitest';
import { CostStructureService } from '@/application/cost-structures/cost-structure-service.js';

/**
 * SIMULADOR DE ESCENARIOS (Shock Test) — con el motor de N materias primas.
 *
 * El simulador venía de la época en que una estructura tenía UNA sola materia
 * prima (`rawMaterial.wilson`, `rawMaterial.movements`). Al traer el motor nuevo
 * (N materias primas), ese código dejaba de compilar y, peor, el shock de precio
 * habría golpeado a una sola materia prima.
 *
 * Estos tests fijan el contrato: el shock golpea a TODAS.
 */

const structure = {
  id: 'struct-1',
  userId: 'user-1',
  companyId: 'comp-1',
  salesUnitPrice: 25000,
  salesQuantity: 100,
  rawMaterialConfig: {
    materials: [
      {
        name: 'Chapa', code: 'MP-001', unit: 'u',
        wilson: { annualDemand: 6000, orderCost: 5000, holdingRate: 0.3, unitCost: 1000 },
        stockPolicy: { minConsumption: 20, maxConsumption: 40, minLeadTime: 5, maxLeadTime: 12, safetyStock: 200 },
        initialStock: { quantity: 100, unitCost: 1000 },
        movements: [
          { date: '05/01/2026', type: 'purchase', detail: 'Compra', quantity: 400, unitCost: 1000 },
          { date: '15/01/2026', type: 'consumption', detail: 'Consumo', quantity: 300 },
        ],
      },
      {
        name: 'Madera', code: 'MP-002', unit: 'u',
        wilson: { annualDemand: 3000, orderCost: 4000, holdingRate: 0.3, unitCost: 500 },
        stockPolicy: { minConsumption: 10, maxConsumption: 20, minLeadTime: 3, maxLeadTime: 8, safetyStock: 100 },
        initialStock: { quantity: 50, unitCost: 500 },
        movements: [
          { date: '06/01/2026', type: 'purchase', detail: 'Compra', quantity: 200, unitCost: 500 },
          { date: '16/01/2026', type: 'consumption', detail: 'Consumo', quantity: 150 },
        ],
      },
    ],
  },
  directLaborConfig: {
    workingDays: {
      totalDaysPerYear: 365,
      unpaidAbsence: { sundays: 52, saturdays: 52, unjustifiedAbsences: 0, holidaysOnWeekend: 0 },
      paidAbsence: { holidays: 15, vacations: 14, sickness: 0, specialLeaves: 0, workAccidents: 0 },
    },
    itcs: { derivationBase: 0.27, fixedArt: 0.015, uncertainRemunerative: [], uncertainNonRemunerative: [] },
    departments: [{ name: 'Corte', basicRemuneration: 800000, hoursWorked: 160 }],
  },
  indirectCostConfig: {
    centers: [{ id: 'corte', name: 'Corte', type: 'productive' }],
    concepts: [
      { name: 'Alquiler', amount: { fixed: 300000, variable: 0 }, distribution: { corte: 100 } },
    ],
    serviceDistributions: [],
    productiveSettings: [
      { centerId: 'corte', normalCapacity: 160, actualActivity: 150, actualCip: 350000 },
    ],
  },
};

function serviceWith() {
  const db = {
    costStructure: { findFirst: vi.fn(async () => structure) },
    dataPoint: { findMany: vi.fn(async () => []) },
    costPeriod: { findFirst: vi.fn(async () => null) },
    parametroCosteo: { findMany: vi.fn(async () => []) },
  };
  return new CostStructureService(db as never);
}

describe('Shock Test — con N materias primas', () => {
  it('el shock de precio golpea a TODAS las materias primas, no solo a la primera', async () => {
    const svc = serviceWith();

    const base = await svc.simulate('user-1', 'struct-1', {});
    const shock = await svc.simulate('user-1', 'struct-1', { rawMaterial: 1 }); // +100%

    // Duplicar el precio de TODAS las MP duplica la MP consumida.
    expect(shock.result.rawMaterialConsumed).toBeCloseTo(base.result.rawMaterialConsumed * 2, 6);
    // Y la MP consumida no es cero (si el simulador tomara una sola MP, no cerraría).
    expect(base.result.rawMaterialConsumed).toBeGreaterThan(0);
  });

  it('el shock de mano de obra sube el costo de MOD, y no toca la materia prima', async () => {
    const svc = serviceWith();

    const base = await svc.simulate('user-1', 'struct-1', {});
    const shock = await svc.simulate('user-1', 'struct-1', { directLabor: 0.5 }); // +50%

    expect(shock.result.directLaborTotal).toBeCloseTo(base.result.directLaborTotal * 1.5, 6);
    expect(shock.result.rawMaterialConsumed).toBe(base.result.rawMaterialConsumed);
  });

  it('el shock de precio de venta cambia el margen, no el costo', async () => {
    const svc = serviceWith();

    const base = await svc.simulate('user-1', 'struct-1', {});
    const shock = await svc.simulate('user-1', 'struct-1', { sales: 0.2 }); // +20%

    expect(shock.result.productionCost).toBe(base.result.productionCost);
    expect(shock.result.grossMargin).toBeGreaterThan(base.result.grossMargin);
  });

  it('simular NO guarda nada (es un what-if, no un cálculo real)', async () => {
    const db = {
      costStructure: { findFirst: vi.fn(async () => structure) },
      dataPoint: { findMany: vi.fn(async () => []) },
      costPeriod: { findFirst: vi.fn(async () => null) },
      parametroCosteo: { findMany: vi.fn(async () => []) },
      costCalculation: { create: vi.fn() },
      $transaction: vi.fn(),
    };
    const svc = new CostStructureService(db as never);

    await svc.simulate('user-1', 'struct-1', { rawMaterial: 0.3 });

    expect(db.costCalculation.create).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});
