# Bitácora de sesión — #260 contrato de parámetros

## Recursos y verificación

- Tokens: no informado.
- `npm ci`: 659 paquetes agregados.
- `npm run prisma:generate`: cliente Prisma generado.
- `npm run lint`: salida 0.
- `npm run typecheck`: salida 0.
- `npm test`: 169 archivos pasaron, 1 omitido; 1542 tests pasaron, 4 omitidos.
- `npm run test:http`: 12 archivos pasaron; 80 tests pasaron.
- `npm run test:integration`: 16 archivos pasaron; 49 tests pasaron.
- `npm run check:tests-base`: todos los tests que necesitan base están declarados.

## Decisiones

- Los metadatos (`descripcion`, `unidad`, `valorDefault` y `seguro`) salen de
  `DefinicionParametro` en cada respuesta; no se copia el catálogo al borde HTTP.
- El DELETE es una baja lógica del override del nivel indicado por `structureId`
  y `periodId`. Después devuelve la cascada re-resuelta, incluyendo el origen.
- Borrar un override ausente es idempotente y no agrega una auditoría ficticia.
- La prueba de aislamiento usa la base real y el rol de aplicación sin
  `BYPASSRLS`, no el superusuario de Docker.

## Medición negativa

Se cambió deliberadamente la expectativa del DELETE a `404`. La prueba quedó
roja con `expected 200 to be 404 // Object.is equality`. Restaurada la guarda,
la suite HTTP focalizada quedó verde: 11 tests.

## Fuera de alcance

- No se modifica el catálogo ni se agregan defaults de un cliente particular.
- No se toca la unidad de los resultados de costeo (#252).
- No se dibuja la pantalla del frontend.
- No se agregan dependencias ni migraciones.
