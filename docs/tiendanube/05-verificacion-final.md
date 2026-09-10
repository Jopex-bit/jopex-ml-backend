# 5. Verificación final antes de publicar

Recorré esta checklist con la tienda ya configurada, antes de anunciarla o
mandar tráfico. Marcá cada ítem vos mismo (login/paneles no los tengo).

## Dominio / DNS

- [ ] `dig jopexarg.com` (o https://dnschecker.org) devuelve la IP/CNAME de
      Tiendanube en la mayoría de las ubicaciones.
- [ ] `https://jopexarg.com` carga la tienda (candado verde, SSL activo).
- [ ] `https://www.jopexarg.com` redirige correctamente al dominio principal
      elegido (o viceversa) — un solo dominio canónico.
- [ ] Si tenías casillas de email `@jopexarg.com`, el correo sigue funcionando
      después del cambio de DNS (mandate un mail de prueba).

## Pagos

- [ ] Compra de prueba con Mercado Pago (tarjeta de prueba o monto mínimo real)
      llega a "aprobado" y genera el pedido en el panel de Tiendanube.
- [ ] Los medios habilitados en el checkout coinciden con los que activaste
      (tarjetas, dinero en cuenta, efectivo si corresponde).
- [ ] Las cuotas mostradas (si activaste cuotas sin interés) no perforan el
      margen del producto — revisar contra costo real, en especial el collar
      GPS.

## Envíos

- [ ] Simular checkout con una dirección de Resistencia → aparece la opción
      "Entrega en moto" con el costo y plazo correctos.
- [ ] Simular checkout con una dirección de otra provincia → aparecen
      Correo Argentino / Andreani-OCA, con costos calculados razonables.
- [ ] El texto de plazos/costos en la ficha y en el checkout coincide (no hay
      contradicción entre lo que promete la ficha y lo que cobra el checkout).

## Marca — paleta y tipografía

- [ ] Home, categoría y ficha de producto usan grafito como fondo dominante
      (~60%), petróleo en estructura (~25%), verde solo como acento (~15% máx).
- [ ] Ningún botón ni bloque tiene texto blanco/hueso sobre fondo verde.
- [ ] Ningún texto usa petróleo sobre fondo grafito.
- [ ] No hay rojo ni colores fuera de la paleta en ningún badge/oferta.
- [ ] Títulos en Archivo 900 (o el sustituto definido), en oración — sin
      mayúsculas sostenidas.
- [ ] Specs/SKUs en IBM Plex Mono (o quedaron en el peso/tipografía secundaria
      definida si el tema no soporta una segunda fuente).
- [ ] No hay huellitas, íconos redondeados tipo pet-shop, ni tono infantil en
      ningún bloque del tema (revisar también las imágenes que trae el tema por
      default — reemplazar cualquier placeholder con esa estética).

## Bloques de la sección 09 (home)

- [ ] Banner de promesa presente, con el copy correcto y botón verde con texto
      grafito.
- [ ] Bloque de tres pilares (traemos / mostramos / respondemos) visible antes
      del scroll fold si es posible.
- [ ] Destacados: máximo 4 productos, collar GPS incluido y en primer lugar,
      precio en verde sobre grafito.
- [ ] Envíos y garantía en texto plano, visible, sin letra chica.
- [ ] Footer con cara visible: nombre, foto/isotipo, WhatsApp, Resistencia-Chaco.

## Producto destacado (collar GPS)

- [ ] Las 7 imágenes están cargadas, en el orden de la secuencia fija.
- [ ] El video de uso real (30s) está embebido en la ficha.
- [ ] Precio visible, specs reales (no placeholders de la plantilla).
- [ ] Texto de envío y garantía presente en la ficha, no solo en una página
      aparte.
- [ ] Se ve bien tanto en desktop como en celular (la mayoría del tráfico va a
      venir de mobile, según el público objetivo).

## Voz y tono (pasada de lectura sobre todo el sitio)

- [ ] Sin ninguna de las palabras prohibidas (premium, exclusivo, gama alta,
      increíble, espectacular, revolucionario, "última oportunidad", "no te lo
      pierdas", "amigos/familia JOPEX", "100% garantizado").
- [ ] Voseo consistente en todos los textos.
- [ ] Cero precios en "a consultar".

## Logo

- [ ] Favicon = isotipo monocroma.
- [ ] Header resuelto con wordmark de texto o isotipo contraste alto ≥80px (no
      la versión principal a tamaño chico, no el isotipo solo por debajo de
      40px salvo en monocroma).

## Post-lanzamiento (no bloquea publicar, pero anotarlo)

- [ ] Encargar a un diseñador: vectorización del isotipo + lockup con la
      palabra JOPEX.
- [ ] Una vez resuelto eso, reemplazar el wordmark de texto del header por el
      lockup definitivo.
