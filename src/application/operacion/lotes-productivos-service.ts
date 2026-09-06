import type { PrismaClient } from '@prisma/client';
import { prisma, withTenant } from '../../infrastructure/database/prisma.js';
import { NotFoundError } from '../../domain/errors/domain-error.js';

export class LotesProductivosService {
  constructor(private readonly db: PrismaClient = prisma) {}

  private async empresaDe(userId: string, companyId: string) {
    const company = await withTenant(userId, (tx) => tx.company.findFirst({ where: { id: companyId, userId, isActive: true } }));
    if (!company) throw new NotFoundError('Empresa no encontrada');
  }

  async listUnidades(userId: string, companyId: string) {
    await this.empresaDe(userId, companyId);
    return withTenant(userId, (tx) => tx.unidadProductiva.findMany({ where: { companyId, userId, deletedAt: null }, orderBy: { referencia: 'asc' } }));
  }

  async listLotes(userId: string, companyId: string, unidadProductivaId?: string) {
    await this.empresaDe(userId, companyId);
    return withTenant(userId, (tx) => tx.loteProductivo.findMany({
      where: { companyId, userId, deletedAt: null, ...(unidadProductivaId ? { unidadProductivaId } : {}) },
      include: { unidadProductiva: { select: { id: true, referencia: true, activa: true } } },
      orderBy: { referencia: 'asc' },
    }));
  }

  async listActivosDeUnidad(userId: string, unidadProductivaId: string) {
    return withTenant(userId, async (tx) => {
      const unit = await tx.unidadProductiva.findFirst({ where: { id: unidadProductivaId, userId, deletedAt: null } });
      if (!unit) throw new NotFoundError('Unidad productiva no encontrada');
      return tx.loteProductivo.findMany({
        where: { unidadProductivaId, userId, activo: true, deletedAt: null },
        include: { unidadProductiva: { select: { id: true, referencia: true, activa: true } } },
        orderBy: { referencia: 'asc' },
      });
    });
  }
}
