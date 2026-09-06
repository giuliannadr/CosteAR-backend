---
title: "Informe completo — Cola de espera, cálculo diario y trazabilidad"
fecha: 2026-08-02
periodo_cubierto: "31/07/2026 – 02/08/2026"
origen: "Reunión del 30/07/2026 + respuestas del socio (Granola 180dcece) + clases de la cátedra"
destinatarios: "Equipo Costear (técnico y no técnico)"
---

# Informe completo de lo implementado

Todo lo que se construyó entre el 31 de julio y el 2 de agosto de 2026: qué se
hizo, qué problemas aparecieron, qué decisiones se tomaron y por qué, qué quedó
afuera y qué hay que vigilar.

Está escrito para que lo pueda leer alguien que no programa. Las secciones 1 a 5
no tienen nada técnico. De la 6 en adelante sí.

---

## 1. En una frase

El sistema ahora **calcula solo, todos los días, el período abierto**, guarda
**cada corrida** con toda su cadena de origen, y decide qué mostrarle al costista
con un **interruptor de validación**: lo que un humano miró y aprobó se muestra
como resultado; lo que calculó la máquina queda guardado y visible, pero marcado
como provisorio.

---

## 2. Qué cambia para el que usa el sistema

**Antes.** El costo existía solamente cuando el costista entraba y apretaba
"Calcular". Si no entraba tres días, esos tres días no existían en ningún lado.

**Ahora.**

- El sistema recalcula todas las noches con lo que haya llegado.
- Si el costista no entró, el cálculo igual quedó guardado, marcado como *no
  validado*.
- Cuando entra, ve el resultado y además **el historial completo**: qué se
  calculó cada día, quién lo disparó y si alguien lo aprobó.
- Si un dato llega tarde —una factura de julio que aparece el 5 de agosto con
  julio ya cerrado— el sistema **no decide solo**: le pregunta, le muestra las
  tres opciones con la consecuencia de cada una, y no mete ese dato en ningún
  cálculo hasta que él decida.
- Para empezar a costear por procesos, ahora hay que **declarar primero el mapa
  de la fábrica** (por qué etapas pasa la producción). Se hace una sola vez.

**Lo que no cambia.** Ninguna estructura que ya existía calcula distinto. Los
números siguen dando lo mismo.

---

## 3. El escenario de la reunión, funcionando

Este es el caso concreto que se planteó el 30/07, y así queda:

| Día | Qué pasa |
|---|---|
| 1 | El costista entra, calcula y valida. Ve su resultado. |
| 2 | No entra. **El sistema calcula igual** y guarda la corrida sin validar. |
| 3 | Entra y calcula. El resultado **incluye lo que llegó el día 2**. |
| Siempre | En el historial se ven **las tres corridas**, con fecha, origen y estado. |

---

## 4. Las siete decisiones que se tomaron

Cada una está en el código y tiene tests que la sostienen.

### D1 — La frecuencia de costeo se configura por producto, no por empresa

Antes el ritmo (mensual, quincenal, trimestral) era uno solo para toda la
empresa. Ahora cada estructura de costos puede tener el suyo, y además se
agregó **ciclos de días fijos**: de 1 a 366 días.

Esto cubre lo que pidió el socio ("cada 10 o 15 días") y también el caso que
menciona la cátedra: un ingenio que corta cada 2 o 3 días porque el jugo de caña
fermenta.

### D2 — El interruptor de validación va en la corrida, no en el período

Un período tiene muchas corridas (una por día). Lo que el costista valida es
**una foto concreta**, no el mes entero. Por eso el interruptor está en cada
corrida.

### D3 — Standby: el sistema no calcula al pedo

Si desde el último cálculo automático no llegó ningún dato nuevo, no se calcula.
El resultado sería idéntico y lo único que lograría es enterrar el historial
bajo treinta corridas iguales — justo en la pantalla cuyo valor es poder leerla.

### D4 — Un período cerrado nunca se recalcula solo

