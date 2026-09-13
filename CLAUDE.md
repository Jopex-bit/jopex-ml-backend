# CLAUDE.md — Guía de trabajo para el panel JOPEX

Este archivo documenta cómo trabajar en este repo, basado en lo que funcionó
(y lo que no) al rediseñar el módulo Investigación. Leer antes de tocar
cualquier otro módulo (Costos, Ads, Evolución, Stock).

## Proceso de trabajo con el usuario

- **Nunca codear sin haber cerrado el diseño completo primero.** El usuario
  quiere conversar y validar TODO (fórmula, campos, orden, UX) antes de que
  se escriba una sola línea. Ir módulo por módulo: cerrar uno, recién ahí
  pasar al siguiente.
- **Antes de diseñar nada, revisar el código y los datos reales que ya
  existen.** El error más grande de esta sesión fue diseñar el módulo
  Investigación de cero, por varios mensajes, sin haber mirado primero
  `panel.html` ni los datos reales guardados en `/api/estado`. El código real
  ya tenía funcionalidad mucho más madura de lo que el usuario describía de
  palabra (multi-línea, Comisión Alibaba, Costo Definitivo, Comparador de
  Proveedores). Siempre arrancar leyendo el módulo existente.
- **Nunca asumir nada de tipo fiscal/impositivo.** Cuando el usuario da un
  dato tributario de palabra (una alícuota, una base de cálculo), puede estar
  mal dicho o ser impreciso (pasó con "Derechos 103%" → en realidad variable
  por NCM/HS Code; "IVA sobre el CIF" → en realidad CIF + Derecho + Tasa
  Estadística). Antes de fijar una fórmula fiscal, contrastarla contra una
  fuente real del usuario (su propia planilla de Google Drive, una factura/
  liquidación real) — nunca contra lo que él recuerda de memoria en el chat.
- El usuario dicta por voz seguido; los mensajes vienen con errores de
  transcripción (números, "e imagen", "SIF" por "CIF", etc.). Ante algo que
  no cierra, preguntar en vez de asumir.

## Fórmula validada — Investigación / landed cost (régimen courier comercial)

Fuente de verdad: Google Drive → archivo **"ANALISIS y BUSQUEDA"** → hoja
**COSTO**, bloque "ESTRUCTURA DE COSTO - REGIMEN COURIER" (columnas A-D). El
bloque de columna G en adelante es régimen general y NO aplica.

```
Valor FOB total   = Precio unitario × Cantidad   (o el total directo del renglón)
Seguro            = 1% × (Valor FOB total + Flete)
Base CIF          = Valor FOB total + Flete + Seguro
Derecho Import.   = Base CIF × tasa variable (depende del NCM/HS Code: puede
                    ser 0%, 18%, 20%, 35%... el usuario la carga a mano por
                    producto, no hay un valor fijo)
Tasa Estadística  = Base CIF × 3% (fija)
IVA               = (Base CIF + Derecho + Tasa Estadística) × 21%
Total landed USD  = Base CIF + Derecho + Tasa Estadística + IVA
Unitario USD      = Total landed USD ÷ Cantidad
```

Importante: como el usuario importa bajo **courier con fin comercial** (no la
franquicia personal de USD 400 para uso no comercial), **no hay piso ni
exención** — la fórmula de arriba aplica siempre, sin importar el monto.

Comisión Alibaba (cuando la plataforma la cobra) se suma aparte, directo al
total en USD, sin pasar por Derecho/Tasa/IVA (no integra la base imponible).

### Sensibilidad rápida

Fuente de verdad: xlsx **"plantilla-taller-costo"** del usuario, hoja
`Taller`, bloque "SENSIBILIDAD RÁPIDA". Ojo: NO recalcula toda la cascada.

```
Corrida cambiaria +20%:
  Unitario USD  = igual al base (no cambia)
  Unitario ARS  = Unitario USD base × (Tipo de cambio × 1.20)

Flete +30%:
  Total USD nuevo    = Total landed USD base + (Flete original × 30%)
  Unitario USD nuevo = Total USD nuevo ÷ Cantidad
  (No se vuelve a calcular Seguro/Derecho/Tasa/IVA con el flete aumentado)
```

## Funcionalidad existente que hay que preservar (no romper al rediseñar)

