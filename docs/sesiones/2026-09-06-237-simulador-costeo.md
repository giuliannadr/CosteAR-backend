# Bitácora de sesión — #237 simulador de costeo

## Recursos

- Tokens: no informado.
- Preparación: `npm ci` (659 paquetes agregados), `npm run prisma:generate` (cliente generado).
- `npm run lint`: salida 0.
- `npm run typecheck`: salida 0.
- `npm test`: 169 archivos pasaron, 1 omitido; 1537 tests pasaron, 4 omitidos.
- `npm run test:http`: 12 archivos pasaron; 77 tests pasaron.
- `npm run test:integration`: 15 archivos pasaron; 48 tests pasaron.
- `npm run check:tests-base`: todos los tests que necesitan base están declarados.

## Decisiones

- El enriquecimiento que consulta clasificaciones, incompletitud y período quedó
  en una función compartida por `CalculationRunService` y el simulador. Así el
  what-if conserva el motor puro y no duplica la lógica de la corrida.
- El simulador mantiene su carácter no persistente: sólo consulta datos y
  devuelve la vista derivada de los shocks aplicados.
- La clasificación efectiva viaja en los componentes de `contribucionMarginal`;
  una ausencia deja la contribución y el punto de equilibrio marcados como
  incompletos, con sus motivos.

## Prueba de medición

Se rompió a propósito la aserción del shock para exigir igualdad en vez de
desigualdad. La corrida quedó roja con:

`expected 1.79 to be 3.71 // Object.is equality`

Se restauró la aserción y la misma prueba quedó verde: 1 archivo, 2 tests.

## Fuera de alcance

- No cambia ninguna fórmula del motor.
- No persiste simulaciones ni crea migraciones.
- Costeo por Procesos conserva su endpoint y contrato actuales.
