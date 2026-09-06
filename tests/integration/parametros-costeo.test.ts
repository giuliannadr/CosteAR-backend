import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ParametrosCosteoService } from '@/application/parametros/parametros-costeo-service.js';
import { withTenantContext } from '@/infrastructure/database/tenant-context.js';
import { createTenant, disconnect, db, type Tenant } from './helpers/tenants.js';

const actor = (userId: string) => ({ id: userId, role: 'COSTISTA', area: 'costista', method: 'manual' }) as const;

let A: Tenant;
let B: Tenant;

beforeAll(async () => {
  A = await createTenant('parametros-a');
  B = await createTenant('parametros-b');
});

afterAll(disconnect);

describe('contrato de parámetros: catálogo, cascada y aislamiento', () => {
  it('borra el override aunque coincida con el default y vuelve a origen default', async () => {
    const service = new ParametrosCosteoService(db);
    const clave = 'vida_util_lote_meses';

    const cargado = await withTenantContext(A.userId, () =>
      service.set(A.userId, A.companyId, clave, { valor: 24, confirmado: true }, actor(A.userId)),
    );
    expect(Number(cargado.valorNum)).toBe(24);

    const borrado = await withTenantContext(A.userId, () =>
      service.delete(A.userId, A.companyId, clave, {}, actor(A.userId)),
    );
    expect(borrado).toMatchObject({ valor: 24, valorDefault: 24, origen: 'default' });
  });

  it('no permite borrar ni leer el override de otra empresa', async () => {
    const service = new ParametrosCosteoService(db);
    const clave = 'vida_util_lote_meses';
    await withTenantContext(B.userId, () =>
      service.set(B.userId, B.companyId, clave, { valor: 19, confirmado: true }, actor(B.userId)),
    );

    await expect(
      withTenantContext(A.userId, () => service.delete(A.userId, B.companyId, clave, {}, actor(A.userId))),
    ).rejects.toThrow(/empresa no encontrada/i);
    await expect(
      withTenantContext(A.userId, () => service.resolver(A.userId, B.companyId, clave)),
    ).rejects.toThrow(/empresa no encontrada/i);
  });
});
