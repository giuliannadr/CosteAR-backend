import type { PrismaClient } from '@prisma/client';
import { prisma, withTenant } from '../../infrastructure/database/prisma.js';

/**
 * Registro de auditoría (append-only). Toda acción sensible — login,
 * cambios de datos financieros, cambios de cuenta — deja una huella inmutable
 * con quién, qué, cuándo y desde dónde.
 */

export interface AuditContext {
  userId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface AuditEntry extends AuditContext {
  action: string;
  entityType?: string;
  entityId?: string;
  oldValue?: unknown;
  newValue?: unknown;
}

export async function recordAudit(
  entry: AuditEntry,
  client: Pick<PrismaClient, 'auditLog'> = prisma,
): Promise<void> {
  const data = {
    userId: entry.userId ?? null,
    action: entry.action,
    entityType: entry.entityType ?? null,
    entityId: entry.entityId ?? null,
    oldValue: entry.oldValue === undefined ? undefined : (entry.oldValue as object),
    newValue: entry.newValue === undefined ? undefined : (entry.newValue as object),
    ipAddress: entry.ipAddress ?? null,
    userAgent: entry.userAgent ?? null,
  };

  // Las rutas de autenticacion todavia no tienen un pre-handler que cargue el
  // tenant, pero sus auditorias si pertenecen a un usuario. La transaccion
  // explicita mantiene el SET LOCAL y el RETURNING de Prisma en la misma
  // conexion, sin abrir una via privilegiada para datos de otra cuenta.
  if (entry.userId && client === prisma) {
    await withTenant(entry.userId, async (tx) => {
      await tx.auditLog.create({ data });
    });
    return;
  }
  await client.auditLog.create({ data });
}
