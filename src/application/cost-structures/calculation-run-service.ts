import type { PrismaClient } from '@prisma/client';
import { prisma, withTenant } from '../../infrastructure/database/prisma.js';
import { recordTraceAudit, type TraceActor } from '../audit/trace-audit.js';
import { NotFoundError } from '../../domain/errors/domain-error.js';
import { MissingInputError, CostingSystemNotAvailableError } from '../../domain/errors/calculation-errors.js';
import {
  rawMaterialSectionSchema,
  directLaborConfigSchema,
  indirectCostConfigSchema,
  inventorySchema,
} from '../../shared/schemas/cost.schema.js';
import { type CalculationInput } from '../../domain/calculations/calculate.js';
import { PuntoEquilibrioAlertService } from '../alerts/punto-equilibrio-alert-service.js';
import { type TreeNode } from './tree-builder.js';
import {
  MP_MOVEMENT_FIELD_KEYS,
  movementIdentity,
} from '../trazabilidad/orders-input-points.js';
import { selectCostingEngine } from './costing-engine.js';
import { persistCalculationRun, type RunTrigger } from './calculation-run-persistence.js';
import { validateCalculationInputs, toMissingInputError } from './validate-inputs.js';
import { enrichCalculationResult } from './calculation-result-enrichment.js';

/**
 * Marca de incompletitud de una corrida (F04). Contrato ADITIVO que consume el
 * frontend para decidir si pinta una advertencia en vez de un margen "sano".
 *
 * Se persiste dentro de `CalculationRun.results.incompletitud` (JSON, no rompe a
 * ningún consumidor que ya lee `results.grossMargin`, etc.) y se devuelve además
 * como `incompleto` en el nivel superior de la respuesta.
 *
 * Regla #7: `motivos` no lleva endpoints ni identificadores internos. El `id` de
 * cada dato pendiente es SOLO para que el front abra su ficha; lo que se muestra
 * es el `nombre` humano.
 */
export interface Incompletitud {
  /** true si el cálculo corrió con datos sin decisión de imputación de período. */
  incompleto: boolean;
  /** Motivos legibles para el costista (español, sin endpoints ni ids). */
  motivos: string[];
  /** Datos que faltan imputar: `id` para navegar a la ficha, `nombre` para mostrar. */
  datosPendientes: { id: string; nombre: string }[];
}

/**
 * Arma la marca de incompletitud a partir de los datos sin imputar. Sin datos
 * pendientes, `incompleto: false` (el resultado es confiable).
 */
export function buildIncompletitud(pending: { id: string; label: string }[]): Incompletitud {
  if (pending.length === 0) {
    return { incompleto: false, motivos: [], datosPendientes: [] };
  }
  const datosPendientes = pending.map((d) => ({ id: d.id, nombre: d.label }));
  const nombres = datosPendientes.map((d) => `"${d.nombre}"`).join(', ');
  const motivos = [
    `Hay ${pending.length} dato(s) sin decisión de imputación de período (${nombres}). ` +
      'El costo puede estar dejándolos afuera o mezclando datos de otro mes, así que este ' +
      'resultado todavía no es confiable. Resolvé la imputación desde la ficha de cada dato ' +
      'antes de dar el costo por bueno.',
  ];
  return { incompleto: true, motivos, datosPendientes };
}

/**
 * Bloques migrados por `scripts/backfill-trazabilidad.mjs`: un DataPoint por
 * sección entera. Son el origen de las CUATRO RAÍCES del árbol, en el mismo
 * orden en que `buildCalculationTree` las devuelve (MP, MOD, CIP, VENTA).
 */
const ROOT_FIELD_KEYS = ['mp.config', 'mod.config', 'cip.config', 'venta.config'];

/** Lo mínimo que hace falta de un DataPoint para enlazarlo a un nodo. */
export interface DataPointLinkSource {
  id: string;
  label: string;
  fieldKey: string;
  fechaHecho?: Date | null;
}

