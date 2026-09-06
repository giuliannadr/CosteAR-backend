import type { PrismaClient, Prisma } from '@prisma/client';
import { prisma, withTenant } from '../../infrastructure/database/prisma.js';
import { recordTraceAudit, type TraceActor } from '../audit/trace-audit.js';
import { NotFoundError, UnprocessableEntityError } from '../../domain/errors/domain-error.js';
import {
  PARAMETROS_AVICOLA,
  definicionDe,
  definicionComportamientoDe,
  resolverParametro,
  resolverComportamiento,
  type ValorResuelto,
  type FilaParametro,
} from '../../domain/parametros/parametros-costeo.js';
import type { SetParametroCosteoInput } from '../../shared/schemas/parametros-costeo.schema.js';

/**
 * PARÁMETROS DE COSTEO — el servicio que le faltaba al catálogo (issue #115).
 *
 * `src/domain/parametros/parametros-costeo.ts` tiene el catálogo y la cascada
 * de resolución hace tiempo: tabla, migración y RLS están, y nadie los leía ni
 * escribía. Este servicio es el cable. Bloqueaba a #92 (desperdicio) y a #116
 * (amortización del plantel), que necesitan `umbral_merma_normal_pct` y
 * `vida_util_lote_meses` respectivamente y hoy no tienen de dónde sacarlos.
 *
 * Reglas del repo que aplican: los registros se borran LÓGICAMENTE (DOM-01),
 * toda mutación deja su entrada de bitácora en la MISMA transacción (DOM-02),
 * los timestamps son del servidor (DOM-03) y el aislamiento entre empresas lo
 * garantiza RLS vía `withTenant` (DOM-07).
 */
export class ParametrosCosteoService {
  constructor(private readonly db: PrismaClient = prisma) {}

  /** Verifica que la empresa exista y sea de quien la pide. */
  private async companyDe(userId: string, companyId: string) {
    const company = await this.db.company.findFirst({ where: { id: companyId, userId } });
    if (!company) throw new NotFoundError('Empresa no encontrada');
    return company;
  }

  /**
   * Si se pasa `structureId` o `periodId`, verifica que pertenezcan a la
   * empresa. Sin este chequeo, alguien podría leer o escribir un parámetro
   * "de" una estructura ajena solo adivinando su id.
   */
  private async validarAlcance(
    companyId: string,
    ctx: { structureId?: string | null; periodId?: string | null },
  ): Promise<void> {
    if (ctx.structureId) {
      const est = await this.db.costStructure.findFirst({
        where: { id: ctx.structureId, companyId },
      });
      if (!est) throw new NotFoundError('Estructura de costos no encontrada');
    }
    if (ctx.periodId) {
      const per = await this.db.costPeriod.findFirst({ where: { id: ctx.periodId, companyId } });
      if (!per) throw new NotFoundError('Período no encontrado');
    }
  }

  /** Todas las filas cargadas de una empresa, en la forma que consume `resolverParametro`. */
  private async filasDe(companyId: string): Promise<FilaParametro[]> {
    const filas = await this.db.parametroCosteo.findMany({
      where: { companyId, deletedAt: null },
    });
    return filas.map((f) => ({
      clave: f.clave,
      valorNum: f.valorNum === null ? null : Number(f.valorNum),
      periodId: f.periodId,
      structureId: f.structureId,
      confirmado: f.confirmado,
    }));
  }

  private async filasComportamientoDe(companyId: string) {
    return this.db.parametroCosteo.findMany({
      where: { companyId, deletedAt: null },
      select: {
        clave: true,
        comportamientoVolumen: true,
        periodId: true,
        structureId: true,
        confirmado: true,
        clasificadoPorUserId: true,
        clasificadoEn: true,
      },
    });
  }

  /**
   * Resuelve un parámetro puntual con la cascada período → estructura → empresa
   * → default del catálogo. El resultado dice de qué nivel salió (`origen`) y
   * si alguien lo confirmó — un default no confirmado no es un dato.
   */
  async resolver(
    userId: string,
    companyId: string,
    clave: string,
    ctx: { structureId?: string | null; periodId?: string | null } = {},
  ): Promise<ValorResuelto | ReturnType<typeof resolverComportamiento>> {
    const definicion = definicionDe(clave);
    const definicionComportamiento = definicionComportamientoDe(clave);
    if (!definicion && !definicionComportamiento) {
      throw new NotFoundError(`No existe el parámetro de costeo "${clave}"`);
    }
    await this.companyDe(userId, companyId);
    await this.validarAlcance(companyId, ctx);
    if (definicionComportamiento) {
      return resolverComportamiento(clave, await this.filasComportamientoDe(companyId), ctx);
    }
    return resolverParametro(clave, await this.filasDe(companyId), ctx);
  }

  /**
   * Todo el catálogo, resuelto para una empresa. Es lo que ve el costista: para
   * cada clave, el valor vigente y si lo puso el sistema o lo confirmó el
   * cliente.
   */
  async listar(
    userId: string,
    companyId: string,
    ctx: { structureId?: string | null; periodId?: string | null } = {},
  ): Promise<ValorResuelto[]> {
    await this.companyDe(userId, companyId);
    await this.validarAlcance(companyId, ctx);
    const filas = await this.filasDe(companyId);
    return PARAMETROS_AVICOLA.map((def) => resolverParametro(def.clave, filas, ctx));
  }

