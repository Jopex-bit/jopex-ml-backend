const express = require('express');
const axios = require('axios');

// ---------------------------------------------------------------------------
// GET /api/competencia?urls=<link1>,<link2>,...
//   (también acepta ?url=<link> para una sola)
//
// Resuelve links de publicaciones de Mercado Libre y devuelve los datos que
// sirven para decidir si conviene traer un producto:
//   precio, unidades vendidas, stock, cuotas y si son sin interés,
//   envío gratis, tipo de publicación (Clásica/Premium) y reviews (estrellas).
//
// Soporta tres formas de link:
//   1) Publicación directa:  https://articulo.mercadolibre.com.ar/MLA-123456789-titulo-_JM
//   2) ID pelado:            MLA123456789
//   3) Catálogo:             https://www.mercadolibre.com.ar/producto/p/MLA123456789
//      (el catálogo NO es una publicación: se resuelve al ganador del catálogo)
// ---------------------------------------------------------------------------

// Extrae el ID de una URL de ML. Devuelve {id, esCatalogo} o null si no se pudo.
function extraerId(entrada) {
  if (!entrada) return null;
  const texto = String(entrada).trim();

  // Catálogo: /producto/p/MLA123 o /p/MLA123
  const cat = texto.match(/\/p\/(ML[A-Z]?\d+)/i);
  if (cat) return { id: cat[1].toUpperCase(), esCatalogo: true };

  // Publicación con guion: MLA-123456789-titulo
  const conGuion = texto.match(/(ML[A-Z])-(\d{6,})/i);
  if (conGuion) return { id: (conGuion[1] + conGuion[2]).toUpperCase(), esCatalogo: false };

  // ID pelado: MLA123456789
  const pelado = texto.match(/\b(ML[A-Z]\d{6,})\b/i);
  if (pelado) return { id: pelado[1].toUpperCase(), esCatalogo: false };

  return null;
}

// Nombre legible del tipo de publicación (define comisión y cuotas sin interés).
function tipoPublicacion(listingTypeId) {
  const mapa = {
    gold_pro: 'Premium',
    gold_special: 'Clásica',
    gold: 'Oro',
    silver: 'Plata',
    bronze: 'Bronce',
    free: 'Gratuita',
  };
  return mapa[listingTypeId] || listingTypeId || null;
}