/** Lleva la cuenta de repeticiones de una misma identidad base. */
function nextOccurrence(counter: Map<string, number>, base: string): number {
  const n = counter.get(base) ?? 0;
  counter.set(base, n + 1);
  return n;
}

/**
 * ENLACE ENTRE EL ÁRBOL DE DERIVACIÓN Y LOS DATOS QUE LO ORIGINAN.
 *
 * Pura (no toca la base) para poder probarse al centavo: el servicio hace UNA
 * query y le pasa las filas. Anota `sourceDataPointId` en cada nodo que tenga
 * un dato detrás; no toca ningún valor calculado.
 *
 * Resuelve en este orden, y el primero que acierta gana:
 *
 *   a. `traceFieldKey` — DETERMINÍSTICO. Es la clave que emite el motor con la
 *      MISMA convención que el lado de escritura (`orders-input-points.ts`):
 *      la `fieldKey` textual del dato, salvo en los movimientos de MP, donde
 *      todos comparten una `fieldKey` legada y lo que identifica al dato es la
 *      `identity` de `movementIdentity()`.
 *   b. `fieldKey` fija de las 4 raíces (`mp.config`, ...). Las raíces son
 *      totales de sección: no tienen un insumo propio, las respalda el bloque
 *      migrado de la sección entera.
 *   c. `label` — FALLBACK, y SOLO para datos anteriores a T-01. Compara textos:
 *      basta con renombrar una etiqueta en el árbol o en el formulario para que
 *      el drill-down se desconecte ENTERO, en silencio, sin error ni test en
 *      rojo. Y no puede desempatar dos datos con la misma etiqueta (dos compras
 *      al mismo proveedor en el mismo mes): el índice se queda con el último y
 *      el primero apunta al dato equivocado. No se puede confiar en esto para
 *      datos nuevos — todo lo que se carga desde T-01 tiene `fieldKey` estable
 *      y resuelve por (a). Se conserva únicamente para no dejar ciegas las
 *      estructuras migradas antes de esa corrección.
 */
export function resolveDataPointLinks(tree: TreeNode[], existing: DataPointLinkSource[]): void {
  const byFieldKey = new Map<string, string>();
  const byLabel = new Map<string, string>();
  // Índice de los movimientos de MP por IDENTIDAD, replicando exactamente el
  // conteo de `datapoint-reconciler.ts`: (fieldKey, label, fecha, rol) + número
  // de repetición en orden de creación. Las identidades llevan '|', que ninguna
  // `fieldKey` usa, así que los dos índices no se pisan.
  const byMovementIdentity = new Map<string, string>();
  const counter = new Map<string, number>();

  for (const dp of existing) {
    byFieldKey.set(dp.fieldKey, dp.id);
    byLabel.set(dp.label, dp.id);

    if (!MP_MOVEMENT_FIELD_KEYS.includes(dp.fieldKey)) continue;
    // El rol sale del sufijo de la `fieldKey`. `roleOf()` del reconciliador
    // prefiere `valueJson.role`, pero el lado de escritura siempre los emite de
    // acuerdo (`.precio` → 'precio', `.cantidad` → 'cantidad'), así que leer las
    // versiones acá sería una segunda query para el mismo resultado.
    const role = dp.fieldKey.endsWith('.precio') ? 'precio' : 'cantidad';
    const iso = dp.fechaHecho ? dp.fechaHecho.toISOString().slice(0, 10) : null;
    const occ = nextOccurrence(counter, `${dp.fieldKey}|${dp.label}|${iso ?? ''}|${role}`);
    byMovementIdentity.set(movementIdentity(dp.fieldKey, dp.label, iso, role, occ), dp.id);
  }

  const linkFor = (node: TreeNode, rootIndex?: number): string | undefined => {
    if (node.traceFieldKey) {
      const byKey = byFieldKey.get(node.traceFieldKey) ?? byMovementIdentity.get(node.traceFieldKey);
      if (byKey) return byKey;
    }
    if (rootIndex !== undefined) {
      const rootKey = ROOT_FIELD_KEYS[rootIndex];
      const byRoot = rootKey ? byFieldKey.get(rootKey) : undefined;
      if (byRoot) return byRoot;
    }
    return byLabel.get(node.label);
  };

  const walk = (nodes: TreeNode[], roots: boolean) => {
    nodes.forEach((node, i) => {
      const dpId = linkFor(node, roots ? i : undefined);
      if (dpId) node.sourceDataPointId = dpId;
      if (node.children.length > 0) walk(node.children, false);
    });
  };
  walk(tree, true);
}