  /**
   * Carga o actualiza el valor de un parámetro en el nivel que se indique
   * (empresa por default; estructura o período si se pasan). `confirmado` lo
   * decide quien llama: cargar un valor para poder avanzar NO es lo mismo que
   * el cliente confirmándolo (REV-03), y el resultado tiene que poder decir
   * cuál de las dos cosas fue.
   */
  async set(
    userId: string,
    companyId: string,
    clave: string,
    input: SetParametroCosteoInput,
    actor: TraceActor,
  ) {
    const definicion = definicionDe(clave);
    const definicionComportamiento = definicionComportamientoDe(clave);
    if (!definicion && !definicionComportamiento) {
      throw new UnprocessableEntityError(`No existe el parámetro de costeo "${clave}"`, {
        field: 'clave',
      });
    }
    await this.companyDe(userId, companyId);
    const structureId = input.structureId ?? null;
    const periodId = input.periodId ?? null;
    await this.validarAlcance(companyId, { structureId, periodId });

    if (definicion && input.valor === undefined) {
      throw new UnprocessableEntityError(`El parámetro "${clave}" requiere un valor numérico.`, { field: 'valor' });
    }
    if (definicionComportamiento && input.comportamientoVolumen === undefined) {
      throw new UnprocessableEntityError(
        `La clasificación "${clave}" requiere un comportamiento frente al volumen.`,
        { field: 'comportamientoVolumen' },
      );
    }

    return withTenant(userId, async (tx) => {
      const existente = await tx.parametroCosteo.findFirst({
        where: { companyId, structureId, periodId, clave, deletedAt: null },
      });

      const esComportamiento = Boolean(definicionComportamiento);
      const clasificacion = input.comportamientoVolumen;
      const data: Prisma.ParametroCosteoUncheckedCreateInput = {
        companyId,
        userId,
        structureId,
        periodId,
        clave,
        valorNum: esComportamiento ? null : input.valor!,
        confirmado: input.confirmado,
        descripcion: definicionComportamiento?.descripcion ?? definicion!.descripcion,
        comportamientoVolumen: clasificacion ?? null,
        // Proponer no es confirmar: la semilla no atribuye una decisión a una
        // persona. Una edición explícita sí deja el autor y reloj del servidor.
        clasificadoPorUserId: esComportamiento ? actor.id : null,
        clasificadoEn: esComportamiento ? new Date() : null,
      };

      const guardado = existente
        ? await tx.parametroCosteo.update({ where: { id: existente.id }, data })
        : await tx.parametroCosteo.create({ data });

      // DOM-02: la bitácora va en la MISMA transacción. Si falla, no queda un
      // valor de negocio cambiado sin rastro de quién lo cargó.
      await recordTraceAudit(
        {
          entityType: 'ParametroCosteo',
          entityId: guardado.id,
          action: existente ? 'update' : 'create',
          actor,
          before: existente ?? undefined,
          after: guardado,
          comment: esComportamiento
            ? `Clasificación "${clave}" ${input.confirmado ? 'confirmada' : 'cargada sin confirmar'}: ${clasificacion}`
            : `Parámetro "${clave}" ${input.confirmado ? 'confirmado' : 'cargado sin confirmar'}: ${input.valor}`,
        },
        tx,
      );

      return guardado;
    });
  }

  /**
   * Borra sólo el override del nivel solicitado. La ausencia es idempotente:
   * la cascada ya resolvía desde arriba y no hay una decisión que auditar.
   */
  async delete(
    userId: string,
    companyId: string,
    clave: string,
    ctx: { structureId?: string | null; periodId?: string | null } = {},
    actor: TraceActor,
  ) {
    const definicion = definicionDe(clave);
    const definicionComportamiento = definicionComportamientoDe(clave);
    if (!definicion && !definicionComportamiento) {
      throw new NotFoundError(`No existe el parámetro de costeo "${clave}"`);
    }
    await this.companyDe(userId, companyId);
    await this.validarAlcance(companyId, ctx);

    await withTenant(userId, async (tx) => {
      const existente = await tx.parametroCosteo.findFirst({
        where: {
          companyId,
          structureId: ctx.structureId ?? null,
          periodId: ctx.periodId ?? null,
          clave,
          deletedAt: null,
        },
      });
      if (!existente) return;

      const eliminado = await tx.parametroCosteo.update({
        where: { id: existente.id },
        data: { deletedAt: new Date() },
      });
      await recordTraceAudit(
        {
          entityType: 'ParametroCosteo',
          entityId: existente.id,
          action: 'delete',
          actor,
          before: existente,
          after: eliminado,
          comment: `Override del parámetro "${clave}" eliminado; vuelve a resolverse por cascada.`,
        },
        tx,
      );
    });

    return this.resolver(userId, companyId, clave, ctx);
  }
}
