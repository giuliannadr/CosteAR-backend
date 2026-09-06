# 0010 — Exponer pendientes de cierre desde el tablero

- **Fecha:** 2026-09-06
- **Estado:** Aceptada
- **Decide:** Equipo CosteAR
- **Contexto de origen:** issue #236

## Contexto

El tablero del dueño ya muestra `motivos` legibles dentro de sus indicadores, pero la interfaz necesita agrupar lo que falta resolver sin reinterpretar oraciones. Esa reinterpretación duplicaría las reglas que producen la incompletitud y se separaría del cálculo con el tiempo.

## Decisión

`GET /periods/:id/tablero-dueno` expone una lista aditiva `pendientes`. Cada elemento contiene `area`, `dato` y el período `{ id, codigo }`; se deduplica por área y dato. Los pendientes se derivan de las mismas fuentes que generan los motivos existentes y `motivos` se conserva sin cambios.

Las áreas responden al origen actual: ausencia de corrida → `calculo`; datos sin imputar → `imputacion`; unidad de venta → `configuracion`; cantidad producida → `produccion`; ventas → `ventas`; y faltantes propios del cálculo, como la clasificación frente al volumen → `costeo`.

## Alternativas consideradas

| Alternativa | Por qué no |
| --- | --- |
| Agrupar `motivos` en la interfaz | Duplica una regla de dominio en otro repositorio y depende de textos. |
| Crear una consulta independiente de pendientes | Repite detecciones ya existentes y puede desincronizarse del tablero. |
| Reemplazar `motivos` por el nuevo contrato | Rompe consumidores que todavía usan los mensajes por indicador. |

## Consecuencias

**A favor**

- La interfaz puede agrupar acciones pendientes sin inferir su área.
- Las dos vistas se apoyan en la detección ya persistida por la corrida.

**En contra / lo que aceptamos pagar**

- La respuesta agrega una vista más que debe mantenerse junto a los motivos al aparecer un origen nuevo.

**Qué se rompe si alguien la revierte sin leer esto**

- La interfaz vuelve a tener que adivinar el área a partir de mensajes y puede mostrar pendientes distintos de los que invalidan los indicadores.

## Cómo se verifica que sigue vigente

`tests/http/owner-dashboard.test.ts` cubre un período completo, los orígenes de faltantes y que ventas repetida en varios indicadores aparezca una sola vez.
