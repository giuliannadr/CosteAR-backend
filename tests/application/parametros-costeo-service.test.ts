import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { ParametrosCosteoService } from '@/application/parametros/parametros-costeo-service.js';
import { NotFoundError, UnprocessableEntityError } from '@/domain/errors/domain-error.js';

const recordTraceAudit = vi.fn(async () => undefined);
vi.mock('@/application/audit/trace-audit.js', () => ({
  recordTraceAudit: (...args: unknown[]) => recordTraceAudit(...(args as [])),
}));

// Mismo patrón que `desperdicio-service.test.ts`: acá se prueba la lógica del
// servicio, no el aislamiento entre empresas — eso lo prueba la suite de
// integración con un rol de Postgres sin BYPASSRLS (DOM-07).
const withTenant = vi.fn(async (_userId: string, fn: (tx: unknown) => unknown) => fn(dbActual));
vi.mock('@/infrastructure/database/prisma.js', () => ({
  prisma: {},
  withTenant: (...args: unknown[]) => withTenant(...(args as [string, (tx: unknown) => unknown])),
}));

/**
 * #115 — el cable que le faltaba al catálogo de parámetros de costeo.
 *
 * El dominio (`resolverParametro`, la cascada período → estructura → empresa →
 * default) ya estaba probado en `tests/domain/parametros-costeo.test.ts`. Estos
 * tests cubren la mitad que faltaba: que el servicio lea y escriba la tabla, y
 * que respete pertenencia, RLS y trazabilidad.
 */

const USER = 'user-1';
const COMPANY = { id: 'comp-1', userId: USER };

let dbActual: Record<string, unknown>;

function makeDb(overrides: Record<string, unknown> = {}) {
  const db: Record<string, unknown> = {
    company: { findFirst: vi.fn(async () => COMPANY) },
    costStructure: { findFirst: vi.fn(async () => ({ id: 'est-1', companyId: 'comp-1' })) },
    costPeriod: { findFirst: vi.fn(async () => ({ id: 'per-1', companyId: 'comp-1' })) },
    parametroCosteo: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'pc-1', ...data })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'pc-1', ...data })),
    },
    ...overrides,
  };
  dbActual = db;
  return db;
}

function service(db: Record<string, unknown>) {
  return new ParametrosCosteoService(db as unknown as PrismaClient);
}

const ACTOR = { id: USER, role: 'COSTISTA', area: 'costista', method: 'manual' };

