/**
 * ORIGEN ÚNICO DE VERDAD: qué tests necesitan una base Postgres viva, y con qué rol.
 *
 * Lo importan los TRES configs de vitest, y por eso no pueden desalinearse:
 *   - `vitest.config.ts`             EXCLUYE todo esto (la suite rápida usa Prisma mockeado)
 *   - `vitest.integration.config.ts` incluye `CON_ROL_DE_APP`
 *   - `vitest.db.config.ts`          incluye `CON_ROL_DUENO`
 *
 * ── POR QUÉ EXISTE ESTE ARCHIVO ──────────────────────────────────────────────
 *
 * Hasta el 15-08-2026 la convención era "lo que necesita base vive en
 * `tests/integration/`". Cinco archivos quedaron fuera de esa carpeta y cayeron
 * en un hueco: se auto-saltean sin `DATABASE_URL` (bien pensado), la suite
 * rápida no la tiene (bien), y el config de integración incluía solo
 * `tests/integration/**` — así que no los agarraba nadie.
 *
 * Resultado: **61 tests que nunca corrían en CI, con el pipeline en verde igual.**
 * Entre ellos los 34 de `rls-cross-tenant`, que son la prueba de fuego del
 * aislamiento entre empresas: justo lo que protege los datos del cliente.
 *
 * ── POR QUÉ DOS LISTAS Y NO UNA ──────────────────────────────────────────────
 *
 * Los dos grupos necesitan roles de Postgres OPUESTOS, y no es un detalle:
 *
 *   CON_ROL_DE_APP  → `DATABASE_URL` apunta al rol de la aplicación, SIN BYPASSRLS.
 *                     Es el punto: si corrieran con un superusuario, Postgres ni
 *                     evaluaría las políticas y darían verde igual con RLS roto.
 *
 *   CON_ROL_DUENO   → `DATABASE_URL` apunta al rol dueño, que sí saltea RLS,
 *                     porque estos tests SIEMBRAN sus datos con SQL crudo y el
 *                     rol de la app no puede insertarlos (RLS se los rechaza con
 *                     `42501: new row violates row-level security policy`).
 *                     `rls-cross-tenant` además usa `RLS_PROBE_DATABASE_URL`
 *                     para la sonda: siembra con el dueño y VERIFICA con el rol
 *                     restringido. Correrlo sin esa sonda no prueba nada, y el
 *                     propio archivo se niega a dar verde si falta.
 *
 * ── REGLA AL AGREGAR UN TEST QUE NECESITE BASE ───────────────────────────────
 *
 * Agregalo a la lista que corresponda. El script `scripts/check-tests-con-base.mjs`
 * corre en CI y falla si algún test se apoya en `DATABASE_URL` y no está acá.
 */

/**
 * Corren con el rol de la aplicación (NOBYPASSRLS). Verifican que las políticas
 * RLS efectivamente impidan ver datos de otro inquilino.
 */
export const CON_ROL_DE_APP = [
  'tests/integration/**/*.test.ts',
  // El cliente Prisma está mockeado, pero el test necesita DATABASE_URL para
  // verificar el camino que consulta el vocabulario activo. No usa SQL crudo.
  'tests/classifier/vocabulary-profile.test.ts',
];

/**
 * Corren con el rol dueño porque siembran sus propios datos con SQL crudo.
 * `rls-cross-tenant` usa además `RLS_PROBE_DATABASE_URL` para verificar con un
 * rol restringido: siembra con el dueño, comprueba con la sonda.
 */
export const CON_ROL_DUENO = [
  // Seguridad: aislamiento entre inquilinos y append-only de la evidencia.
  'tests/security/rls-cross-tenant.test.ts',
  'tests/security/evidence-append-only.test.ts',

  // Trazabilidad: el árbol de cálculo y la procedencia del dato se verifican
  // contra filas reales, no contra un mock del ORM.
  'tests/application/trazabilidad-ordenes-config.test.ts',
  'tests/application/trazabilidad-procedencia-ia.test.ts',

  // Criterio del backfill del libro mayor: mira la migración de verdad.
  'tests/validaciones/ledger-criterio-importe-iva.test.ts',
];

/** Todo lo que necesita base, para que la suite rápida lo excluya. */
export const E2E_CON_ROL_DE_APP = ['tests/e2e/**/*.test.ts'];

export const TESTS_CON_BASE = [...CON_ROL_DE_APP, ...CON_ROL_DUENO, ...E2E_CON_ROL_DE_APP];
