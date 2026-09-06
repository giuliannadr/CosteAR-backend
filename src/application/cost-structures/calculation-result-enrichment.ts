import type { PrismaClient } from '@prisma/client';
import type { CalculationInput, CalculationOutput } from '../../domain/calculations/calculate.js';
import {
  calcularContribucionMarginal,
  CLAVES_COMPORTAMIENTO_CONTRIBUCION,
  type ContribucionMarginal,
  type FilaComportamiento,
} from '../../domain/calculations/contribucion-marginal.js';
import { calcularPuntoEquilibrio, type PuntoEquilibrio } from '../../domain/calculations/punto-equilibrio.js';

/** Resultado de incompletitud reutilizable entre caminos de cálculo. */
export interface Incompletitud {
  incompleto: boolean;
  motivos: string[];
  datosPendientes: { id: string; nombre: string }[];
}

/** Arma la marca sin exponer ids ni rutas internas en el motivo legible. */
export function buildIncompletitud(pending: { id: string; label: string }[]): Incompletitud {
  if (pending.length === 0) return { incompleto: false, motivos: [], datosPendientes: [] };

  const datosPendientes = pending.map((d) => ({ id: d.id, nombre: d.label }));
  const nombres = datosPendientes.map((d) => `"${d.nombre}"`).join(', ');
  return {
    incompleto: true,
    motivos: [
      `Hay ${pending.length} dato(s) sin decisión de imputación de período (${nombres}). ` +
        'El costo puede estar dejándolos afuera o mezclando datos de otro mes, así que este ' +
        'resultado todavía no es confiable. Resolvé la imputación desde la ficha de cada dato ' +
        'antes de dar el costo por bueno.',
    ],
    datosPendientes,
  };
}

export interface EnrichedCalculationResult {
  results: CalculationOutput & {
    incompletitud: Incompletitud;
    contribucionMarginal: ContribucionMarginal;
    puntoEquilibrio: PuntoEquilibrio;
  };
  incompletitud: Incompletitud;
  periodId: string | null;
}

/**
 * Agrega las vistas que dependen de datos persistidos al resultado puro del
 * motor. Corrida y simulación pasan por acá para que no puedan resolver una
 * clasificación, una incompletitud o un punto de equilibrio de forma distinta.
 */
export async function enrichCalculationResult(
  db: PrismaClient,
  args: {
    structureId: string;
    companyId: string | null;
    input: CalculationInput;
    output: CalculationOutput;
  },
): Promise<EnrichedCalculationResult> {
  const [pending, openPeriod] = await Promise.all([
    db.dataPoint.findMany({
      where: {
        structureId: args.structureId,
        periodoImputado: null,
        voidedAt: null,
        status: { not: 'anulado' },
      },
      select: { id: true, label: true },
      take: 20,
    }),
    db.costPeriod.findFirst({
      where: { structureId: args.structureId, status: 'OPEN', deletedAt: null },
      select: { id: true },
    }),
  ]);
  const incompletitud = buildIncompletitud(pending);
  const periodId = openPeriod?.id ?? null;

  // Sin empresa sólo existen mocks históricos: no se consulta un tenant
  // inexistente y la contribución informa las clasificaciones faltantes.
  const clavesComportamiento = Object.values(CLAVES_COMPORTAMIENTO_CONTRIBUCION);
  const clasificaciones: FilaComportamiento[] = args.companyId
    ? await db.parametroCosteo.findMany({
        where: { companyId: args.companyId, clave: { in: clavesComportamiento }, deletedAt: null },
        select: {
          id: true,
          clave: true,
          comportamientoVolumen: true,
          structureId: true,
          periodId: true,
          clasificadoPorUserId: true,
          clasificadoEn: true,
        },
      })
    : [];
  const contribucionMarginal = calcularContribucionMarginal({
    precioUnitario: args.input.sales.unitPrice,
    unidadesVendidas: args.input.sales.quantity,
    componentes: [
      {
        clave: CLAVES_COMPORTAMIENTO_CONTRIBUCION.materiaPrima,
        etiqueta: 'Materia prima',
        importeAbsorcion: args.output.rawMaterialConsumed,
      },
      {
        clave: CLAVES_COMPORTAMIENTO_CONTRIBUCION.manoObraDirecta,
        etiqueta: 'Mano de obra directa',
        importeAbsorcion: args.output.directLaborTotal,
      },
      {
        clave: CLAVES_COMPORTAMIENTO_CONTRIBUCION.costosIndirectos,
        etiqueta: 'Costos indirectos de producción',
        importeAbsorcion: args.output.indirectCostsApplied,
      },
    ],
    clasificaciones,
    contexto: { structureId: args.structureId, periodId },
  });
  const puntoEquilibrio = calcularPuntoEquilibrio(contribucionMarginal, new Date());

  return {
    results: { ...args.output, incompletitud, contribucionMarginal, puntoEquilibrio },
    incompletitud,
    periodId,
  };
}