describe('#115 — resolución de parámetros de costeo', () => {
  beforeEach(() => {
    recordTraceAudit.mockClear();
    withTenant.mockClear();
  });

  it('sin filas cargadas, resuelve al default del catálogo con origen "default"', async () => {
    const db = makeDb();
    const r = await service(db).resolver(USER, 'comp-1', 'vida_util_lote_meses');

    expect(r).toMatchObject({ valor: 24, origen: 'default', confirmado: false });
  });

  it('con una fila a nivel empresa, la usa antes que el default', async () => {
    const db = makeDb({
      parametroCosteo: {
        findMany: vi.fn(async () => [
          {
            clave: 'vida_util_lote_meses',
            valorNum: 18,
            periodId: null,
            structureId: null,
            confirmado: true,
          },
        ]),
      },
    });
    const r = await service(db).resolver(USER, 'comp-1', 'vida_util_lote_meses');

    expect(r).toMatchObject({ valor: 18, origen: 'empresa', confirmado: true });
  });

  it('un parámetro que no existe en el catálogo tira NotFoundError', async () => {
    const db = makeDb();
    await expect(service(db).resolver(USER, 'comp-1', 'no_existe')).rejects.toThrow(NotFoundError);
  });

  it('una empresa de otro usuario no existe para éste', async () => {
    const db = makeDb({ company: { findFirst: vi.fn(async () => null) } });
    await expect(
      service(db).resolver(USER, 'comp-ajena', 'vida_util_lote_meses'),
    ).rejects.toThrow(NotFoundError);
  });

  it('`listar` resuelve las 10 claves del catálogo avícola', async () => {
    const db = makeDb();
    const r = await service(db).listar(USER, 'comp-1');
    expect(r).toHaveLength(10);
    expect(r.map((p) => p.clave)).toContain('umbral_merma_normal_pct');
    expect(r.map((p) => p.clave)).toContain('umbral_variacion_punto_equilibrio_pct');
    expect(r.map((p) => p.clave)).toContain('vida_util_producto_dias');
  });

  describe('set', () => {
    it('crea una fila nueva cuando no hay una previa en ese nivel', async () => {
      const db = makeDb();
      const r = await service(db).set(
        USER,
        'comp-1',
        'vida_util_lote_meses',
        { valor: 20, confirmado: false },
        ACTOR,
      );
      expect(r).toMatchObject({ clave: 'vida_util_lote_meses', valorNum: 20, confirmado: false });
      const create = (db.parametroCosteo as { create: ReturnType<typeof vi.fn> }).create;
      expect(create).toHaveBeenCalledTimes(1);
    });

    it('actualiza la fila existente en vez de duplicarla', async () => {
      const db = makeDb({
        parametroCosteo: {
          findFirst: vi.fn(async () => ({ id: 'pc-1', valorNum: 18 })),
          update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
            id: 'pc-1',
            ...data,
          })),
        },
      });
      await service(db).set(USER, 'comp-1', 'vida_util_lote_meses', { valor: 22, confirmado: true }, ACTOR);

      const update = (db.parametroCosteo as { update: ReturnType<typeof vi.fn> }).update;
      const create = (db.parametroCosteo as { create?: ReturnType<typeof vi.fn> }).create;
      expect(update).toHaveBeenCalledTimes(1);
      expect(create).toBeUndefined();
    });

    it('rechaza una clave que no existe en el catálogo', async () => {
      const db = makeDb();
      await expect(
        service(db).set(USER, 'comp-1', 'no_existe', { valor: 1, confirmado: true }, ACTOR),
      ).rejects.toThrow(UnprocessableEntityError);
    });

    it('rechaza una estructura que no pertenece a la empresa', async () => {
      const db = makeDb({ costStructure: { findFirst: vi.fn(async () => null) } });
      await expect(
        service(db).set(
          USER,
          'comp-1',
          'vida_util_lote_meses',
          { valor: 20, confirmado: false, structureId: 'est-ajena' },
          ACTOR,
        ),
      ).rejects.toThrow(NotFoundError);
    });

    it('DOM-02: la bitácora se escribe en la MISMA transacción que la mutación', async () => {
      const db = makeDb();
      await service(db).set(
        USER,
        'comp-1',
        'umbral_merma_normal_pct',
        { valor: 2, confirmado: true },
        ACTOR,
      );

      expect(withTenant).toHaveBeenCalledTimes(1);
      expect(recordTraceAudit).toHaveBeenCalledTimes(1);
      const [entry, tx] = recordTraceAudit.mock.calls[0] as unknown as [
        { entityType: string; action: string; comment: string },
        unknown,
      ];
      expect(entry.entityType).toBe('ParametroCosteo');
      expect(entry.action).toBe('create');
      expect(entry.comment).toContain('confirmado');
      expect(tx).toBe(dbActual);
    });

    it('deja explícito en la bitácora cuando un valor se carga SIN confirmar (REV-03)', async () => {
      const db = makeDb();
      await service(db).set(
        USER,
        'comp-1',
        'vida_util_lote_meses',
        { valor: 20, confirmado: false },
        ACTOR,
      );

      const [entry] = recordTraceAudit.mock.calls[0] as unknown as [{ comment: string }];
      expect(entry.comment).toContain('sin confirmar');
    });
  });

  describe('delete', () => {
    it('borra un override aunque tenga el mismo número que el default y vuelve a origen default', async () => {
      const db = makeDb({
        parametroCosteo: {
          findMany: vi.fn(async () => []),
          findFirst: vi.fn(async () => ({
            id: 'pc-1',
            clave: 'vida_util_lote_meses',
            valorNum: 24,
            structureId: null,
            periodId: null,
          })),
          update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'pc-1', ...data })),
        },
      });
      const r = await service(db).delete(USER, 'comp-1', 'vida_util_lote_meses', {}, ACTOR);

      expect(r).toMatchObject({ valor: 24, origen: 'default', valorDefault: 24 });
      expect((db.parametroCosteo as { update: ReturnType<typeof vi.fn> }).update).toHaveBeenCalledTimes(1);
      expect(recordTraceAudit).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'delete', entityType: 'ParametroCosteo' }),
        dbActual,
      );
    });

    it('es idempotente cuando no hay override vigente', async () => {
      const db = makeDb();
      const r = await service(db).delete(USER, 'comp-1', 'vida_util_lote_meses', {}, ACTOR);

      expect(r.origen).toBe('default');
      expect((db.parametroCosteo as { update: ReturnType<typeof vi.fn> }).update).not.toHaveBeenCalled();
      expect(recordTraceAudit).not.toHaveBeenCalled();
    });
  });
});
