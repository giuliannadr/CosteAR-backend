import type { PrismaClient } from '@prisma/client';
import { prisma, withTenant } from '../../infrastructure/database/prisma.js';
import { NotFoundError } from '../../domain/errors/domain-error.js';

type ParametroSinConfirmar = {
  id: string;
  nombre: string;
};

type NumeroTablero = {
  valor: number | null;
  completo: boolean;
  parametrosSinConfirmar: boolean;
  parametrosSinConfirmarDetalle: ParametroSinConfirmar[];
  motivos: string[];
};

type AreaPendienteCierre = 'calculo' | 'imputacion' | 'configuracion' | 'produccion' | 'ventas' | 'costeo';

type PendienteCierre = {
  area: AreaPendienteCierre;
  dato: string;
  periodo: { id: string; codigo: string };
};

type FuentePendiente = Omit<PendienteCierre, 'periodo'>;

type ResultadoCorrida = {
  grossMargin?: number;
  incompletitud?: { incompleto?: boolean; motivos?: string[]; datosPendientes?: Array<{ id: string; nombre: string }> };
  detail?: { unitCost?: { unitFinishedGoodsCost?: number; basadoEn?: 'producidas' | 'vendidas' } };
  contribucionMarginal?: {
    incompleta: boolean;
    precioUnitario: number;
    unidadesVendidas: number;
    costoVariableUnitario: number | null;
    contribucionMarginalUnitaria: number | null;
    componentes: Array<{ etiqueta: string; importeAbsorcion: number; comportamientoVolumen: string | null; parametroId: string | null }>;
    motivos?: string[];
  };
  puntoEquilibrio?: {
    incompleta: boolean;
    unidadesEquilibrio: number | null;
    fechaUltimoRecalculo: string;
    motivos?: string[];
    motivoSinEquilibrio?: string;
  };
};

// Varios indicadores pueden depender del mismo dato; el tablero ofrece la acción una sola vez.
const pendientesUnicos = (
  periodo: { id: string; codigo: string },
  fuentes: FuentePendiente[],
): PendienteCierre[] => {
  const vistos = new Set<string>();
  return fuentes.flatMap((fuente) => {
    const clave = `${fuente.area}:${fuente.dato}`;
    if (vistos.has(clave)) return [];
    vistos.add(clave);
    return [{ ...fuente, periodo }];
  });
};

const incompleto = (motivos: string[], parametrosSinConfirmarDetalle: ParametroSinConfirmar[] = []): NumeroTablero => ({
  valor: null,
  completo: false,
  parametrosSinConfirmar: parametrosSinConfirmarDetalle.length > 0,
  parametrosSinConfirmarDetalle,
  motivos,
});

const completo = (valor: number, parametrosSinConfirmarDetalle: ParametroSinConfirmar[] = [], motivos: string[] = []): NumeroTablero => ({
  valor,
  completo: motivos.length === 0,
  parametrosSinConfirmar: parametrosSinConfirmarDetalle.length > 0,
  parametrosSinConfirmarDetalle,
  motivos,
});

/**
 * Compone los seis indicadores del tablero sin recalcularlos. Lee una foto de
 * CalculationRun del período y transforma solamente las unidades internas a la
 * unidad de venta configurada (`cajon`).
 */
export class OwnerDashboardService {
  constructor(private readonly db: PrismaClient = prisma) {}

