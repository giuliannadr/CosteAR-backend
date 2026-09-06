import { PrismaClient } from '@prisma/client';
import { currentTenantId, enterExplicitTransaction, inExplicitTransaction } from './tenant-context.js';

/**
 * Cliente Prisma singleton.
 *
 * En desarrollo, el hot-reload de tsx puede crear múltiples instancias; las
 * cacheamos en globalThis para evitar agotar el pool de conexiones.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

const base =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

/**
 * LOS MODELOS CON RLS, y solo esos.
 *
 * Espeja `prisma/rls.sql`. Acotar la lista importa: cada consulta a un modelo de
 * acá paga una transacción para poder setear `app.user_id`, y no tiene sentido
 * pagarla en `users`, `terms_versions` o el resto, que no tienen políticas.
 *
 * TIENE QUE ESTAR SINCRONIZADO CON `prisma/rls.sql`: si una tabla tiene política
 * y su modelo NO está acá, sus consultas nunca reciben el `set_config`, así que
 * `current_app_user_id()` devuelve NULL y la política las rechaza — un INSERT
 * falla con "new row violates row-level security policy" y un SELECT devuelve
 * cero filas EN SILENCIO.
 *
 * Eso pasó de verdad: la corrección C-01 llevó el RLS de 13 a 30 tablas y esta
 * lista quedó con las 13 viejas. CI lo encontró al insertar en `cost_periods`
 * con un rol sin BYPASSRLS. Hoy no se nota porque el rol de la app saltea el
 * RLS; el día que infra lo cambie, cada tabla que falte acá deja de funcionar.
 *
 * `tests/config/rls-coverage.test.ts` compara esta lista contra `rls.sql` y se
 * pone en rojo si vuelven a separarse. No la edites a mano sin correrlo.
 *
 * Ojo con los nombres: son los del MODELO de Prisma, no los de la tabla. El
 * `ByProductLine` de abajo estaba escrito como 'JointCostByProductLine' —el
 * nombre de la tabla— así que nunca protegió nada.
 */
export const RLS_MODELS = new Set([
  // Las 13 originales.
  'Company',
  'CostStructure',
  'CostCalculation',
  'Alert',
  'AlertSetting',
  'DataPoint',
  'DataPointVersion',
  'CalculationRun',
  'CalculationNode',
  'ProcessDepartment',
  'UnitMovementSchedule',
  'JointCostAllocation',
  'ByProductLine',
  // Las que sumó C-01 y las que vinieron después.
  'AllocationBase',
  'AllocationBaseValue',
  'AuditLog',
  'ClassificationAudit',
  'CompanyTargetBudget',
  'CostConfigVersion',
  'CostLedgerEntry',
  'CostPeriod',
  'EmpresaConnection',
  'Evidence',
  'LateDataDecision',
  'ProcessedCAE',
  'SupplierFingerprint',
  'ValidationHistory',
  'VaultChatMessage',
  'VaultChatSession',
  // S-02 del vertical avicola: parametros de costeo y unidades de medida.
  'UnidadMedida',
  'ParametroCosteo',
  // Operación física genérica.
  'UnidadProductiva',
  'LoteProductivo',
  'EventoLote',
  'ProduccionDiaria',
  'EgresoProducto',
  'VentaProducto',
  'Deposito',
  'MovimientoDeposito',
  'CorridaProduccion',
  'ConsumoCorrida',
  'PaqueteRubro',
  // S-03 y S-04.
  'ActivoAmortizable',
  'DesperdicioRegistro',
  // S-05b.
  'ReglaAlerta',
]);

/**
 * SETEA EL INQUILINO EN CADA CONSULTA, no solo en las escrituras.
 *
 * `SET LOCAL app.user_id` vale para la transacción en curso, así que la consulta
 * tiene que viajar en la MISMA transacción que el `set_config`. Por eso el par
 * va en un `$transaction([...])`: es el patrón que documenta Prisma para RLS, y
 * a diferencia de una transacción interactiva no retiene la conexión mientras
 * corre código de aplicación.
 *
 * Sin contexto de inquilino (workers, arranque, `asSystem`) la consulta pasa
 * derecho: no se inventa un usuario. Y adentro de `withTenant` también pasa
 * derecho, porque esa transacción ya seteó el valor y anidar otra fallaría.
 */