Reabrirlo se puede, con motivo obligatorio y dejando rastro. Pero automático,
nunca.

**No es por dogma contable.** El socio fue claro en que esto es información
interna de gestión y no un libro contable. Es por otra razón: un número que
cambia sin que nadie lo haya pedido rompe lo único que estamos vendiendo, que es
la trazabilidad.

### D5 — Las corridas automáticas no se le atribuyen a una persona

La base de datos exige que toda corrida tenga un usuario asociado, así que las
automáticas se guardan con el dueño de la estructura. Pero quedan marcadas como
automáticas, y **la pantalla nunca dice "lo calculaste vos"**: dice "cálculo
automático del sistema".

### D6 — El grado de avance lo informa la planta, no el área de costos

**Esta decisión salió de la bóveda y no estaba ni en el acta ni en las respuestas
del socio.** Las clases de la cátedra lo dicen tres veces (34, 36 y 40):

> El grado de avance lo determina la oficina técnica (ingenieros/planta) al
> cierre de cada período, por departamento y por elemento — el área de costos
> **lo recibe y aplica, no lo estima**.

Consecuencia: si el sistema le pide al costista un dato que la cátedra dice que
no le corresponde estimar, lo empuja a inventar un número que después se lee como
si fuera un hecho.

### D7 — La oficina técnica es un permiso, no un rol nuevo

Se evaluó crear un rol de usuario nuevo y se descartó. `EMPRESA_OPERATOR` ya es
"personal de la empresa cliente", que es exactamente lo que es la oficina
técnica. Un rol aparte obligaba a tocar login, permisos, invitaciones y el panel
de administración para terminar con dos roles que en casi toda la aplicación
hacen lo mismo.

Lo que hay que distinguir **no es quién se loguea**: es de dónde salió el dato.
Por eso se resolvió con un permiso (`canReportWipCount`) más un campo de
procedencia en el recuento.

**El punto fino:** el sistema **no prohíbe** que el costista cargue el avance si
la planta no responde — sería inusable. Lo marca como estimado. Los dos casos se
aceptan, pero no quedan iguales en la base.

---

## 5. Lo que estábamos por hacer mal

### 5.1 Le dijimos algo incorrecto al socio

En la pregunta 1 que le pasamos, escribimos que un período diario "no se puede".
Al contrastar contra la bóveda, resultó ser más fuerte de lo que dice la cátedra.
Textual de la clase 40 y de la nota P3:

> Período: el corte temporal (día, semana, quincena, mes) **según la dinámica de
> la empresa**. En un ingenio los cortes son cada 2-3 días porque el jugo de caña
> fermenta.

O sea que cortar cada dos días no es un disparate teórico: es lo correcto para
cierta empresa. **El límite real no es el calendario**, es si la oficina técnica
puede informar el grado de avance a esa cadencia.