  async get(userId: string, periodId: string) {
    const period = await withTenant(userId, (tx) => tx.costPeriod.findFirst({
      where: { id: periodId, userId, deletedAt: null },
      select: { id: true, code: true, companyId: true, productionQuantity: true, salesQuantity: true },
    }));
    if (!period) throw new NotFoundError('Período de costos no encontrado');

    const [run, unidadVenta] = await Promise.all([
      withTenant(userId, (tx) => tx.calculationRun.findFirst({
        where: { periodId }, orderBy: [{ validated: 'desc' }, { executedAt: 'desc' }],
        select: { id: true, validated: true, executedAt: true, results: true },
      })),
      withTenant(userId, (tx) => tx.unidadMedida.findFirst({
        where: { companyId: period.companyId, codigo: 'cajon', deletedAt: null },
        select: { factor: true },
      })),
    ]);

    const sinCorrida = ['No hay una corrida de cálculo para este período.'];
    if (!run) {
      const falta = incompleto(sinCorrida);
      const periodo = { id: period.id, codigo: period.code };
      return {
        periodo, corrida: null,
        pendientes: pendientesUnicos(periodo, [{ area: 'calculo', dato: 'corrida de cálculo' }]),
        costoPorCajon: { variable: falta, fijo: falta, total: falta },
        precioPromedioVenta: falta, contribucionMarginalPorCajon: falta,
        puntoEquilibrioCajones: { ...falta, fechaUltimoRecalculo: null },
        producidoCajones: falta, resultadoPeriodo: falta,
      };
    }

    const resultado = run.results as ResultadoCorrida;
    const periodo = { id: period.id, codigo: period.code };
    const contribucion = resultado.contribucionMarginal;
    const equilibrio = resultado.puntoEquilibrio;
    const unidadesEquilibrio = equilibrio?.unidadesEquilibrio ?? null;
    const factor = unidadVenta ? Number(unidadVenta.factor) : null;
    const motivosBase = resultado.incompletitud?.incompleto ? (resultado.incompletitud.motivos ?? []) : [];
    const datosPendientesBase = resultado.incompletitud?.datosPendientes ?? [];
    const idsParametros = contribucion?.componentes.map((c) => c.parametroId).filter((id): id is string => id !== null) ?? [];
    const parametrosSinConfirmar = idsParametros.length > 0
      ? await withTenant(userId, async (tx) => (await tx.parametroCosteo.findMany({
          where: { id: { in: idsParametros }, confirmado: false, deletedAt: null },
          select: { id: true, clave: true, descripcion: true },
          orderBy: [{ clave: 'asc' }, { id: 'asc' }],
        })).map((parametro) => ({
          id: parametro.id,
          nombre: parametro.descripcion?.trim() || parametro.clave,
        })))
      : [];
    const sinUnidad = factor === null ? ['Falta configurar la unidad de venta "cajon" con su factor de conversión.'] : [];
    const baseUnidades = Number(period.productionQuantity ?? 0);
    const sinProduccion = baseUnidades <= 0 ? ['Falta cargar una cantidad producida mayor a cero para el período.'] : [];
    const sinVentas = !contribucion || contribucion.unidadesVendidas <= 0
      ? ['Falta cargar ventas del período para obtener este indicador.']
      : [];
    const pendientesBase = datosPendientesBase.length > 0
      ? datosPendientesBase.map(({ nombre }) => ({ area: 'imputacion' as const, dato: nombre }))
      : motivosBase.map((motivo) => ({ area: 'imputacion' as const, dato: motivo }));
    const pendientesClasificacion = contribucion?.componentes.flatMap((componente) => {
      if (componente.comportamientoVolumen === null) {
        return [{ area: 'costeo' as const, dato: `clasificación frente al volumen del rubro ${componente.etiqueta}` }];
      }
      if (componente.comportamientoVolumen === 'SEMIFIJO') {
        return [{ area: 'costeo' as const, dato: `tramo variable del rubro ${componente.etiqueta}` }];
      }
      return [];
    }) ?? [];
    const pendientes = pendientesUnicos(periodo, [
      ...pendientesBase,
      ...(factor === null ? [{ area: 'configuracion' as const, dato: 'unidad de venta "cajon" con factor de conversión' }] : []),
      ...(baseUnidades <= 0 ? [{ area: 'produccion' as const, dato: 'cantidad producida mayor a cero' }] : []),
      ...(sinVentas.length > 0 ? [{ area: 'ventas' as const, dato: 'ventas del período' }] : []),
      ...pendientesClasificacion,
      ...(equilibrio?.motivoSinEquilibrio ? [{ area: 'costeo' as const, dato: 'contribución marginal unitaria positiva' }] : []),
      ...(!contribucion || resultado.detail?.unitCost?.unitFinishedGoodsCost == null
        ? [{ area: 'costeo' as const, dato: 'resultado de costos de la corrida' }]
        : []),
    ]);
    const costosBase = [...motivosBase, ...sinUnidad, ...sinProduccion];
    const costos = !contribucion || factor === null || baseUnidades <= 0 || resultado.detail?.unitCost?.unitFinishedGoodsCost == null
      ? { variable: incompleto(costosBase.length > 0 ? costosBase : ['Falta el resultado de costos de la corrida.'], parametrosSinConfirmar), fijo: incompleto(costosBase.length > 0 ? costosBase : ['Falta el resultado de costos de la corrida.'], parametrosSinConfirmar), total: incompleto(costosBase.length > 0 ? costosBase : ['Falta el resultado de costos de la corrida.'], parametrosSinConfirmar) }
      : {
          variable: contribucion.costoVariableUnitario === null
            ? incompleto([...motivosBase, ...(contribucion.motivos ?? [])], parametrosSinConfirmar)
            : completo(contribucion.costoVariableUnitario * factor, parametrosSinConfirmar, motivosBase),
          fijo: completo(
            contribucion.componentes.filter((c) => c.comportamientoVolumen === 'FIJO').reduce((sum, c) => sum + c.importeAbsorcion, 0) / baseUnidades * factor,
            parametrosSinConfirmar,
            motivosBase,
          ),
          total: completo(resultado.detail.unitCost.unitFinishedGoodsCost * factor, parametrosSinConfirmar, motivosBase),
        };

    const convertido = (numero: number | null, motivos: string[]): NumeroTablero =>
      numero === null || factor === null || motivos.length > 0
        ? incompleto([...motivos, ...sinUnidad], parametrosSinConfirmar)
        : completo(numero * factor, parametrosSinConfirmar);

    return {
      periodo,
      corrida: { id: run.id, validada: run.validated, ejecutadaEn: run.executedAt.toISOString() },
      pendientes,
      costoPorCajon: costos,
      precioPromedioVenta: convertido(contribucion?.precioUnitario ?? null, [...motivosBase, ...sinVentas]),
      contribucionMarginalPorCajon: convertido(
        contribucion?.incompleta ? null : (contribucion?.contribucionMarginalUnitaria ?? null),
        [...motivosBase, ...sinVentas, ...(contribucion?.motivos ?? [])],
      ),
      puntoEquilibrioCajones: {
        ...(equilibrio?.incompleta || unidadesEquilibrio === null || factor === null
          ? incompleto([...motivosBase, ...(equilibrio?.motivos ?? []), ...(equilibrio?.motivoSinEquilibrio ? [equilibrio.motivoSinEquilibrio] : []), ...sinUnidad], parametrosSinConfirmar)
          : completo(unidadesEquilibrio / factor, parametrosSinConfirmar, motivosBase)),
        fechaUltimoRecalculo: equilibrio?.fechaUltimoRecalculo ?? null,
      },
      producidoCajones: factor === null || baseUnidades <= 0
        ? incompleto([...sinProduccion, ...sinUnidad])
        : completo(baseUnidades / factor),
      resultadoPeriodo: resultado.grossMargin == null || sinVentas.length > 0
        ? incompleto([...motivosBase, ...sinVentas], parametrosSinConfirmar)
        : completo(resultado.grossMargin, parametrosSinConfirmar, motivosBase),
    };
  }
}