- **Multi-línea**: una cotización puede combinar 2 productos físicos distintos
  con HS Code y tasa propios (ej. collar + GPS), relación 1 a 1. El envío y
  el seguro se prorratean por valor de línea. Es real, se usa hoy.
- **Costo Definitivo**: al nacionalizar, el usuario carga el pago real (en
  ARS) al courier y el sistema lo compara contra el estimado (% de desvío).
  No confundir con el costo estimado de la cotización.
- **Comparador de Proveedores** y **Análisis de Competencia** por grupo de
  producto: ya existen como componentes separados dentro de Investigación.
- Todo esto vive en `jopex_investigacion_cotizaciones`, con `productos`
  agrupados por nombre. **Nunca migrar destructivamente** este esquema: si un
  campo nuevo hace falta (ej. `estado`), calcular un valor por defecto al
  vuelo (`estadoDe()`) en vez de reescribir los datos guardados.

## UX que el usuario pidió y por qué

- **El orden de carga sigue el orden real en que llega la info del
  proveedor**: primero Cantidad y el total/precio cotizado, recién después
  Envío, links y metadata (TC, fecha). Los datos impositivos (HS Code, %
  Tasa DIE) van al final de cada línea — son detalle, no lo primero que se
  carga en una charla rápida con el proveedor.
- **Acordeón, no todo abierto a la vez**: una cotización por producto queda
  expandida (la "elegida", o la última cargada si ninguna lo está), el resto
  colapsado como historial con un badge de estado (Pendiente/Elegido/
  Descartado). Nunca se borran las descartadas.
- **"Marcar como elegido"** reemplaza al viejo botón manual "Enviar a
  Costos": al elegir una, se manda el costo a Costos automáticamente y las
  demás cotizaciones del mismo producto pasan a "Descartado" solas.
- Incidencia del flete sobre el costo total: alerta visual (rojo) si supera
  30% — señal de que conviene renegociar el envío o consolidar pedidos.

## Infraestructura y acceso

- Repo: `Jopex-bit/jopex-ml-backend` (GitHub). Deploy: Render, servicio
  `jopex-ml-backend` (`srv-d9stsc6gekts739bpcug`), workspace `jopex`
  (`tea-d9sebec9v7es73enrld0`). `autoDeploy` en `main`, **sin preview
  branches** — todo push a `main` va directo a producción, no hay ambiente
  intermedio.
- Acceso de Claude al repo: Personal Access Token fine-grained de GitHub
  (permiso "Contents: Read and write", limitado a este repo). El conector
  nativo de GitHub de claude.ai es de **solo lectura para contexto**, no
  sirve para commitear/pushear.
- Acceso a la API del panel: header `x-api-key` con el valor de
  `PANEL_API_KEY` (env var en Render) contra rutas `/api/*` en
  `jopex-ml-backend.onrender.com`.
- El panel en producción corre en `MODO_WEB` (`window.JOPEX_WEB === true`):
  los datos viven en el servidor vía `/api/estado`, no solo en
  `localStorage` del navegador.

## Antes de pushear a main (checklist)

1. `node --check` sobre el contenido del `<script>` principal de
   `panel.html` (no hay build step: el JSX ya viene pre-compilado a
   `React.createElement`, hay que escribirlo así a mano o transpilarlo).
2. Smoke test con `jsdom`, sembrando `localStorage` con datos reales bajados
   de `/api/estado` (no inventar datos de prueba) y forzando
   `jopex_active_module` al módulo que se está tocando. Confirmar: monta sin
   errores, los textos/clases nuevas aparecen, y una interacción básica
   (click en un botón clave) no corrompe el JSON guardado.
3. Confirmar con `git fetch` que `origin/main` no cambió desde que se clonó,
   antes de pushear.
4. Revisar `Render:list_deploys` / `get_deploy` después del push para
   confirmar que quedó `live` (deploy sin build, tarda ~30 segundos).

## Preferencias de trabajo del usuario

- Respuestas breves y directas, sin relleno.
- No generar archivos/reportes sin que los pida explícitamente.
- En decisiones de implementación (herramienta, formato, mecanismo técnico):
  resolver directo, sin preguntar, salvo que sea dato fiscal/impositivo —
  ahí nunca asumir, señalar la incertidumbre y validar con él.
