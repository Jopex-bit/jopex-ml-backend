# JOPEX — Tienda online en Tiendanube (jopexarg.com)

Set de guías para poner en marcha la tienda de JOPEX en Tiendanube, aplicando el
manual de marca v2 (agosto 2026). Están pensadas para que **vos** ejecutes los pasos
en los paneles de GoDaddy y Tiendanube (login, credenciales, confirmaciones), y las
uses como checklist/copy-paste.

## Índice

1. [`01-dominio-dns.md`](./01-dominio-dns.md) — Conectar jopexarg.com (GoDaddy) a Tiendanube.
2. [`02-configuracion-tienda.md`](./02-configuracion-tienda.md) — Checklist de configuración inicial: negocio, moneda, categorías, pagos, envíos (incluye moto local).
3. [`03-fichas-producto.md`](./03-fichas-producto.md) — Cómo armar las fichas del catálogo (<50 productos), con el collar GPS como ficha modelo completa.
4. [`04-diseno-branding.md`](./04-diseno-branding.md) — Aplicación del manual de marca al tema de Tiendanube: paleta, tipografía, banner de promesa, tres pilares, destacados, cara visible, uso del isotipo.
5. [`05-verificacion-final.md`](./05-verificacion-final.md) — QA final antes de publicar: DNS, pagos, envíos, marca, producto destacado.

## Fuera de alcance (lo hacés vos)

- Login en GoDaddy y Tiendanube.
- Carga de credenciales, tokens de pago (Mercado Pago) y datos fiscales.
- Confirmación de cambios de DNS y publicación final de la tienda.
- Vectorización del logo y definición del lockup con un diseñador.

## Estado del logo (importante, leer antes de tocar el header)

El isotipo actual **no está listo para producción sin salvedades**:
- Es un PNG (IA), sin versión vectorial → se va a ver mal escalado en pantallas de alta densidad o impreso grande.
- No existe logotipo: la palabra "JOPEX" no aparece en ningún lado, solo el isotipo.
- El trazo petróleo sobre grafito tiene contraste 1.30:1 → a menos de 80px el logo se rompe visualmente si se usa la versión principal.

**Recomendación:** no poner el isotipo solo en el header del sitio (ahí el nombre de
la tienda no siempre alcanza para identificar la marca a un visitante nuevo, a
diferencia de una foto de perfil de red social). Usar mientras tanto un **lockup de
texto simple** — "JOPEX" en Archivo 900, hueso sobre grafito o petróleo — como
header, y reservar el isotipo (versión contraste alto, 40–80px) para el favicon y
avatar de reputación. Encargar el vector + lockup definitivo a un diseñador antes de
la campaña de lanzamiento fuerte; no es bloqueante para abrir la tienda.
