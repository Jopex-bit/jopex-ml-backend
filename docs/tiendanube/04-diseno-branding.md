# 4. Diseño / branding — aplicar el manual de marca al tema de Tiendanube

Tiendanube no permite editar CSS libremente en todos los planes/temas (depende
del tema elegido y si tenés Tiendanube Plus con Theme Kit / API). Este documento
da la configuración para el **editor visual de temas** (todos los planes) y, al
final, la versión **CSS custom** por si tenés acceso a "Código HTML/CSS" del
tema o vas a personalizarlo con Theme Kit.

## 4.1 Elegir el tema base

Buscá en la galería de temas de Tiendanube uno:
- Minimalista, de fondo oscuro o neutro (no un tema con ilustraciones redondas
  ni iconografía de "pet shop" — huellitas, colores pastel).
- Con soporte de banner ancho en home y bloque de "features"/"beneficios" con
  íconos (para el bloque de tres pilares).
- Con footer configurable a varias columnas (para el bloque de "cara visible").

Temas recomendados como punto de partida (evaluar disponibilidad/gratuidad
actual en la galería, van cambiando): **Boost**, **Uptown**, **Kiu** — todos
minimalistas, sin estética infantil. Evitar temas etiquetados como "Pets" /
"Kids" en la galería.

## 4.2 Paleta de colores exacta

`Mi Tienda → Diseño → [tema activo] → Personalizar → Colores`

| Uso en el editor de Tiendanube | Color | Hex |
|---|---|---|
| Fondo general / fondo de secciones | Grafito | `#343434` |
| Encabezados, header, bloques de specs, portadas de categoría | Petróleo | `#1F4962` |
| Botones, precios, íconos activos | Verde | `#80B559` |
| Texto sobre fondo oscuro | Hueso | `#F2F3EF` |
| Texto secundario / aclaraciones | Gris dato | `#9A9A94` |

**Proporción a respetar visualmente en cada pantalla** (no es un ajuste que haga
el editor solo, hay que armar los bloques así): grafito ~60% de la superficie,
petróleo ~25%, verde ~15% máx como color de acento — nunca como fondo grande de
sección.

**Combinaciones prohibidas — revisar cada bloque del tema antes de publicar:**
- ❌ Texto blanco/hueso sobre fondo verde (contraste 2.42:1, ilegible). Si el
  tema trae botones con texto blanco por default sobre un color de acento,
  **cambiar el texto del botón a grafito** (`#343434`), no dejarlo en blanco.
- ❌ Texto petróleo sobre fondo grafito (1.30:1, ilegible) — es el mismo
  problema que tiene el isotipo; no lo repitas en textos del sitio.
- ❌ Verde como fondo de sección completa (hero, banner grande) — usarlo solo en
  botones, precios, íconos, badges chicos.
- ❌ Cualquier color fuera de la paleta, en particular rojo de "oferta" — si
  Tiendanube pide un color de "descuento/tachado", usar gris dato o verde, no
  rojo.

**Combinaciones que sí funcionan (contraste verificado):**
- Hueso sobre grafito → texto corrido, párrafos.
- Hueso sobre petróleo → encabezados de sección, specs.
- Verde sobre grafito → precios, botones con texto grafito, íconos.
- Grafito sobre verde → texto de botones verdes.

## 4.3 Tipografía

`Personalizar → Tipografía`

Si el tema permite Google Fonts (la mayoría lo permite):
- **Archivo** — peso 900 para títulos (H1/H2) y precios; 600 para subtítulos;
  400 para cuerpo/descripciones.
- **IBM Plex Mono** (400) — para specs, SKUs, códigos, datos técnicos. Si el
  editor de tema no permite una segunda tipografía para bloques específicos,
  usarla solo donde el tema sí lo permita (ej. bloque de texto libre en la
  ficha de producto) vía HTML custom si está disponible.

Si Archivo no aparece en el selector de fuentes del tema, usar en este orden:
**Archivo Narrow → Roboto Condensed → Helvetica Neue** (todas suelen estar
disponibles como Google Font o system font). Nunca serifas, nunca fuentes
redondeadas tipo Comic Sans/Quicksand.

Reglas de uso (aplicar al redactar cualquier texto del sitio, no solo al
tipografiar):
- Nunca más de dos pesos en una misma pieza (ej. un banner con 900 + 400, no
  sumar 600 también).
- Títulos en oración ("Traemos de afuera y te mostramos cómo funciona"), nunca
  en mayúsculas sostenidas.
- Interlineado 1.35 en títulos, 1.6 en cuerpo — configurar en "Espaciado" del
  editor si el tema lo expone; si no, es CSS custom (ver 4.6).

## 4.4 Home — bloques según sección 09 del manual

### Banner de promesa (hero superior)

- Fondo: grafito `#343434`.
- Texto: Archivo 900, hueso `#F2F3EF`.
- Copy: **"Traemos de afuera y te mostramos cómo funciona."**
- Botón: fondo verde `#80B559`, texto **grafito** `#343434` (nunca blanco) —
  ej. "Ver el collar GPS" o "Ver catálogo".

