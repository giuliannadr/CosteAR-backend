import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ParametrosCosteoService } from '../../../application/parametros/parametros-costeo-service.js';
import { authenticate } from '../plugins/authenticate.js';
import { setParametroCosteoSchema } from '../../../shared/schemas/parametros-costeo.schema.js';

/**
 * PARÁMETROS DE COSTEO (issue #115).
 *
 * Por acá entra y sale el catálogo que hasta ahora nadie leía ni escribía: los
 * defaults del vertical avícola, resueltos en cascada período → estructura →
 * empresa → default, con el origen del valor a la vista.
 */

const companyParams = z.object({ companyId: z.string().uuid() });
const claveParams = z.object({ companyId: z.string().uuid(), clave: z.string().min(1) });
const alcanceQuery = z.object({
  structureId: z.string().uuid().optional(),
  periodId: z.string().uuid().optional(),
});

/** Actor de trazabilidad: rol del JWT, área fija (el costista carga esto), dispositivo. */
function actorFrom(request: FastifyRequest) {
  const ua = request.headers['user-agent'] ?? 'desconocido';
  return {
    id: request.authUser!.id,
    role: request.authUser!.role,
    jobTitle: request.authUser!.jobTitle,
    area: 'costista',
    method: 'manual',
    device: `${ua} · ${request.ip}`,
  };
}

export async function registerParametrosCosteoRoutes(app: FastifyInstance): Promise<void> {
  const service = new ParametrosCosteoService();

  app.get(
    '/companies/:companyId/parametros-costeo',
    { preHandler: authenticate },
    async (request) => {
      const { companyId } = companyParams.parse(request.params);
      const { structureId, periodId } = alcanceQuery.parse(request.query);
      const data = await service.listar(request.authUser!.id, companyId, {
        structureId,
        periodId,
      });
      return { data };
    },
  );

  app.get(
    '/companies/:companyId/parametros-costeo/:clave',
    { preHandler: authenticate },
    async (request) => {
      const { companyId, clave } = claveParams.parse(request.params);
      const { structureId, periodId } = alcanceQuery.parse(request.query);
      const data = await service.resolver(request.authUser!.id, companyId, clave, {
        structureId,
        periodId,
      });
      return { data };
    },
  );

  app.put(
    '/companies/:companyId/parametros-costeo/:clave',
    { preHandler: authenticate },
    async (request) => {
      const { companyId, clave } = claveParams.parse(request.params);
      const body = setParametroCosteoSchema.parse(request.body);
      const data = await service.set(
        request.authUser!.id,
        companyId,
        clave,
        body,
        actorFrom(request),
      );
      return { data };
    },
  );

  app.delete(
    '/companies/:companyId/parametros-costeo/:clave',
    { preHandler: authenticate },
    async (request) => {
      const { companyId, clave } = claveParams.parse(request.params);
      const { structureId, periodId } = alcanceQuery.parse(request.query);
      const data = await service.delete(
        request.authUser!.id,
        companyId,
        clave,
        { structureId, periodId },
        actorFrom(request),
      );
      return { data };
    },
  );
}