/**
 * Corridas del motor con árbol persistido (spec sección B + C). Reemplaza,
 * para los endpoints NUEVOS de trazabilidad, al `CostCalculation` legado
 * (que se mantiene intacto para `/cost-structures/:id/calculate` — ver
 * DECISIONES.md). Cada `calculate()` es UNA transacción: resolver config →
 * validar insumos → correr motor → persistir run + árbol → auditar.
 */
export class CalculationRunService {
  constructor(private readonly db: PrismaClient = prisma) {}

  private async requireStructure(userId: string, structureId: string) {
    const s = await this.db.costStructure.findFirst({ where: { id: structureId, userId } });
    if (!s) throw new NotFoundError('Estructura de costos no encontrada');
    return s;
  }

  async calculate(
    userId: string,
    structureId: string,
    actor: TraceActor,
    trigger: RunTrigger = 'MANUAL',
  ) {
    const s = await this.requireStructure(userId, structureId);

    // DESPACHO por sistema de costeo (patrón Strategy, B02). Este endpoint es el
    // cálculo de UNA estructura de Órdenes (un solo número por estructura). El
    // Costeo por Procesos se calcula por PERÍODO y DEPARTAMENTO con su propio
    // motor (B17) y su propio endpoint; una estructura de Procesos que cae acá va
    // por el camino equivocado, así que se corta con un 422 accionable en
    // castellano —nunca un 500— antes de validar las secciones de Órdenes (no
    // tiene sentido pedirle "cargá Materia Prima"). Para Órdenes —o estructuras
    // viejas sin el campo— sigue con el motor de Órdenes.
    if (s.costingSystem === 'PROCESSES') {
      throw new CostingSystemNotAvailableError();
    }
    const engine = selectCostingEngine(s.costingSystem);

    if (!s.rawMaterialConfig) {
      throw new MissingInputError('rawMaterial', 'Falta cargar la sección de Materia Prima antes de calcular.');
    }
    if (!s.directLaborConfig) {
      throw new MissingInputError('directLabor', 'Falta cargar la sección de Mano de Obra Directa antes de calcular.');
    }
    if (!s.indirectCostConfig) {
      throw new MissingInputError('indirectCosts', 'Falta cargar la sección de Costos Indirectos antes de calcular.');
    }

    // Doble período (spec D.3): un dato sin decisión de imputación no se puede
    // asignar con certeza a este mes. F04 — decisión: el cálculo NO se bloquea
    // (bloquearlo sin una pantalla para imputar dejaría al costista sin acción
    // posible). Corre igual, pero el resultado se MARCA como incompleto/no
    // confiable, con el motivo y los datos afectados por su nombre humano, para
    // que el frontend muestre una advertencia en vez de un margen "sano". El
    // bloqueo duro se mueve al CIERRE del período (acción irreversible) —
    // ver `CostPeriodService.close` y DECISIONES.md.
    // Nota: `take: 20` acota nombres y payload; con >20 pendientes el conteo del
    // motivo queda en 20 (mismo tope que la detección original).
    const input: CalculationInput = {
      rawMaterial: rawMaterialSectionSchema.parse(s.rawMaterialConfig),
      directLabor: directLaborConfigSchema.parse(s.directLaborConfig),
      indirectCosts: indirectCostConfigSchema.parse(s.indirectCostConfig),
      inventory: inventorySchema.parse({}),
      sales: {
        unitPrice: s.salesUnitPrice ? Number(s.salesUnitPrice) : 0,
        quantity: s.salesQuantity ? Number(s.salesQuantity) : 0,
        productionQuantity: s.productionQuantity == null ? null : Number(s.productionQuantity),
      },
    };

    // Fix crítico (B): insumo faltante → 422 accionable, nunca 500.
    // Corre siempre (idempotente) al calcular, sin depender de que el cierre
    // del prorrateo secundario ya haya corrido al guardar CIF.
    validateCalculationInputs(input);

    let output;
    let tree: TreeNode[];
    try {
      ({ results: output, tree } = engine.run(input));
    } catch (err) {
      if (err instanceof MissingInputError) throw err;
      throw toMissingInputError(err);
    }

    // Enriquecimiento de trazabilidad (D.1/D.2): no toca ningún valor
    // calculado, solo anota qué DataPoint respalda cada nodo, para que el
    // frontend pueda ofrecer "click en la hoja → ficha del dato". Ver
    // `resolveDataPointLinks`: clave determinística primero, `fieldKey` fija en
    // las 4 raíces, y la etiqueta solo como respaldo de datos migrados.
    await this.attachDataPointSources(structureId, tree);

    // A qué período pertenece esta corrida. Órdenes calcula "la estructura", no
    // un período, así que se le adjudica el que esté abierto — que es el que el
    // costista está viendo cuando aprieta el botón. Si todavía no hay ninguno
    // (estructura recién creada), queda en null: mejor sin período que con uno
    // inventado.
    // A-05 — Costeo variable. La contribución es una VISTA de los tres importes
    // ya producidos por absorción; no altera el motor ni vuelve a calcularlos.
    // Si la estructura no trae `companyId` (mocks históricos), la ausencia de
    // clasificación queda marcada como incompleta sin intentar una consulta sin
    // tenant. En producción `companyId` siempre existe por el modelo Prisma.
    const { results, incompletitud, periodId } = await enrichCalculationResult(this.db, {
      structureId,
      companyId: s.companyId,
      input,
      output,
    });

    return withTenant(userId, async (tx) => {
      // Persistencia COMPARTIDA (misma que usará el motor de Procesos, B17): una
      // corrida + su árbol + la auditoría, en esta transacción. No se duplica.
      const { run } = await persistCalculationRun(tx, {
        structureId,
        engineVersion: engine.engineVersion,
        executedBy: actor.id,
        periodId,
        trigger,
        inputsSnapshot: input,
        results,
        tree,
        audit: { actor, after: { grossMargin: output.grossMargin, grossMarginPct: output.grossMarginPct } },
      });

      await new PuntoEquilibrioAlertService().evaluar(tx, {
        userId,
        companyId: s.companyId,
        structureId,
        periodId,
        runId: run.id,
        puntoEquilibrio: results.puntoEquilibrio,
        fecha: new Date(),
      });

      // T-07 — UNA corrida del motor, DOS persistencias.
      //
      // Antes, apretar "Calcular" disparaba el motor dos veces: el camino legado
      // (`/cost-structures/:id/calculate`) pintaba los números y este armaba el
      // árbol. Que coincidieran era una propiedad emergente, no una garantía:
      // eran dos ejecuciones contra dos lecturas de configuración hechas en dos
      // momentos. Si un dato cambiaba en el medio, o si una fallaba y la otra no,
      // el árbol explicaba un número distinto del que estaba en pantalla y nada
      // lo detectaba.
      //
      // El manual (§1.4) pide lo contrario: "el motor lo emite y persiste al
      // calcular. Así el número mostrado y su explicación son, por construcción,
      // el mismo cálculo."
      //
      // Se escribe la fila legada acá, con el MISMO `output` que alimentó el
      // árbol, para que los consumidores que la leen sigan funcionando sin
      // cambios: `/calculations/latest` y `/calculations` (Historial y
      // Comparación de períodos), y `empresa-portal-service` para el panel del
      // operador de empresa. Ninguno de ellos sabe que ahora nace de acá.
      const calculation = await tx.costCalculation.create({
        data: {
          costStructureId: structureId,
          userId,
          rawMaterialConsumed: output.rawMaterialConsumed,
          directLaborTotal: output.directLaborTotal,
          indirectCostsApplied: output.indirectCostsApplied,
          productionCost: output.productionCost,
          costOfGoodsSold: output.costOfGoodsSold,
          grossMargin: output.grossMargin,
          grossMarginPct: output.grossMarginPct,
          detail: output.detail as object,
        },
      });

      return { run, results, tree, incompletitud, calculation };
    });
  }