### Bloque de tres pilares

Tres columnas iguales, ícono + una sola línea de texto cada una. Usar íconos
Lucide/Feather (lineales, trazo 1.6px, sin relleno, un color: verde sobre
grafito o grafito sobre fondo claro):

| Ícono sugerido (Lucide) | Título | Línea |
|---|---|---|
| `package` / `plane` | Traemos | Lo importamos y lo probamos antes de ofrecerlo. |
| `play-circle` | Mostramos | Te mostramos cómo funciona con video real, no de catálogo. |
| `life-buoy` / `shield-check` | Respondemos | Si falla, lo resolvemos nosotros — 6 meses de garantía. |

### Destacados

- Máximo 4 productos (el collar GPS primero).
- Precio en verde `#80B559` sobre fondo grafito `#343434`.
- Sin badges rojos de "oferta" — si hay descuento, mostrarlo en gris dato o con
  el precio anterior tachado en gris, precio final en verde.

### Envíos y garantía (texto plano, visible en home o muy cerca de la compra)

> Envío a todo el país. Entrega en moto en Resistencia (mismo día o 24hs
> hábiles). Garantía de 6 meses, la que fija la ley: si el producto falla, lo
> resolvemos nosotros.

Sin letra chica, sin asterisco escondido — el texto completo, visible.

### Cara visible (footer)

Columna o bloque fijo del footer con:
- Nombre de la persona/marca visible (no solo "JOPEX" genérico — según el
  manual, sin esto "la tienda es una más").
- Foto (si hay una disponible; si no, usar el isotipo monocroma como placeholder
  temporal, no dejarlo vacío).
- WhatsApp de contacto directo (número/link `wa.me`).
- Ubicación: Resistencia, Chaco.

## 4.5 Uso del isotipo/logo

- **Favicon** (Tiendanube pide un ícono cuadrado chico): isotipo **monocroma**
  (un solo color, fondo calado) — es la versión pensada para <40px.
- **Header del sitio**: ver recomendación en `README.md` — mientras no exista
  lockup ni versión vectorial, usar un **wordmark de texto** "JOPEX" en Archivo
  900 (hueso sobre grafito/petróleo) en vez del isotipo solo. Si preferís usar
  el isotipo igual, la versión mínima aceptable ahí es la de **contraste alto**
  (`#4F96BE` en vez de petróleo) a un tamaño ≥80px, nunca la principal a menos
  de 80px.
- **Redes/avatar de reputación**: isotipo contraste alto, 40–80px.
- Margen de seguridad en cualquier uso: 25% del diámetro del isotipo libre
  alrededor.
- No estirar, rotar, ni recolorear el isotipo fuera de las tres versiones
  definidas.

## 4.6 Iconografía general del sitio

- Librería: **Lucide** o **Feather**.
- Grilla 24×24px, trazo 1.6px, extremos redondeados, sin relleno/sombra/degradado.
- Un solo color por ícono: verde `#80B559` sobre fondo oscuro, grafito `#343434`
  sobre fondo claro.
- Sin emojis en piezas de marca (banner, fichas, footer). Emojis solo en
  WhatsApp/Instagram, con moderación (máx. 2 por pieza si se usan ahí).

## 4.7 Si tenés acceso a CSS custom (Theme Kit / tema con editor de código)

```css
:root {
  --jpx-grafito: #343434;
  --jpx-petroleo: #1F4962;
  --jpx-verde: #80B559;
  --jpx-hueso: #F2F3EF;
  --jpx-gris-dato: #9A9A94;
  --jpx-petroleo-alto: #4F96BE; /* solo dentro del logo, no usar como color de marca */
}

body {
  background-color: var(--jpx-grafito);
  color: var(--jpx-hueso);
  font-family: "Archivo", "Archivo Narrow", "Roboto Condensed", "Helvetica Neue", sans-serif;
  line-height: 1.6;
}

h1, h2, h3, .price {
  font-family: "Archivo", "Archivo Narrow", "Roboto Condensed", sans-serif;
  font-weight: 900;
  line-height: 1.35;
  text-transform: none; /* nunca mayúsculas sostenidas */
}

.subtitle { font-weight: 600; }

.specs, .sku, code, .mono {
  font-family: "IBM Plex Mono", monospace;
  color: var(--jpx-gris-dato);
}

.btn-primary {
  background-color: var(--jpx-verde);
  color: var(--jpx-grafito); /* nunca blanco/hueso sobre verde */
}

.price { color: var(--jpx-verde); }

/* Nunca: petróleo como color de texto sobre fondo grafito */
/* Nunca: verde como background de secciones grandes (hero, banner ancho) */
```

## Lo que hacés vos

- Elegir el tema definitivo de la galería y activarlo.
- Cargar estos valores en el editor visual (colores, tipografía, textos de
  banner/pilares/footer).
- Subir las fotos/isotipo en los tamaños indicados.
- Decidir si esperar el lockup vectorial antes de publicar el header, o arrancar
  con el wordmark de texto — te recomiendo lo segundo para no bloquear el
  lanzamiento.
