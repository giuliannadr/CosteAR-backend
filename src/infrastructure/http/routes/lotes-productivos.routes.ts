import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { LotesProductivosService } from '../../../application/operacion/lotes-productivos-service.js';
import { authenticate } from '../plugins/authenticate.js';

const companyParams = z.object({ companyId: z.string().uuid() });
const unitParams = z.object({ unidadId: z.string().uuid() });
const listQuery = z.object({ unidadProductivaId: z.string().uuid().optional() });

export async function registerLotesProductivosRoutes(app: FastifyInstance): Promise<void> {
  const service = new LotesProductivosService();
  app.get('/companies/:companyId/unidades-productivas', { preHandler: authenticate }, async (request) => {
    const { companyId } = companyParams.parse(request.params);
    return { data: await service.listUnidades(request.authUser!.id, companyId) };
  });
  app.get('/companies/:companyId/lotes-productivos', { preHandler: authenticate }, async (request) => {
    const { companyId } = companyParams.parse(request.params);
    const { unidadProductivaId } = listQuery.parse(request.query);
    return { data: await service.listLotes(request.authUser!.id, companyId, unidadProductivaId) };
  });
  // Devuelve todos: el modelo permite mas de un activo y no se elige uno en silencio.
  app.get('/unidades-productivas/:unidadId/lotes-activos', { preHandler: authenticate }, async (request) => {
    const { unidadId } = unitParams.parse(request.params);
    return { data: await service.listActivosDeUnidad(request.authUser!.id, unidadId) };
  });
}