  private async attachDataPointSources(structureId: string, tree: TreeNode[]): Promise<void> {
    // UNA sola query para todo el árbol (nunca una por nodo). El orden por
    // `createdAt` NO es cosmético: es el mismo que usa el reconciliador
    // (`datapoint-reconciler.ts`) para numerar las repeticiones de un
    // movimiento de MP, y es lo que hace que la ocurrencia N de este lado sea
    // la ocurrencia N del otro.
    const existing = await this.db.dataPoint.findMany({
      where: { structureId, voidedAt: null },
      select: { id: true, label: true, fieldKey: true, fechaHecho: true },
      orderBy: { createdAt: 'asc' },
    });
    if (existing.length === 0) return;

    resolveDataPointLinks(tree, existing);
  }

  async getTree(userId: string, runId: string) {
    const run = await this.db.calculationRun.findFirst({
      where: { id: runId, structure: { userId } },
    });
    if (!run) throw new NotFoundError('Corrida de cálculo no encontrada');

    const nodes = await this.db.calculationNode.findMany({
      where: { runId },
      orderBy: [{ parentId: 'asc' }, { ord: 'asc' }],
    });

    const byParent = new Map<string | null, typeof nodes>();
    for (const n of nodes) {
      const key = n.parentId ?? '__root__';
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key)!.push(n);
    }

