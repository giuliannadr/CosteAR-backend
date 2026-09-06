# ADR — Registro de decisiones de arquitectura

Una decisión técnica no obvia = un archivo acá. Se crea con `/costear-adr` y se revisa **en el
mismo PR que la implementa**, para que la decisión y el código entren juntos.

## Por qué existe esto

Dentro de seis meses alguien va a mirar una parte del código y preguntar *"¿por qué está hecho
así?"*. Sin ADR la respuesta es "no me acuerdo" o, peor, alguien lo "arregla" sin saber que era
a propósito y rompe algo. Con ADR la respuesta está escrita, fechada y con las alternativas que
se descartaron.

Con un cliente real en producción, esto deja de ser prolijidad y pasa a ser lo que nos permite
responder con seriedad cuando pregunten por qué el sistema hace lo que hace.

## Cuándo escribir uno

**Sí:**

- Elegir entre dos librerías, patrones o enfoques
- Una decisión que a alguien le va a parecer rara sin el contexto
- Algo que se hizo "mal a propósito" por una restricción real
- Un cambio en el modelo de datos que condiciona lo que viene
- Cualquier decisión que afecte plata del cliente o la matemática del costeo

**No:**

- Cómo se llama una variable
- Aplicar un patrón que ya está establecido en el repo
- Algo que el código explica solo

Regla práctica: **si tuviste que pensarlo más de diez minutos o discutirlo con alguien, es un ADR.**

## Formato del nombre

```
NNNN-slug-en-imperativo.md
```

Numeración correlativa de 4 dígitos, nunca se reutiliza. Ejemplos:

```
0001-versionar-los-datos-en-lugar-de-actualizarlos.md
0002-aislar-empresas-con-rls-de-postgres.md
```

## Plantilla

Está en [`_template.md`](./_template.md). Copiala o usá `/costear-adr`.

## Estados

| Estado | Significa |
| --- | --- |
| `Propuesta` | Escrita, todavía no acordada |
| `Aceptada` | En vigencia — es lo que hacemos hoy |
| `Superada por NNNN` | Ya no aplica. **No se borra**: queda para entender por qué cambió |
| `Descartada` | Se evaluó y se decidió no hacerlo (igual de valioso que una aceptada) |

> **Un ADR nunca se borra ni se reescribe.** Si la decisión cambió, se escribe uno nuevo y se
> marca el viejo como superado. La historia de por qué cambiamos de opinión es la parte más útil.

## Relación con `DECISIONES.md`

`DECISIONES.md` (raíz del repo) es el **registro histórico** de la implementación de
"Trazabilidad Total v1". Se conserva tal cual, pero **no se le agrega nada nuevo**: de acá en
adelante todo va a esta carpeta, un archivo por decisión.

## Índice

<!-- Se agrega una línea por ADR. Más reciente arriba. -->

- [0010 — Exponer pendientes de cierre desde el tablero](./0010-exponer-pendientes-de-cierre-desde-el-tablero.md) — 06-09-2026 · **Aceptada**. El tablero publica pendientes estructurados sin reemplazar los motivos existentes.
- [0001 — Separar los tests en tres suites según el rol de Postgres que necesitan](./0001-tres-suites-de-test-segun-el-rol-de-postgres.md) — 15-08-2026 · **Aceptada**. 61 tests no corrían en ningún lado, entre ellos los 34 del aislamiento entre empresas.