module.exports = (app) => {
  const router = express.Router();

  router.get('/', async (req, res) => {
    const crudo = req.query.urls || req.query.url || '';
    const entradas = String(crudo)
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean);

    if (!entradas.length) {
      return res.status(400).json({
        error: 'Falta el parámetro "urls" (o "url") con el link de la publicación.',
      });
    }
    if (entradas.length > 20) {
      return res.status(400).json({ error: 'Máximo 20 publicaciones por consulta.' });
    }

    // Resolvemos los IDs y separamos los que no se pudieron interpretar.
    const resueltos = [];
    const noResueltos = [];
    entradas.forEach((e) => {
      const r = extraerId(e);
      if (r) resueltos.push({ ...r, entrada: e });
      else noResueltos.push({ entrada: e, error: 'No se pudo extraer el ID de Mercado Libre del link.' });
    });

    if (!resueltos.length) {
      return res.json({ publicaciones: [], errores: noResueltos, resumen: null });
    }

    try {
      const token = await app.locals.getAccessTokenValido();
      const auth = { headers: { Authorization: `Bearer ${token}` } };
      const API = app.locals.ML_API;

      // --- Paso 1: los links de catálogo hay que resolverlos a la publicación ganadora
      const catalogos = resueltos.filter((r) => r.esCatalogo);
      await Promise.all(
        catalogos.map(async (c) => {
          try {
            const r = await axios.get(`${API}/products/${c.id}`, auth);
            const ganador = r.data?.buy_box_winner?.item_id;
            if (ganador) {
              c.itemId = ganador;
              c.notaCatalogo = 'Link de catálogo: se usó la publicación ganadora del catálogo.';
            } else {
              c.errorCatalogo = 'Es un link de catálogo y no tiene publicación ganadora disponible.';
            }
          } catch (e) {
            c.errorCatalogo = 'No se pudo resolver el link de catálogo.';
          }
        })
      );

      const conItem = resueltos.filter((r) => (r.esCatalogo ? r.itemId : true));
      resueltos
        .filter((r) => r.esCatalogo && r.errorCatalogo)
        .forEach((r) => noResueltos.push({ entrada: r.entrada, error: r.errorCatalogo }));

      const ids = conItem.map((r) => (r.esCatalogo ? r.itemId : r.id));
      if (!ids.length) {
        return res.json({ publicaciones: [], errores: noResueltos, resumen: null });
      }

      // --- Paso 2: traer el detalle de las publicaciones (multiget, de a 20)
      const detalles = [];
      for (let i = 0; i < ids.length; i += 20) {
        const chunk = ids.slice(i, i + 20);
        const resp = await axios.get(`${API}/items`, {
          ...auth,
          params: { ids: chunk.join(',') },
        });
        resp.data.forEach((d) => detalles.push(d));
      }

      // --- Paso 3: reviews (estrellas y cantidad de opiniones).
      // Es "best effort": si ML no lo devuelve, seguimos sin romper la respuesta.
      const reviewsPorId = {};
      await Promise.all(
        ids.map(async (id) => {
          try {
            const r = await axios.get(`${API}/reviews/item/${id}`, { ...auth, timeout: 8000 });
            reviewsPorId[id] = {
              estrellas: r.data?.rating_average ?? null,
              cantidad: r.data?.paging?.total ?? r.data?.total ?? null,
            };
          } catch (e) {
            reviewsPorId[id] = { estrellas: null, cantidad: null, no_disponible: true };
          }
        })
      );

      // --- Paso 4: armar la respuesta simplificada
      const publicaciones = [];
      detalles.forEach((d) => {
        if (d.code !== 200 || !d.body) {
          noResueltos.push({ entrada: d.body?.id || 'desconocido', error: 'Publicación no accesible.' });
          return;
        }
        const b = d.body;
        const cuotas = b.installments || null;
        const origen = conItem.find((r) => (r.esCatalogo ? r.itemId : r.id) === b.id);
        const rev = reviewsPorId[b.id] || {};

        publicaciones.push({
          id: b.id,
          titulo: b.title,
          permalink: b.permalink,
          precio: b.price,
          precio_original: b.original_price || null,
          moneda: b.currency_id,
          vendidos: b.sold_quantity,
          stock_disponible: b.available_quantity,
          estado: b.status,
          condicion: b.condition,
          cuotas: cuotas
            ? {
                cantidad: cuotas.quantity,
                monto: cuotas.amount,
                sin_interes: cuotas.rate === 0,
                tasa: cuotas.rate,
              }
            : null,
          envio_gratis: Boolean(b.shipping?.free_shipping),
          tipo_publicacion: tipoPublicacion(b.listing_type_id),
          catalogo: Boolean(b.catalog_listing),
          reviews: { estrellas: rev.estrellas ?? null, cantidad: rev.cantidad ?? null },
          nota: origen?.notaCatalogo || null,
          consultado_en: new Date().toISOString(),
        });
      });

      // --- Paso 5: resumen del rango de precios del mercado
      const precios = publicaciones.map((p) => p.precio).filter((n) => typeof n === 'number' && n > 0);
      let resumen = null;
      if (precios.length) {
        const suma = precios.reduce((a, b) => a + b, 0);
        const ordenados = precios.slice().sort((a, b) => a - b);
        const medio = Math.floor(ordenados.length / 2);
        resumen = {
          cantidad: precios.length,
          precio_min: ordenados[0],
          precio_max: ordenados[ordenados.length - 1],
          precio_promedio: suma / precios.length,
          precio_mediana:
            ordenados.length % 2 ? ordenados[medio] : (ordenados[medio - 1] + ordenados[medio]) / 2,
          vendidos_total: publicaciones.reduce((a, p) => a + (p.vendidos || 0), 0),
        };
      }

      res.json({ publicaciones, errores: noResueltos, resumen });
    } catch (err) {
      console.error(err.response?.data || err.message);
      res.status(500).json({
        error: 'No se pudieron obtener los datos de la competencia.',
        detalle: err.response?.data || err.message,
      });
    }
  });

  return router;
};

// Exportamos el parser para poder testearlo aparte.
module.exports.extraerId = extraerId;