    function toTree(parentId: string | null): unknown[] {
      const key = parentId ?? '__root__';
      return (byParent.get(key) ?? [])
        .sort((a, b) => a.ord - b.ord)
        .map((n) => ({
          id: n.id,
          label: n.label,
          formula: n.formula,
          value: n.valueNum !== null ? Number(n.valueNum) : null,
          unit: n.unit,
          sourceDpVersionIds: n.sourceDpVersionIds,
          // T-11 — la clave con la que el motor nombró este nodo. Las pantallas
          // ubican por acá el nodo de cada número que muestran; sin ella solo
          // les queda comparar etiquetas, que se rompe al renombrar un título.
          // `null` en las corridas anteriores a la columna: se leen igual.
          traceFieldKey: n.traceFieldKey,
          children: toTree(n.id),
        }));
    }

    return { runId: run.id, runN: run.runN, engineVersion: run.engineVersion, tree: toTree(null) };
  }

  /**
   * Historial de corridas. Por defecto devuelve TODAS —incluidas las automáticas
   * sin validar—, porque esta es la vista de trazabilidad y su razón de ser es
   * mostrar absolutamente todo lo que pasó. `soloValidadas` existe para las
   * pantallas que quieren únicamente lo que un humano firmó.
   */
  async listRuns(userId: string, structureId: string, soloValidadas = false) {
    await this.requireStructure(userId, structureId);
    const runs = await this.db.calculationRun.findMany({
      where: { structureId, ...(soloValidadas ? { validated: true } : {}) },
      orderBy: { runN: 'desc' },
      include: { executedByUser: true, period: { select: { code: true, label: true } } },
      take: 100,
    });
    return runs.map((r) => this.toRunSummary(r));
  }

  /**
   * El resultado que vale hoy: la última corrida VALIDADA.
   *
   * Si no hay ninguna validada, no devuelve vacío —eso le escondería al costista
   * que el sistema viene calculando— sino la última automática marcada como
   * provisoria. Es la diferencia entre "no hay datos" y "hay datos que nadie
   * miró todavía", y son dos situaciones muy distintas para quien decide precios.
   */
  async currentResult(userId: string, structureId: string) {
    await this.requireStructure(userId, structureId);

    const validada = await this.db.calculationRun.findFirst({
      where: { structureId, validated: true },
      orderBy: { executedAt: 'desc' },
      include: { executedByUser: true, period: { select: { code: true, label: true } } },
    });
    if (validada) return { provisorio: false, run: this.toRunSummary(validada) };

    const automatica = await this.db.calculationRun.findFirst({
      where: { structureId },
      orderBy: { executedAt: 'desc' },
      include: { executedByUser: true, period: { select: { code: true, label: true } } },
    });
    if (!automatica) return { provisorio: false, run: null };

    return {
      provisorio: true,
      motivo:
        'Este resultado lo calculó el sistema solo y todavía no lo revisó nadie. ' +
        'Revisá los datos del período y validalo antes de tomarlo por bueno.',
      run: this.toRunSummary(automatica),
    };
  }

  /**
   * Un humano da por buena una corrida automática.
   *
   * Es de una sola dirección a propósito: no hay "desvalidar". Validar es un
   * hecho con fecha y autor, y borrarlo dejaría el historial diciendo que nadie
   * miró algo que sí se miró. Si el resultado estaba mal, el camino es corregir
   * los datos y calcular de nuevo — que genera una corrida nueva y deja las dos
   * a la vista.
   */
  async validateRun(userId: string, runId: string, actor: TraceActor) {
    const run = await this.db.calculationRun.findFirst({
      where: { id: runId, structure: { userId } },
    });
    if (!run) throw new NotFoundError('Corrida de cálculo no encontrada');

    // Revalidar no es un error del usuario: es apretar dos veces. Se devuelve el
    // estado tal cual, sin pisar quién validó primero ni cuándo.
    if (run.validated) {
      return { id: run.id, runN: run.runN, validated: true, yaEstaba: true };
    }

    return withTenant(userId, async (tx) => {
      const updated = await tx.calculationRun.update({
        where: { id: runId },
        data: { validated: true, validatedAt: new Date(), validatedBy: actor.id },
      });

      await recordTraceAudit(
        {
          entityType: 'CostStructure',
          entityId: run.structureId,
          action: 'validar_calculo',
          actor,
          after: { runId: run.id, runN: run.runN, trigger: run.trigger },
        },
        tx,
      );

      return { id: updated.id, runN: updated.runN, validated: true, yaEstaba: false };
    });
  }

  /** Forma común de una corrida para las listas y el resultado vigente. */
  private toRunSummary(r: {
    id: string;
    runN: number;
    engineVersion: string;
    executedAt: Date;
    trigger: string;
    validated: boolean;
    validatedAt: Date | null;
    results: unknown;
    executedByUser: { name: string };
    period: { code: string; label: string } | null;
  }) {
    const results = r.results as { grossMargin?: number; grossMarginPct?: number };
    return {
      id: r.id,
      runN: r.runN,
      engineVersion: r.engineVersion,
      // En una corrida automática `executedBy` es el dueño de la estructura
      // porque la FK lo exige. Decir su nombre sería mentir: no la apretó él.
      executedBy: r.trigger === 'AUTO_DAILY' ? 'Cálculo automático del sistema' : r.executedByUser.name,
      executedAt: r.executedAt.toISOString(),
      trigger: r.trigger,
      validated: r.validated,
      validatedAt: r.validatedAt?.toISOString() ?? null,
      periodo: r.period ? { code: r.period.code, label: r.period.label } : null,
      grossMargin: results.grossMargin ?? null,
      grossMarginPct: results.grossMarginPct ?? null,
    };
  }
}
