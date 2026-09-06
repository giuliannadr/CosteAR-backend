import type { PrismaClient, Prisma } from '@prisma/client';
import { prisma } from '../../infrastructure/database/prisma.js';
import { recordAudit, type AuditContext } from '../audit/audit-logger.js';
import { NotFoundError, ValidationError, UnprocessableEntityError } from '../../domain/errors/domain-error.js';
import {
  rawMaterialSectionSchema,
  directLaborConfigSchema,
  indirectCostConfigSchema,
  inventorySchema,
  normalizeIndirectConfigForRead,
  type CreateCostStructureInput,
} from '../../shared/schemas/cost.schema.js';
import {
  runCalculation,
  computeProductiveBudgets,
  applyPrimaryAllocationBases,
  applySecondaryAllocationBases,
  type CalculationInput,
} from '../../domain/calculations/calculate.js';
import { parseIndirectCostConfigInput } from './validate-inputs.js';
import { AllocationBaseService } from './allocation-base-service.js';
import { CalculationRunService } from './calculation-run-service.js';
import { enrichCalculationResult } from './calculation-result-enrichment.js';
import { requireWritablePeriod, type PeriodMirrorData } from './period-sync.js';
import { codeFromDate } from '../../domain/periods/period-calendar.js';
import { companyRhythm } from '../../domain/periods/effective-rhythm.js';
import type { IndirectCostConfig } from '../../shared/schemas/cost.schema.js';
import type { TraceActor } from '../audit/trace-audit.js';
import type { CaptureMethod } from '../../shared/schemas/trazabilidad.schema.js';
import { reconcileSectionDataPoints } from '../trazabilidad/datapoint-reconciler.js';
import {
  rawMaterialPoints,
  directLaborPoints,
  indirectCostPoints,
  salesPoints,
  type DesiredPoint,
  type OrdersSection,
} from '../trazabilidad/orders-input-points.js';

/**
 * Gestión de estructuras de costos y ejecución de cálculos.
 *
 * Cada cálculo crea un registro INMUTABLE en CostCalculation, preservando la
 * trazabilidad histórica. La estructura referencia siempre al userId dueño de
 * la empresa (defensa en profundidad + RLS).
 */
/**
 * Quién guarda y CÓMO entró el dato. Viaja aparte de `AuditContext` porque la
 * trazabilidad necesita dos cosas que la auditoría legada no lleva: el ROL del
 * actor (para firmar la versión del dato) y el MÉTODO de captación ('manual',
 * 'excel_import', ...). Es opcional en toda la API: si no viene, se asume una
 * carga manual del costista dueño de la estructura.
 */
export interface SaveTrace {
  actor: TraceActor;
  method: CaptureMethod;
}

/** Motivo que queda escrito en la versión del dato, por sección. */
const SECTION_REASON: Record<OrdersSection, string> = {
  rawMaterial: 'Carga de la sección Materia Prima',
  directLabor: 'Carga de la sección Mano de Obra Directa',
  indirectCosts: 'Carga de la sección Costos Indirectos de Producción',
  sales: 'Carga de los datos de venta',
};

export class CostStructureService {
  constructor(private readonly db: PrismaClient = prisma) {}

  /** Actor + método por defecto cuando quien llama no los declara. */
  private traceFrom(userId: string, ctx: AuditContext, trace?: SaveTrace): SaveTrace {
    if (trace) return trace;
    return {
      actor: {
        id: userId,
        role: 'COSTISTA',
        area: 'costista',
        ...(ctx.userAgent ? { device: ctx.userAgent } : {}),
      },
      method: 'manual',
    };
  }

  /**
   * Insumos trazables que declara una sección. Tolerante a propósito: si el JSON
   * guardado es de una forma vieja que ya no parsea, devuelve una lista vacía y
   * el guardado sigue. Perder la traza de una sección es malo; impedir que el
   * costista guarde su trabajo es peor.
   */
  private sectionPoints(section: OrdersSection, config: unknown, period: string): DesiredPoint[] {
    if (config === null || config === undefined) return [];
    try {
      switch (section) {
        case 'rawMaterial':
          return rawMaterialPoints(rawMaterialSectionSchema.parse(config), period);
        case 'directLabor':
          return directLaborPoints(directLaborConfigSchema.parse(config), period);
        case 'indirectCosts':
          return indirectCostPoints(indirectCostConfigSchema.parse(config), period);
        case 'sales':
          return salesPoints(
            config as { unitPrice: number; quantity: number; productionQuantity: number | null },
            period,
          );
      }
    } catch {
      return [];
    }
  }

