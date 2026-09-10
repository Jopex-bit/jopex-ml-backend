# 3. Fichas de producto — catálogo inicial (<50 productos)

No tengo la lista real de los productos del catálogo (solo sé que el collar GPS
es el destacado). Este documento trae:

1. Una **ficha modelo completa** para el collar GPS, lista para copiar/pegar en
   Tiendanube.
2. Una **plantilla** para replicar en cada uno de los otros productos.
3. Las reglas de tono y de fotografía/video que aplican a todo el catálogo.

Pasame el listado real (nombre, precio, variantes, stock) cuando lo tengas y te
devuelvo las ~50 fichas ya redactadas con esta misma estructura.

## Reglas que aplican a TODAS las fichas

- Voseo siempre. Sin diminutivos ("collarcito"), sin superlativos
  ("el mejor", "increíble").
- Precio **siempre visible**. Nunca "consultar precio".
- Envío siempre aclarado en la ficha (zona, costo, plazo) — no solo en una página
  aparte de políticas.
- Toda limitación del producto se dice **antes** de vender, no en la letra chica
  de una FAQ.
- Máximo 2 emojis por ficha (y solo si suman, no de relleno).
- Palabras prohibidas: premium, exclusivo, gama alta, increíble, espectacular,
  revolucionario, "última oportunidad", "no te lo pierdas", "amigos/familia
  JOPEX", "100% garantizado".
- Vocabulario propio a usar cuando aplique: "lo probamos", "te muestro cómo
  funciona", "te lo dejo configurado", "si falla, lo resolvemos", "entrego en
  mano".
- Interlineado del cuerpo de texto 1.6 (configuración de tema, no de la ficha en
  sí — ver `04-diseno-branding.md`).

## Secuencia fija de 7 imágenes (obligatoria por producto)

1. Producto solo, fondo **grafito** (`#343434`).
2. En uso, con mascota real (no stock genérico).
3. Contenido de la caja.
4. Detalle técnico (textura, conector, material).
5. Escala junto a un objeto conocido (moneda, mano, taza).
6. Placa de especificaciones: fondo **petróleo** (`#1F4962`), texto **hueso**
   (`#F2F3EF`), datos técnicos en **IBM Plex Mono**.
7. Placa de respaldo: *"Garantía 6 meses · Entrega en Resistencia · Instructivo
   incluido"* — texto **verde** (`#80B559`) sobre fondo **grafito**.

**Regla dura:** si no hay video de uso real (30s: problema → producto
funcionando → resultado → placa final con logo y garantía), el producto **no se
publica**. Esto aplica también al collar GPS aunque sea el destacado — sin
video, no sale a la vidriera principal.

---

## Ficha modelo — Collar rastreador GPS para perros (producto destacado)

**Categoría:** Mascotas → Rastreo y seguridad

**Título** (oración, no mayúsculas sostenidas):
> Collar rastreador GPS para perros

**Precio:** *(cargar precio real — siempre visible, nunca "consultar")*

**Descripción corta** (debajo del título, 1-2 líneas):
> Lo probamos en la calle y en el patio: ubicación en tiempo real desde el
> celular, sin depender de que el perro se quede quieto.

**Descripción larga:**
> Lo trajimos porque nos pasó lo mismo que a vos: un perro que se escapa y no
> sabés por dónde arrancar a buscarlo. Este collar manda la ubicación al
> celular en tiempo real, así que en vez de recorrer el barrio a ciegas, vas
> directo.
>
> Te lo dejamos configurado antes de mandarlo: cuando llega, lo cargás, lo
> emparejás con la app y ya está funcionando. Si en algún momento no te anda,
> nos escribís y lo resolvemos — no te vamos a mandar a hablar con la fábrica
> en China.
>
> **Lo que necesitás saber antes de comprar:**
> - Necesita señal de red celular (chip/datos) para reportar ubicación fuera del
>   wifi de casa — el costo del chip no está incluido.
> - Autonomía de batería: *(dato real — completar)*.
> - Resistencia al agua: *(IP real del producto — completar, no poner "sumergible"
>   si no lo es)*.

**Specs (bloque en IBM Plex Mono, sobre placa petróleo/hueso — imagen 6):**
```
Alcance GPS:        (completar)
Batería:             (completar) — autonomía en uso normal
Resistencia agua:    IP(completar)
Conectividad:        (2G/4G/GPS — completar según modelo real)
Peso:                (completar)
Talles de collar:    (completar, ej. ajustable 20–55cm)
App:                 Android / iOS (completar compatibilidad real)
```

**Envío y garantía (texto plano, sin letra chica):**
> Envío a todo el país por Correo Argentino / Andreani. En Resistencia,
> entrega en moto el mismo día o al día siguiente hábil, con costo de envío
> local aparte. Garantía de 6 meses, la que fija la ley (Ley 24.240, art. 11):
> si el producto falla, lo resolvemos nosotros, no el fabricante.

**Placa de respaldo (imagen 7):**
> Garantía 6 meses · Entrega en Resistencia · Instructivo incluido

**SKU / código interno:** *(completar, en formato mono, ej. `JPX-GPS-001`)*

**Variantes sugeridas:** color de collar / talle (si el proveedor las ofrece) —
no inventar variantes que no existan en stock real.

**Tags para buscador interno:** collar gps, rastreador perro, ubicación mascota,
localizador mascota, antifugas perro.

---

## Plantilla para el resto del catálogo (<50 productos)

Copiar esta estructura por producto:

```
Categoría: [subcategoría dentro de Mascotas]

Título: [nombre en oración, sin mayúsculas sostenidas, sin "premium/exclusivo"]

Precio: [$ ARS, siempre visible]

Descripción corta (1-2 líneas, voseo, sin diminutivos):
[qué problema resuelve, en la voz de "lo probamos / te muestro cómo funciona"]

Descripción larga:
[contexto de uso + qué trae la caja + qué pasa si falla]
[limitaciones reales del producto ANTES de la sección de compra]

Specs (mono):
[lista clave-valor con datos reales del producto — nunca inventar specs]

Envío y garantía:
[mismo texto base de envío que el collar GPS, adaptado si el producto tiene
restricciones de envío propias — ej. productos frágiles, voluminosos]

Placa de respaldo:
Garantía 6 meses · Entrega en Resistencia · Instructivo incluido

SKU: [código interno, formato JPX-XXX-000]

Fotos: 7 imágenes según secuencia fija (ver arriba)
Video: 30s obligatorio antes de publicar
```

## Lo que hacés vos

- Pasarme el listado real de productos (nombre, precio, specs reales, stock,
  proveedor) para redactar las ~50 fichas.
- Sacar/organizar las fotos y el video de cada producto (secuencia fija de 7 +
  video de 30s) — esto no lo puedo generar yo, son fotos/video reales del
  producto.
- Cargar las fichas en el panel de Tiendanube (yo te dejo el texto listo para
  copiar, no tengo acceso al panel).