const extended = base.$extends({
  query: {
    $allModels: {
      async $allOperations({ model, args, query }) {
        const userId = currentTenantId();
        if (!userId || inExplicitTransaction() || !RLS_MODELS.has(model)) {
          return query(args);
        }
        const [, result] = await base.$transaction([
          base.$executeRaw`SELECT set_config('app.user_id', ${userId}, TRUE)`,
          query(args),
        ]);
        return result;
      },
    },
  },
});

// H19: $transaction llamado directamente (sin withTenant) no activa
// inExplicitTransaction(), así que la extensión de $allModels abría su propia
// conexión por cada consulta RLS dentro del callback — rompiendo la atomicidad.
// Este parche envuelve el callback de toda transacción interactiva en
// enterExplicitTransaction para que la extensión se quede quieta.
// Las batch transactions (array de operaciones) no tienen este problema.
/**
 * `$transaction` tiene dos firmas —callback interactivo y array de operaciones—
 * y sobre el cliente EXTENDIDO sus tipos no son expresables sin repetir media
 * declaración de Prisma. Se describe acá solo lo que este parche necesita
 * saber: que recibe una cosa u otra y devuelve una promesa.
 *
 * El `tx` va como `unknown` a propósito: este envoltorio no lo toca, solo lo
 * pasa. Tiparlo de más sería afirmar algo sobre el cliente de transacción que
 * este código no usa ni verifica.
 */
type CallbackDeTransaccion = (tx: unknown) => Promise<unknown>;
type FirmaTransaccion = (
  arg: CallbackDeTransaccion | readonly unknown[],
  options?: unknown,
) => Promise<unknown>;

const conTransaccion = extended as unknown as { $transaction: FirmaTransaccion };
const origTx = conTransaccion.$transaction.bind(conTransaccion);

type TxConTenant = {
  $executeRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
};

conTransaccion.$transaction = function (arg, options) {
  if (typeof arg === 'function') {
    return origTx((tx) => enterExplicitTransaction(async () => {
      const tenantId = currentTenantId();
      // Una transaccion directa tiene que conservar el tenant del request. Si
      // no lo hace, la extension se desactiva para evitar anidarla y RLS ve
      // NULL: el superusuario lo ocultaba, el rol de aplicacion lo rechaza.
      if (tenantId) {
        await (tx as TxConTenant).$executeRaw`SELECT set_config('app.user_id', ${tenantId}, true)`;
      }
      return arg(tx);
    }), options);
  }
  return origTx(arg, options);
};

/**
 * El tipo extendido no es asignable a `PrismaClient`, y los 22 servicios reciben
 * `db: PrismaClient` por constructor. El casteo mantiene ese contrato: en
 * runtime es el cliente extendido, y la extensión no agrega ni saca métodos —
 * solo envuelve los que ya existen.
 */
export const prisma = extended as unknown as PrismaClient;

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = base;
}

/**
 * Ejecuta un callback dentro de una transacción con el contexto de tenant
 * seteado para Row-Level Security.
 *
 * Sigue existiendo para las escrituras que necesitan atomicidad entre varias
 * tablas. La diferencia con antes es que ya no es el ÚNICO lugar donde se setea
 * el inquilino: las lecturas ahora también lo hacen, vía la extensión de arriba.
 *
 * `SET LOCAL app.user_id` aplica solo a la transacción actual; las políticas
 * RLS de PostgreSQL leen ese valor con `current_setting('app.user_id')` y
 * filtran cada query a las filas del tenant. Aunque un bug en la capa de
 * aplicación olvide filtrar por userId, la base NO devuelve datos ajenos.
 */
export async function withTenant<T>(
  userId: string,
  fn: (tx: Parameters<Parameters<PrismaClient['$transaction']>[0]>[0]) => Promise<T>,
): Promise<T> {
  return base.$transaction(async (tx) => {
    // set_config con `true` => local a la transacción.
    await tx.$executeRaw`SELECT set_config('app.user_id', ${userId}, true)`;
    // La extensión tiene que quedarse quieta acá adentro: el valor ya está
    // seteado, y abrir otra transacción por consulta fallaría.
    return enterExplicitTransaction(() => fn(tx));
  });
}