El código que se escribió está bien —soporta de 1 a 366 días—, pero la
justificación que le dimos al socio estaba mal. **Su respuesta ("cada 10 o 15
días") se dio sobre una premisa equivocada y puede que quiera revisarla.**

### 5.2 Un requisito que nadie había levantado

La D6 (el grado de avance lo informa planta) no estaba en el acta ni en el
Granola. Apareció leyendo las clases. Sin eso, íbamos a construir una pantalla
que le pide al costista un dato que no le corresponde estimar.

### 5.3 Una contradicción aparente en la bóveda que no era tal

La clase 36 enuncia la producción equivalente **restando** el inventario inicial
(método PEPS); la nota P3 y la clase 40 la enuncian **sin restarlo** (promedio
ponderado). Parecía un bug del motor.

No lo era: el motor usa promedio ponderado y está documentado como método único
por decisión de cátedra (`DECISIONES.md`, B10). Queda anotado para que nadie lo
"corrija" leyendo solo la clase 36.

---

## 6. Problemas técnicos detectados y resueltos

Esta sección es técnica. Son los problemas que aparecieron durante la
construcción, no los que ya existían en el sistema.

### 6.1 La compuerta del setup rompía la apertura de períodos

**Qué pasó.** Puse la validación "sin setup no se calcula" en `buildEngineInput()`,
que es donde se arma la entrada del motor. Rompió tres tests.

**Por qué los tests tenían razón.** Ese armado lo comparte `getProductionReport()`,
que además de ser una lectura **lo usa internamente el arrastre entre períodos**.
Con la compuerta ahí, una estructura vieja sin setup no podía ni abrir el período
siguiente.

**Cómo se resolvió.** La compuerta se movió a `calculate()`. Lo que hay que
impedir es *emitir* un costo, no *leer* lo que ya hay. Quedó un test que fija esa
distinción explícitamente.

### 6.2 El backfill no era repetible

**Qué pasó.** Al agregar la columna `validated`, la migración marca como
validadas todas las corridas existentes (porque las ejecutó un humano). Pero el
script de despliegue del repo puede re-correr una migración marcada como
revertida.

**El riesgo.** Una segunda corrida habría marcado como validadas las corridas
**automáticas** creadas después — es decir, habría dicho que un humano aprobó
números que nadie miró.

**Cómo se resolvió.** Los backfills van dentro de una guarda "si la columna
todavía no existe". Verificado contra un Postgres real: se sembraron datos, se
aplicó la migración, se creó una corrida automática, se re-aplicó la migración, y
la automática siguió sin validar.

### 6.3 Las corridas automáticas no tenían a quién atribuirse

**Qué pasó.** La base exige que toda corrida tenga un usuario (`executedBy` es
una clave foránea obligatoria). El cron no es un usuario.

**Cómo se resolvió.** Se guardan con el dueño de la estructura, pero con la marca
`AUTO_DAILY`, y la capa que arma la respuesta reemplaza el nombre por "Cálculo
automático del sistema". Hay un test que verifica que el nombre del dueño **no**
aparezca.

### 6.4 El interruptor de validación se podía falsear

**El riesgo.** Si `validated` fuera un parámetro que cada motor pasa, alcanzaría
un descuido para que una corrida automática figure como aprobada.

**Cómo se resolvió.** No es un parámetro: **se deriva del disparador**, en un
solo lugar. Manual y cierre nacen validadas (hay alguien apretando); automática,
no. Hay un test que verifica que pasar `validated: true` explícitamente en una
corrida automática **no sirve de nada**.

### 6.5 El cron llenaba los logs de alarmas falsas

**Qué pasó.** Al principio el job diario solo toleraba "falta un insumo"
(`MissingInputError`). Todo lo demás lo trataba como error.

**El problema.** El cuadro de movimiento que todavía no cuadra, o una base de
asignación sin definir, son estados **normales** de un período a medio cargar.
Tratarlos como error habría llenado los logs de alarmas todas las noches.

**Cómo se resolvió.** Se atrapa toda la familia de errores 422 (los que llevan un
mensaje accionable en castellano) y se reportan como "faltan datos", no como
fallo.

### 6.6 Un valor de enum nuevo no se puede usar en la misma transacción

Limitación de Postgres. Por eso `CUSTOM_DAYS` y `CountSource` van cada uno en su
propia migración, separados de las columnas que los usan.

### 6.7 Tres archivos de test tenían mocks incompletos

Al agregar lecturas de tablas nuevas (`costPeriod` en el cálculo, por ejemplo),
tres archivos de test fallaron porque sus bases de datos falsas no tenían esa
tabla. Se completaron los mocks. No eran bugs del código: eran tests que
reflejaban un acoplamiento nuevo y real.

### 6.8 Tests que fallan por red (preexistente, no se tocó)

Los tests de `tests/classifier/` pegan a la API de Groq con una clave inválida.
En la suite completa, bajo paralelización, se les vence un timeout y fallan
(`waste-intent`, `cascade-conflict`). **Pasan los 19 en aislamiento y pasan en
CI.** Es flakiness preexistente, sin relación con este trabajo.

**Recomendación:** excluirlos del corrido local (`--exclude "tests/classifier/**"`).
Dominan el tiempo de la suite y generan ruido.

---

## 7. Desvíos respecto del plan original

Dos, y los dos son deliberados.

**7.1 No se guarda una corrida vacía cuando faltan insumos.** El plan decía
guardarla marcada como incompleta. No se hizo: sin insumos el motor no produce
números, y guardar corridas sin resultados ensucia justamente el historial que
queremos legible. Lo que falta se ve en el reporte del job y en la pantalla del
período.

**7.2 La repropagación se corta a mitad de cadena si no puede valuar.** Si al
recalcular hacia adelante el motor no puede valuar la existencia final de un
período, la cadena se detiene ahí en vez de seguir. Dejar la cadena a medio
propagar y avisar es mejor que escribir un arrastre inventado en los meses
siguientes.

---

## 8. Lo que se construyó, fase por fase

### F1 — Frecuencia de costeo por estructura

- Calendario extendido con ciclos de días fijos (`CUSTOM_DAYS`), de 1 a 366 días.
- Los ciclos son **contiguos desde una fecha ancla**: no se reinician con el mes
  ni dejan huecos, y cruzan fin de mes y de año de largo.
- Un día que cae *dentro* de un ciclo pero no lo empieza **no** es un período
  válido: avisa en vez de inventar uno.
- Un documento con fecha anterior al ancla cae en el ciclo previo, no en el
  primero.
- `effectiveRhythm()` centraliza la decisión "cada cuánto costea esta
  estructura": gana el ritmo propio, si no hereda el de la empresa.

### F2 — La corrida sabe de qué período es y si un humano la miró

- Cuatro columnas nuevas en `calculation_runs`: período, disparador, validada, y
  la auditoría de la validación.
- Endpoints: resultado vigente, historial completo, validar una corrida.
- **Validar es de una sola dirección.** No hay "desvalidar": validar es un hecho
  con fecha y autor, y borrarlo dejaría el historial diciendo que nadie miró algo
  que sí se miró. Si el resultado estaba mal, el camino es corregir los datos y
  calcular de nuevo.

### F3 — El cálculo diario

- Corre a las **03:00 hora argentina**, después del pipeline de aprendizaje
  nocturno de las 02:00, para que vea las correcciones que ese pipeline dejó
  aplicadas.
- **Standby:** solo calcula si llegó algo nuevo. Se miran las cuatro puertas por
  las que entra información: documentos aprobados, guardados de configuración,
  el cuadro de movimiento del período, y las versiones de datos trazables.
- **Aislamiento:** una estructura que falla no voltea el lote.
- **La marca de "última corrida" solo se mueve si hubo corrida.** Si falló,
  mañana reintenta desde el mismo punto en vez de dar por visto un dato que nunca
  se procesó.
- El motivo que se guarda **no filtra detalles técnicos** al costista (hay test
  de que no aparezca un `ECONNREFUSED`).

### F4 — Setup previo obligatorio

- Wizard de cuatro pasos: departamentos, coproductos, recuento, revisión.
- Endpoint de **validación sin guardar**, para que el wizard muestre problemas y
  avisos *antes* de que el costista apriete.
- **Problemas bloquean, avisos no.** Bloquear lo que es una mala idea pero no un
  error deja al costista sin salida cuando su caso es legítimo.
- Sin setup completo, una estructura de Procesos **no puede emitir un costo**.
- Registro de procedencia del grado de avance (D6/D7).

### F5 — Datos atrasados

- Se detecta al imputar: si el período destino está cerrado, la imputación no
  ocurre.
- **Mientras la decisión está pendiente, el dato no entra a ningún cálculo.**
- Tres caminos: imputar al período abierto, reabrir y repropagar, o descartar
  (anulado lógico — nunca se borra, se sigue viendo en trazabilidad).
- La repropagación reusa **el mismo cálculo** que la apertura normal de un
  período, así el número que arrastra una corrección y el que arrastra una
  apertura son, por construcción, el mismo.

### F6 — Todo esto, visible

- Historial de corridas con **todas**, incluidas las automáticas sin validar.
- Bandeja de datos atrasados con la **consecuencia de cada opción escrita**.
- Banda de "resultado provisorio" **arriba** de los números (al pie llegaría
  tarde, con la decisión de precio ya tomada) y **dentro del PDF exportable** (un
  reporte sin revisar que sale por mail tiene que decirlo).

---

## 9. Base de datos: las 9 migraciones nuevas

Todas **aditivas** (solo agregan; no borran ni modifican datos existentes) e
**idempotentes** (se pueden correr dos veces sin romper nada).

| Migración | Qué agrega |
|---|---|
| `add_custom_days_periodicity` | Valor `CUSTOM_DAYS` al enum de periodicidad |
| `add_structure_period_frequency` | Frecuencia de costeo por estructura + CHECK |
| `add_run_period_and_validation` | Período, disparador y validación en las corridas |
| `add_period_last_auto_run` | Marca de última corrida automática (el standby) |
| `add_late_data_decisions` | Política de datos atrasados + tabla de decisiones |
| `add_count_source_enum` | Enum de procedencia del recuento |
| `add_wip_count_provenance` | Quién informó el grado de avance, y cuándo |
| `add_can_report_wip_count` | Permiso de oficina técnica |
| `add_structure_setup` | Setup completado, coproductos, frecuencia de recuento |

**Reglas que quedaron grabadas en la base misma (no solo en el código):**

- Ciclos de días fijos exigen largo *y* fecha ancla; y esos campos están
  prohibidos si el ritmo no es de días fijos.
- La frecuencia de recuento tiene que estar entre 1 y 366 días.
- Un dato no puede tener dos decisiones pendientes para el mismo período.
- Borrar un período **no** borra las corridas que lo calcularon: quedan
  huérfanas. Borrar la evidencia de que se calculó sería lo contrario de la
  trazabilidad.

---

## 10. Cómo se verificó

- **Tests:** 687 tests en 86 archivos (excluyendo los del clasificador, ver 6.8).
  Verde en dos corridas seguidas. Frontend: 32 tests, build limpio.
- **Migraciones:** las 9 se aplicaron contra un **Postgres real** (imagen
  `pgvector/pgvector:pg16` descartable, en un puerto aparte, sin tocar ninguna
  base del equipo). Se sembraron datos para verificar los backfills y se
  re-aplicó cada una para confirmar que es idempotente.
- **Reglas de la base:** se probaron las 9 combinaciones del CHECK de ciclos de
  días y las 5 del CHECK de frecuencia de recuento.
- **CI:** en verde en los cuatro pull requests, incluido el preview de Vercel.

---

## 11. Riesgos al desplegar

**11.1 El cron arranca solo.** A las 03:00 ART empieza a generar corridas sin
validar sobre los períodos abiertos. En los logs, buscar `[daily-run]`: reporta
cuántos períodos calculó, cuántos salteó por standby y cuáles no pudo, con el
motivo. **Si siempre dice 0 calculados, algo está mal.**

**11.2 Las estructuras de Procesos existentes van a ver el wizard.** Tienen el
setup sin completar, así que al entrar les aparece el wizard en lugar de las
pestañas, y no pueden calcular hasta completarlo. Es el comportamiento buscado
—nunca declararon su estructura productiva— pero **si nadie lo anticipa, parece
que se rompió algo**. Conviene avisar al equipo antes.

**11.3 Orden de despliegue.** El frontend consume endpoints nuevos. Si sube
primero, el historial de corridas y la bandeja quedan vacíos hasta que suba el
backend.

---

## 12. Huecos conocidos

Dos cosas quedaron **construidas pero no alcanzables desde la aplicación**. Las
señalo porque son las que más fácil se olvidan.

### 12.1 La frecuencia por estructura no se puede elegir desde ningún lado

Toda la maquinaria de F1 funciona: el calendario soporta ciclos de días, y
`effectiveRhythm()` usa el ritmo de la estructura si lo tiene. **Pero ningún
endpoint escribe esos campos.** Hoy siempre se hereda el de la empresa.

Falta un endpoint (o extender el del setup) para que el costista elija el ritmo
de cada producto. Sin eso, D1 está implementada pero no usable.

### 12.2 La política de datos atrasados siempre queda en "preguntar"

Igual: `lateDataPolicy` se lee correctamente y las tres ramas funcionan, pero
**nada la escribe**. En la práctica siempre vale `ASK`, así que los caminos
"imputar al período abierto automáticamente" y "reabrir automáticamente" son hoy
inalcanzables.

Es el default más conservador —el sistema nunca decide solo por plata— así que no
es peligroso. Pero la parte de "configuración previa" que pidió el socio está a
medio camino: se puede preguntar, no se puede pre-configurar.

**Las dos se cierran juntas y son trabajo chico:** agregar los campos al endpoint
de setup y al wizard.

---

## 13. Lo que no se hizo, y por qué

- **Alertas por anomalía (F7).** Fuera de alcance por decisión explícita del
  equipo. Está especificada en el plan. *Es lo próximo a construir.*
- **Validación automática por confianza** ("a medida que el sistema se entrene,
  que valide solo"). Requiere un historial de correcciones que todavía no tenemos
  en volumen suficiente.
- **El recuento sigue siendo un input humano.** Nadie puede inferir cuántas
  unidades a medio hacer quedaron en la planta. Lo que sí se hizo es pedírselo al
  rol correcto y registrar quién lo informó.

---

## 14. Deuda técnica y cosas para vigilar

- **Volumen.** Una corrida diaria por estructura, con su árbol de derivación, son
  del orden de 30 corridas por mes por estructura. Hoy no es problema y los
  índices están puestos. **A futuro habrá que definir una política de retención**
  del árbol de las corridas automáticas no validadas (el resultado se conserva
  siempre).
- **Tests del clasificador.** Flakiness de red preexistente. Convendría separarlos
  del corrido normal.
- **`main` está muy atrás.** Al momento de escribir esto, `main` estaba 236
  commits detrás de `dev`. No afecta este trabajo, pero conviene mirarlo.

---

## 15. Glosario

| Término | Qué significa acá |
|---|---|
| **Corrida** | Una ejecución del motor de cálculo. Queda guardada entera, con su árbol. |
| **Validar** | Que un humano mire una corrida y la dé por buena. Irreversible. |
| **Provisorio** | Un resultado que calculó el sistema y todavía no revisó nadie. |
| **Standby** | Que el cálculo diario no corra si no llegó nada nuevo. |
| **Período abierto** | El mes (o quincena, o ciclo) que todavía se está armando. |
| **Repropagar** | Recalcular hacia adelante cuando un período anterior cambió. |
| **Grado de avance** | Qué porcentaje de su costo tiene incorporado una unidad sin terminar. |
| **Oficina técnica** | Los ingenieros de planta. Los que informan el grado de avance. |
| **Arrastre** | Que el inventario final de un período sea el inicial del siguiente. |

---

## 16. Dónde está todo

- **Plan por fases:** `docs/plans/2026-07-31-cola-espera-y-trazabilidad-diaria.md`
- **Este informe:** `docs/plans/2026-08-02-informe-cola-espera-y-trazabilidad.md`
- **Decisiones técnicas acumuladas del repo:** `DECISIONES.md`
- **Material de cátedra:** `costear-vault/costear-knowledge-base`

Pull requests: backend #28 y #30, frontend #18 y #20; promociones a staging
backend #29 y frontend #19.