  private async requireCompany(userId: string, companyId: string) {
    const company = await this.db.company.findFirst({ where: { id: companyId, userId } });
    if (!company) throw new NotFoundError('Empresa no encontrada');
    return company;
  }

  async requireStructure(userId: string, id: string) {
    const structure = await this.db.costStructure.findFirst({ where: { id, userId } });
    if (!structure) throw new NotFoundError('Estructura de costos no encontrada');
    return structure;
  }

  async listByCompany(userId: string, companyId: string, includeDeleted = false, cursor?: string, limit = 50) {
    await this.requireCompany(userId, companyId);
    const take = limit + 1;
    const structures = await this.db.costStructure.findMany({
      where: { companyId, userId, ...(includeDeleted ? {} : { deletedAt: null }) },
      orderBy: [{ deletedAt: 'asc' }, { period: 'desc' }],
      take,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const hasMore = structures.length === take;
    const items = hasMore ? structures.slice(0, limit) : structures;
    return { items, nextCursor: hasMore ? items[items.length - 1]!.id : null };
  }



  async getById(userId: string, id: string) {
    const structure = await this.requireStructure(userId, id);
    // El frontend recibe SIEMPRE el reparto secundario en la forma canónica por
    // pares (`distributions`), aunque la estructura se haya guardado antes del
    // cambio de contrato (F01-A). Conversión en memoria; no se reescribe nada.
    if (structure.indirectCostConfig) {
      return {
        ...structure,
        indirectCostConfig: normalizeIndirectConfigForRead(structure.indirectCostConfig),
      };
    }
    return structure;
  }

  /** Genera el .xlsx de la estructura (datos + Estado de Costos). */
  async exportToExcel(userId: string, id: string): Promise<{ buffer: Buffer; filename: string }> {
    const s = await this.db.costStructure.findFirst({
      where: { id, userId },
      include: { company: true },
    });
    if (!s) throw new NotFoundError('Estructura de costos no encontrada');
    // El Excel reproduce el estado de costos de ÓRDENES, hoja por hoja. Para una
    // estructura de Procesos produciría un archivo con la estructura y los
    // números equivocados — y como el archivo sale del sistema y circula por
    // mail, un número mal calculado ahí es de los más difíciles de rastrear
    // después. Mejor no emitirlo.
    if (s.costingSystem === 'PROCESSES') {
      throw new UnprocessableEntityError(
        `«${s.productName}» usa Costeo por Procesos. El export a Excel todavía reproduce el ` +
          'estado de costos de Costeo por Órdenes, así que no aplica. Usá el informe de costos ' +
          'del período desde la pestaña Resultado.',
        { field: 'costingSystem' },
      );
    }
    if (!s.rawMaterialConfig || !s.directLaborConfig || !s.indirectCostConfig) {
      throw new ValidationError('Cargá MP, MOD y CIP antes de exportar');
    }

    const { exportCostStructureToXlsx } = await import('./excel-export.js');
    const buffer = await exportCostStructureToXlsx({
      productName: s.productName,
      period: s.period,
      companyName: s.company.name,
      rawMaterialConfig: s.rawMaterialConfig,
      directLaborConfig: s.directLaborConfig,
      indirectCostConfig: s.indirectCostConfig,
      salesUnitPrice: s.salesUnitPrice ? Number(s.salesUnitPrice) : 0,
      salesQuantity: s.salesQuantity ? Number(s.salesQuantity) : 0,
    });
    const safeName = `${s.company.name}-${s.productName}-${s.period}`
      .replace(/[^a-zA-Z0-9-]/g, '_')
      .slice(0, 80);
    return { buffer, filename: `CosteAR-${safeName}.xlsx` };
  }

  /**
   * Parsea un .xlsx (base64) buscando los campos de MP/MOD/CIP/Ventas por
   * etiqueta. NO persiste nada — el resultado se usa como `defaultValues` en
   * los formularios existentes, que ya no guardan hasta que el costista
   * aprieta "Guardar" en cada sección.
   */
  async importFromExcel(userId: string, id: string, fileBase64: string) {
    await this.requireStructure(userId, id);
    const buffer = Buffer.from(fileBase64, 'base64');
    const { parseExcelImport } = await import('./excel-import/index.js');
    return parseExcelImport(buffer);
  }

  async create(userId: string, companyId: string, input: CreateCostStructureInput, ctx: AuditContext) {
    const company = await this.requireCompany(userId, companyId);

    // El período de arranque ya no se tipea: sale de la fecha de hoy leída con el RITMO
    // de la empresa. Una empresa quincenal que da de alta un producto el 20 de julio
    // arranca en la 2ª quincena de julio ("2026-07-Q2"), no en "julio" a secas.
    //
    // Acá va el ritmo de la EMPRESA a propósito: la estructura todavía no existe,
    // así que no puede tener override propio. Si el costista elige una frecuencia
    // distinta para este producto, se aplica desde el período siguiente.
    const period = input.period ?? codeFromDate(new Date(), companyRhythm(company.periodicity));

    return this.db.$transaction(async (tx) => {
      const structure = await tx.costStructure.create({
        // El sistema de costeo (ÓRDENES / PROCESOS) se persiste desde el alta: es la
        // compuerta de toda la feature de Costeo por Procesos. Antes se descartaba acá
        // y TODA estructura nacía como ORDERS, ignorando lo que mandaba el cliente.
        data: { companyId, userId, productName: input.productName, period, costingSystem: input.costingSystem ?? 'ORDERS' },
      });
      await recordAudit(
        // Se audita el período DERIVADO, no el que vino (que puede no venir): la auditoría
        // tiene que decir en qué período nació la estructura, no qué tipeó el usuario.
        { ...ctx, userId, action: 'cost_structure.create', entityType: 'CostStructure', entityId: structure.id, newValue: { ...input, period } },
        tx,
      );
      return structure;
    });
  }

  /**
   * Cambia el SISTEMA DE COSTEO (ÓRDENES / PROCESOS) de una estructura. Solo se
   * permite mientras la estructura NO tenga historia de cálculo: una vez que
   * corrió el motor, cambiar de sistema mezclaría el rastro de dos motores
   * distintos sobre la misma estructura y corrompería el árbol de derivación.
   * En ese caso se devuelve un 422 accionable (nunca un 500). Ver DECISIONES.md.
   */
  async updateCostingSystem(
    userId: string,
    id: string,
    costingSystem: 'ORDERS' | 'PROCESSES',
    ctx: AuditContext,
  ) {
    const before = await this.requireStructure(userId, id);

    return this.db.$transaction(async (tx) => {
      // "Tener cálculos" abarca los dos registros de historia: los runs trazables
      // (CalculationRun, árbol de derivación) y los snapshots del motor legado
      // (CostCalculation). Con cualquiera de los dos presente, el sistema queda
      // congelado: se bloquea el cambio de forma conservadora para no corromper
      // ninguna historia.
      const [runs, calcs] = await Promise.all([
        tx.calculationRun.count({ where: { structureId: id } }),
        tx.costCalculation.count({ where: { costStructureId: id } }),
      ]);
      if (runs > 0 || calcs > 0) {
        throw new UnprocessableEntityError(
          'No se puede cambiar el sistema de costeo de una estructura que ya tiene cálculos. ' +
            'Creá una estructura nueva con el sistema que necesitás.',
        );
      }

      const updated = await tx.costStructure.update({
        where: { id },
        data: { costingSystem },
      });

      await recordAudit(
        {
          ...ctx,
          userId,
          action: 'cost_structure.costing_system.update',
          entityType: 'CostStructure',
          entityId: id,
          oldValue: { costingSystem: before.costingSystem },
          newValue: { costingSystem },
        },
        tx,
      );
      return updated;
    });
  }

  /**
   * Cambia la POLÍTICA DE DATOS ATRASADOS de una estructura: qué hacer cuando
   * llega un dato cuya fecha cae en un período ya cerrado.
   *
   * La maquinaria que la respeta (`late-data-service.ts`) existe desde que se
   * construyó la bandeja de atrasados; lo que faltaba era el interruptor. Sin
   * él el campo quedaba siempre en `ASK` y cada factura atrasada interrumpía al
   * costista, aunque ya hubiera resuelto veinte veces lo mismo.
   *
   * Se puede cambiar en cualquier momento y no toca nada de lo ya decidido: la
   * política se copia como `policyAtDetection` en cada decisión al momento de
   * detectarla, así que el historial sigue diciendo con qué regla se resolvió
   * cada caso, no con la que rige hoy.
   */
  async updateLateDataPolicy(
    userId: string,
    id: string,
    lateDataPolicy: 'ASK' | 'CURRENT_PERIOD' | 'REOPEN',
    ctx: AuditContext,
  ) {
    const before = await this.requireStructure(userId, id);

    return this.db.$transaction(async (tx) => {
      const updated = await tx.costStructure.update({ where: { id }, data: { lateDataPolicy } });

      await recordAudit(
        {
          ...ctx,
          userId,
          action: 'cost_structure.late_data_policy.update',
          entityType: 'CostStructure',
          entityId: id,
          oldValue: { lateDataPolicy: before.lateDataPolicy },
          newValue: { lateDataPolicy },
        },
        tx,
      );
      return updated;
    });
  }

  /** A-06: precio o estructura completos cambian la vista variable sin un pedido extra. */
  private async recalculateVariableView(
    userId: string,
    structureId: string,
    ctx: AuditContext,
    structure: { rawMaterialConfig: unknown; directLaborConfig: unknown; indirectCostConfig: unknown },
  ) {
    if (!structure.rawMaterialConfig || !structure.directLaborConfig || !structure.indirectCostConfig) return;
    await new CalculationRunService(this.db).calculate(userId, structureId, {
      id: ctx.userId ?? userId,
      role: 'COSTISTA',
      area: 'costista',
    });
  }

  /**
   * Resuelve el reparto en modo 'base' del PRIMARIO (conceptos) y del SECUNDARIO
   * (centros de servicio): lee las unidades vigentes de cada base de asignación
   * (allocation_base_values) y las vuelca a `distribution` / `toProductive`, para
   * que el motor derive los % (nunca la IA, nunca a mano). Tolerante: si una base
   * todavía no tiene valores cargados, deja ese concepto/servicio como está (no
   * bloquea el guardado; la validación de insumos lo detecta al calcular).
   */
  private async resolveAllocationBases(
    userId: string,
    structureId: string,
    config: IndirectCostConfig,
  ): Promise<IndirectCostConfig> {
    const baseCodes = [
      ...new Set([
        ...config.concepts
          .filter((c) => c.allocationMode === 'base' && c.baseCode)
          .map((c) => c.baseCode as string),
        ...config.serviceDistributions
          .filter((d) => d.distributionMode === 'base' && d.baseCode)
          .map((d) => d.baseCode as string),
      ]),
    ];
    if (baseCodes.length === 0) return config;
    const alloc = new AllocationBaseService(this.db);

    // 3b-2: persistir en el registro trazable (append-only, con historial) las
    // unidades por centro que vienen de la config, ANTES de resolver. Así el
    // motor lee de la tabla auditable y no de un dato suelto. Las unidades del
    // primario viven en `distribution`; las del secundario, en `toProductive`.
    const unitsByCode = new Map<string, Record<string, number>>();
    for (const c of config.concepts) {
      if (c.allocationMode === 'base' && c.baseCode) {
        unitsByCode.set(c.baseCode, { ...(unitsByCode.get(c.baseCode) ?? {}), ...(c.distribution ?? {}) });
      }
    }
    for (const d of config.serviceDistributions) {
      if (d.distributionMode === 'base' && d.baseCode) {
        // Las unidades del secundario viven en los PARES `distributions`
        // (centroDestinoId → fijo). En modo 'base', fijo y variable comparten la
        // misma base, así que alcanza con `fijo` para sembrar allocation_base_values.
        const units = Object.fromEntries(d.distributions.map((p) => [p.centroDestinoId, p.fijo]));
        unitsByCode.set(d.baseCode, { ...(unitsByCode.get(d.baseCode) ?? {}), ...units });
      }
    }
    for (const [code, u] of unitsByCode) {
      try {
        await alloc.syncValues(userId, structureId, code, u);
      } catch {
        /* si la persistencia falla, no bloquea el guardado; se usa la config */
      }
    }

    const units = new Map<string, Record<string, number>>();
    for (const code of baseCodes) {
      try {
        units.set(code, await alloc.resolveBaseUnits(userId, structureId, code));
      } catch {
        /* base sin valores todavía: se deja el reparto como estaba */
      }
    }
    const resolver = (code: string) => units.get(code);
    // Primario primero (conceptos), luego secundario (servicios).
    return applySecondaryAllocationBases(applyPrimaryAllocationBases(config, resolver), resolver);
  }

  /** Actualiza uno de los tres bloques de configuración (validado con Zod). */
  async updateConfig(
    userId: string,
    id: string,
    section: 'rawMaterial' | 'directLabor' | 'indirectCosts',
    rawConfig: unknown,
    ctx: AuditContext,
    trace?: SaveTrace,
  ) {
    const before = await this.requireStructure(userId, id);
    const saveTrace = this.traceFrom(userId, ctx, trace);

    const data: Prisma.CostStructureUpdateInput = {};
    // Valor anterior de la sección (para la auditoría) y valor nuevo (para el
    // versionado append-only, R1).
    let oldValue: unknown;
    let newValue: object;
    if (section === 'rawMaterial') {
      oldValue = before.rawMaterialConfig;
      // Acepta la MP única legada o N materias primas; guarda normalizado.
      newValue = rawMaterialSectionSchema.parse(rawConfig) as object;
      data.rawMaterialConfig = newValue;
    } else if (section === 'directLabor') {
      oldValue = before.directLaborConfig;
      newValue = directLaborConfigSchema.parse(rawConfig) as object;
      data.directLaborConfig = newValue;
    } else {
      oldValue = before.indirectCostConfig;
      // Schema de ENTRADA: además de la forma, rechaza capacidad normal en 0
      // con un 422 accionable que nombra el centro. Un bp = 0 guardado deja el
      // producto costeado sin CIF y hace explotar las variaciones al calcular.
      const parsed = parseIndirectCostConfigInput(rawConfig);
      // Reparto en modo 'base' (primario y secundario): "bajar" las unidades de
      // la base de asignación a números concretos (`distribution`/`toProductive`)
      // para que el motor derive los % (trazable, nunca la IA). No-op si ningún
      // concepto/servicio está en modo 'base'.
      const resolved = await this.resolveAllocationBases(userId, id, parsed);
      // Auto-completar el PRESUPUESTO de cada centro productivo con el resultado
      // del prorrateo (primario + cierre del secundario). El usuario nunca lo
      // tipea: queda en solo lectura en la UI. Si la config aún está incompleta
      // (p. ej. sin conceptos), se persiste tal cual y se completará al re-guardar.
      try {
        const budgets = computeProductiveBudgets(resolved);
        resolved.productiveSettings = resolved.productiveSettings.map((p) => ({
          ...p,
          budget: budgets[p.centerId] ?? p.budget ?? { fixed: 0, variable: 0 },
        }));
      } catch {
        /* config incompleta: se persiste sin recalcular el presupuesto */
      }
      newValue = resolved as object;
      data.indirectCostConfig = newValue;
    }

    // R1 + R2: versión append-only de la config + update del puntero vigente +
    // espejo en el período abierto + auditoría, TODO en la misma transacción.
    const updated = await this.db.$transaction(async (tx) => {
      // Un mes cerrado no se edita (C — Fase 3). Sin períodos, sigue como antes.
      const period = await requireWritablePeriod(tx, id);

      await this.appendConfigVersion(tx, id, section, newValue, userId);
      const updated = await tx.costStructure.update({ where: { id }, data });

      // TRAZABILIDAD (T-01): el JSON de la sección ya no es el único lugar donde
      // vive un insumo. Acá —misma transacción— cada número de la sección queda
      // como `DataPoint` con su versión, su autor y su motivo, se repara lo que
      // haya entrado por Excel/API/ingesta sin traza, y se anula lo que el
      // costista borró. No toca ningún valor calculado.
      await reconcileSectionDataPoints(tx, {
        structureId: id,
        section,
        desired: this.sectionPoints(section, newValue, before.period),
        previous: this.sectionPoints(section, oldValue, before.period),
        actor: saveTrace.actor,
        method: saveTrace.method,
        reason: SECTION_REASON[section],
      });

      if (period) {
        await tx.costPeriod.update({
          where: { id: period.id },
          data: data as PeriodMirrorData,
        });
      }

      await recordAudit(
        {
          ...ctx,
          userId,
          action: `cost_structure.config.${section}`,
          entityType: 'CostStructure',
          entityId: id,
          oldValue,
          newValue,
        },
        tx,
      );
      return updated;
    });
    await this.recalculateVariableView(userId, id, ctx, updated);
    return updated;
  }

  /**
   * Inserta una versión append-only de una sección de config (R1). Calcula el
   * próximo `versionN` para (estructura, sección) y NUNCA pisa lo anterior — un
   * trigger de DB bloquea cualquier UPDATE/DELETE sobre esta tabla.
   */
  private async appendConfigVersion(
    tx: Prisma.TransactionClient,
    structureId: string,
    section: string,
    value: object,
    userId: string,
    reason?: string,
  ) {
    const last = await tx.costConfigVersion.findFirst({
      where: { structureId, section },
      orderBy: { versionN: 'desc' },
      select: { versionN: true },
    });
    await tx.costConfigVersion.create({
      data: {
        structureId,
        section,
        versionN: (last?.versionN ?? 0) + 1,
        value: value as Prisma.InputJsonValue,
        createdBy: userId,
        reason,
      },
    });
  }

  /** Historial append-only de una sección de config (R1). Más nueva primero. */
  async getConfigHistory(userId: string, id: string, section?: string) {
    await this.requireStructure(userId, id);
    return this.db.costConfigVersion.findMany({
      where: { structureId: id, ...(section ? { section } : {}) },
      orderBy: [{ section: 'asc' }, { versionN: 'desc' }],
    });
  }

  /**
   * `quantity` son las unidades VENDIDAS (con eso se factura y sale el margen).
   * `productionQuantity` son las PRODUCIDAS (con eso sale el costo unitario). No son
   * lo mismo: producir 1.000 y vender 800 son dos números distintos, y dividir el
   * costo por las vendidas lo infla. Es opcional: si no viene, el costo unitario se
   * cae a las vendidas, como hacía el sistema antes de tener el campo.
   */
  async updateSales(
    userId: string,
    id: string,
    unitPrice: number,
    quantity: number,
    ctx: AuditContext,
    productionQuantity?: number | null,
    trace?: SaveTrace,
  ) {
    const before = await this.requireStructure(userId, id);
    const produced = productionQuantity ?? null;
    const saveTrace = this.traceFrom(userId, ctx, trace);

    const updated = await this.db.$transaction(async (tx) => {
      const period = await requireWritablePeriod(tx, id);

      await this.appendConfigVersion(
        tx,
        id,
        'sales',
        { salesUnitPrice: unitPrice, salesQuantity: quantity, productionQuantity: produced },
        userId,
      );
      const updated = await tx.costStructure.update({
        where: { id },
        data: { salesUnitPrice: unitPrice, salesQuantity: quantity, productionQuantity: produced },
      });

      // Trazabilidad de VENTA: precio unitario, cantidad vendida y cantidad
      // producida son tres datos con autores distintos (comercial y planta), no
      // tres columnas de una fila.
      await reconcileSectionDataPoints(tx, {
        structureId: id,
        section: 'sales',
        desired: this.sectionPoints(
          'sales',
          { unitPrice, quantity, productionQuantity: produced },
          before.period,
        ),
        previous: this.sectionPoints(
          'sales',
          before.salesUnitPrice === null && before.salesQuantity === null
            ? null
            : {
                unitPrice: before.salesUnitPrice === null ? 0 : Number(before.salesUnitPrice),
                quantity: before.salesQuantity === null ? 0 : Number(before.salesQuantity),
                productionQuantity:
                  before.productionQuantity === null ? null : Number(before.productionQuantity),
              },
          before.period,
        ),
        actor: saveTrace.actor,
        method: saveTrace.method,
        reason: SECTION_REASON.sales,
      });

      if (period) {
        await tx.costPeriod.update({
          where: { id: period.id },
          data: { salesUnitPrice: unitPrice, salesQuantity: quantity, productionQuantity: produced },
        });
      }
      await recordAudit(
        {
          ...ctx,
          userId,
          action: 'cost_structure.sales.update',
          entityType: 'CostStructure',
          entityId: id,
          oldValue: {
            salesUnitPrice: before.salesUnitPrice,
            salesQuantity: before.salesQuantity,
            productionQuantity: before.productionQuantity,
          },
          newValue: { salesUnitPrice: unitPrice, salesQuantity: quantity, productionQuantity: produced },
        },
        tx,
      );
      return updated;
    });
    await this.recalculateVariableView(userId, id, ctx, updated);
    return updated;
  }

  /**
   * TRABAJOS DE TERCEROS del período (#90, ADR 0009).
   *
   * Procesos mandados a hacer afuera —un tratamiento térmico, un bordado, un
   * flete de proceso— que son parte del costo de producción y van como renglón
   * propio del estado de costos, entre el costo normal y el real.
   *
   * Tiene endpoint y columna propios, y NO vive dentro de la config de costos
   * indirectos, aunque en pantalla se cargue al lado: la cátedra (clase 20) los
   * registra por separado de los CIP porque **no se prorratean entre centros ni
   * generan cuotas**. Si compartiera el JSON con los conceptos, tarde o temprano
   * alguien lo suma ahí "para simplificar" y se diluye en las cuotas — el costo
   * total daría parecido y el de cada centro quedaría mal.
   *
   * Mismo patrón que los datos de venta: versión append-only de la config (R1),
   * columna vigente, espejo en el período abierto y auditoría, todo en la misma
   * transacción (R2).
   */
  async updateThirdPartyWork(
    userId: string,
    id: string,
    thirdPartyWork: number,
    ctx: AuditContext,
  ) {
    const before = await this.requireStructure(userId, id);

    return this.db.$transaction(async (tx) => {
      // Un mes cerrado no se edita: sus números ya se dieron por buenos.
      const period = await requireWritablePeriod(tx, id);

      await this.appendConfigVersion(tx, id, 'thirdPartyWork', { thirdPartyWork }, userId);

      const updated = await tx.costStructure.update({
        where: { id },
        data: { thirdPartyWork },
      });

      if (period) {
        await tx.costPeriod.update({ where: { id: period.id }, data: { thirdPartyWork } });
      }

      await recordAudit(
        {
          ...ctx,
          userId,
          action: 'cost_structure.third_party_work.update',
          entityType: 'CostStructure',
          entityId: id,
          oldValue: { thirdPartyWork: before.thirdPartyWork },
          newValue: { thirdPartyWork },
        },
        tx,
      );
      return updated;
    });
  }

  /**
   * Ejecuta el motor de cálculo sobre la configuración persistida y guarda un
   * snapshot inmutable. Devuelve el resultado.
   */
  async calculate(userId: string, id: string, ctx: AuditContext, inventoryOverride?: unknown) {
    const s = await this.requireStructure(userId, id);

    // ESTE ENDPOINT ES SOLO DE COSTEO POR ÓRDENES.
    //
    // Hasta acá no miraba el sistema de costeo y le corría la matemática de
    // Órdenes a CUALQUIER estructura, incluidas las de Procesos. Dos consecuencias,
    // las dos malas:
    //
    //  1. En Procesos, MP/MOD/CIP viven en el cuadro de movimiento de unidades,
    //     no en estos JSON. Al estar vacíos, el costista recibía "cargá MP, MOD y
    //     CIP antes de calcular" — un mensaje que le pide llenar campos que en su
    //     pantalla no existen, y que dejaba el módulo aparentemente roto.
    //  2. Peor: si el clasificador había autopoblado esos JSON, el cálculo salía
    //     igual y PERSISTÍA un costo con matemática de Órdenes sobre una
    //     estructura de Procesos. Un número mal calculado, guardado, sin que
    //     nadie se entere.
    //
    // El Costeo por Procesos se calcula por PERÍODO y DEPARTAMENTO, con su propio
    // motor y su propio endpoint. Acá se corta con un 422 que dice a dónde ir.
    if (s.costingSystem === 'PROCESSES') {
      throw new UnprocessableEntityError(
        `«${s.productName}» usa Costeo por Procesos, que se calcula por período y por ` +
          'departamento. Abrí la pestaña Resultado del período para correr el informe de costos.',
        { field: 'costingSystem' },
      );
    }

    if (!s.rawMaterialConfig || !s.directLaborConfig || !s.indirectCostConfig) {
      throw new ValidationError(
        'La estructura está incompleta: cargá MP, MOD y CIP antes de calcular',
      );
    }

    const input: CalculationInput = {
      rawMaterial: rawMaterialSectionSchema.parse(s.rawMaterialConfig),
      directLabor: directLaborConfigSchema.parse(s.directLaborConfig),
      indirectCosts: indirectCostConfigSchema.parse(s.indirectCostConfig),
      // #90 — dato propio del período, no parte de los costos indirectos.
      thirdPartyWork: Number(s.thirdPartyWork ?? 0),
      inventory: inventorySchema.parse(inventoryOverride ?? {}),
      sales: {
        unitPrice: s.salesUnitPrice ? Number(s.salesUnitPrice) : 0,
        quantity: s.salesQuantity ? Number(s.salesQuantity) : 0,
        productionQuantity: s.productionQuantity == null ? null : Number(s.productionQuantity),
      },
    };

    const result = runCalculation(input);

    const calculation = await this.db.$transaction(async (tx) => {
      const created = await tx.costCalculation.create({
        data: {
          costStructureId: id,
          userId,
          rawMaterialConsumed: result.rawMaterialConsumed,
          directLaborTotal: result.directLaborTotal,
          indirectCostsApplied: result.indirectCostsApplied,
          productionCost: result.productionCost,
          costOfGoodsSold: result.costOfGoodsSold,
          grossMargin: result.grossMargin,
          grossMarginPct: result.grossMarginPct,
          detail: result.detail as object,
        },
      });
      await recordAudit(
        { ...ctx, userId, action: 'cost_structure.calculate', entityType: 'CostStructure', entityId: id },
        tx,
      );
      return created;
    });

    return { calculation, result };
  }

  async latestCalculation(userId: string, id: string) {
    await this.requireStructure(userId, id);
    return this.db.costCalculation.findFirst({
      where: { costStructureId: id, userId },
      orderBy: { calculatedAt: 'desc' },
    });
  }

  async calculationHistory(userId: string, id: string) {
    await this.requireStructure(userId, id);
    return this.db.costCalculation.findMany({
      where: { costStructureId: id, userId },
      orderBy: { calculatedAt: 'desc' },
      take: 50,
    });
  }

  async simulate(userId: string, id: string, shocks: { rawMaterial?: number, directLabor?: number, indirectCosts?: number, sales?: number }) {
    const s = await this.requireStructure(userId, id);

    // El simulador aplica shocks sobre el motor de Órdenes. En Procesos los
    // costos no viven en estos JSON, así que simular acá daría números sin
    // relación con la estructura. No es alcanzable desde la interfaz —la pestaña
    // Simulador es solo de Órdenes— pero el endpoint está abierto a quien lo llame.
    if (s.costingSystem === 'PROCESSES') {
      throw new UnprocessableEntityError(
        `«${s.productName}» usa Costeo por Procesos. El simulador de escenarios todavía es ` +
          'solo de Costeo por Órdenes.',
        { field: 'costingSystem' },
      );
    }

    if (!s.rawMaterialConfig || !s.directLaborConfig || !s.indirectCostConfig) {
      throw new ValidationError('La estructura está incompleta: cargá MP, MOD y CIP antes de simular');
    }

    const input: CalculationInput = {
      // Se arma con el MISMO esquema que `calculate()` (N materias primas). Antes
      // el simulador usaba la forma vieja de UNA sola materia prima y quedaba
      // desincronizado del motor.
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

    if (shocks.rawMaterial) {
      const mul = 1 + shocks.rawMaterial;
      // El shock de precio golpea a TODAS las materias primas de la estructura.
      for (const material of input.rawMaterial.materials) {
        material.wilson.unitCost *= mul;
        material.initialStock.unitCost *= mul;
        for (const m of material.movements) {
          m.unitCost = (m.unitCost ?? 0) * mul;
        }
      }
    }
    if (shocks.directLabor) {
      const mul = 1 + shocks.directLabor;
      input.directLabor.departments.forEach(d => {
        d.basicRemuneration *= mul;
      });
    }
    if (shocks.indirectCosts) {
      const mul = 1 + shocks.indirectCosts;
      input.indirectCosts.concepts.forEach(c => {
        c.amount.fixed *= mul;
        c.amount.variable *= mul;
      });
    }
    if (shocks.sales) {
      const mul = 1 + shocks.sales;
      input.sales.unitPrice *= mul;
    }

    const output = runCalculation(input);
    const { results } = await enrichCalculationResult(this.db, {
      structureId: id,
      companyId: s.companyId,
      input,
      output,
    });
    return { result: results };
  }
}
