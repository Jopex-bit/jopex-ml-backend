const express = require('express');
const axios = require('axios');

// ---------------------------------------------------------------------------
// GET /api/costos
//
// Devuelve, para CADA publicación activa, todo lo que el módulo Costos del
// panel cargaba a mano:
//
//   cargo_venta_pct   -> comisión pura de ML          (meli_percentage_fee)
//   financiacion_pct  -> costo por cuotas             (financing_add_on_fee)
//   cargo_fijo        -> cargo fijo por unidad        (fixed_fee)
//   envio_ml          -> costo de envío del vendedor  (list_cost, ya con descuento)
//   promocion         -> promo APLICADA, con % y fecha de fin
//   promo_disponible  -> promo OFRECIDA que todavía no aplicaste
//
// Lo único que NO sale de acá es el costo del producto (valor de adquisición):
// ese lo ponés vos desde el módulo Investigación, eligiendo el proveedor.
//
// Parámetros opcionales:
//   ?limit=50   cuántas publicaciones traer (por defecto 50)
//   ?item=MLA1  analizar una sola publicación
// ---------------------------------------------------------------------------

module.exports = (app) => {
  const router = express.Router();

  // Corre las promesas de a tandas para no golpear la API de ML de una sola vez.
  async function enTandas(lista, tam, fn) {
    const out = [];
    for (let i = 0; i < lista.length; i += tam) {
      const t = await Promise.all(lista.slice(i, i + tam).map(fn));
      out.push(...t);
    }
    return out;
  }

  const soloFecha = (s) => (typeof s === 'string' && s.length >= 10 ? s.slice(0, 10) : null);

  router.get('/', async (req, res) => {
    try {
      const token = await app.locals.getAccessTokenValido();
      const tokens = app.locals.leerTokens();
      const API = app.locals.ML_API;
      const auth = { headers: { Authorization: `Bearer ${token}` } };
      const uid = tokens.user_id;
      const limit = Math.min(Number(req.query.limit) || 50, 100);

      // ---- 1) Qué publicaciones analizar ----
      let ids;
      if (req.query.item) {
        ids = [String(req.query.item).toUpperCase()];
      } else {
        const busq = await axios.get(`${API}/users/${uid}/items/search`, {
          ...auth,
          params: { status: 'active', limit },
        });
        ids = busq.data.results || [];
      }
      if (!ids.length) return res.json({ productos: [], campanas: [], generado_en: new Date().toISOString() });

      // ---- 2) Detalle de las publicaciones (multiget de a 20) ----
      const detalles = [];
      for (let i = 0; i < ids.length; i += 20) {
        const r = await axios.get(`${API}/items`, {
          ...auth,
          params: { ids: ids.slice(i, i + 20).join(',') },
        });
        r.data.forEach((d) => {
          if (d.code === 200 && d.body) detalles.push(d.body);
        });
      }

      // ---- 3) Campañas activas del vendedor (para nombrar las promos) ----
      let campanas = [];
      try {
        const r = await axios.get(`${API}/seller-promotions/users/${uid}`, {
          ...auth,
          params: { app_version: 'v2' },
        });
        const lista = Array.isArray(r.data) ? r.data : r.data?.results || [];
        campanas = lista.map((c) => ({
          id: c.id,
          nombre: c.name || c.type,
          tipo: c.type,
          estado: c.status,
          desde: soloFecha(c.start_date),
          hasta: soloFecha(c.finish_date),
        }));
      } catch (e) {
        campanas = [];
      }

      // ---- 4) Por cada publicación: comisión + envío + promociones ----
      const productos = await enTandas(detalles, 4, async (b) => {
        const p = {
          ml_item_id: b.id,
          titulo: b.title,
          precio: b.price,
          categoria: b.category_id,
          listing_type_id: b.listing_type_id,
          tipo_publicacion: b.listing_type_id === 'gold_pro' ? 'Premium' : 'Clásica',
          logistic_type: b.shipping?.logistic_type || null,
          envio_gratis: Boolean(b.shipping?.free_shipping),
          stock: b.available_quantity,
          vendidos: b.sold_quantity,
          // valores para el módulo Costos
          cargo_venta_pct: null,
          financiacion_pct: null,
          cargo_fijo: null,
          comision_total: null,
          envio_ml: null,
          promocion: null,
          promo_disponible: null,
          avisos: [],
        };

        // --- Comisión y financiación (vienen juntas en el mismo llamado) ---
        try {
          const r = await axios.get(`${API}/sites/MLA/listing_prices`, {
            ...auth,
            params: { price: b.price, category_id: b.category_id, listing_type_id: b.listing_type_id },
          });
          const d = Array.isArray(r.data) ? r.data[0] : r.data;
          const det = d?.sale_fee_details || {};
          // percentage_fee = meli_percentage_fee + financing_add_on_fee
          p.cargo_venta_pct = det.meli_percentage_fee ?? det.percentage_fee ?? null;
          p.financiacion_pct = det.financing_add_on_fee ?? 0;
          p.cargo_fijo = det.fixed_fee ?? 0;
          p.comision_total = d?.sale_fee_amount ?? null;
        } catch (e) {
          p.avisos.push('No se pudo leer la comisión: ' + (e.response?.data?.message || e.message));
        }

        // --- Costo de envío que paga el vendedor ---
        try {
          const params = {
            item_id: b.id,
            item_price: b.price,
            listing_type_id: b.listing_type_id,
            mode: 'me2',
            condition: b.condition || 'new',
            logistic_type: b.shipping?.logistic_type || 'drop_off',
            verbose: true,
          };
          if (b.shipping?.dimensions) params.dimensions = b.shipping.dimensions;
          const r = await axios.get(`${API}/users/${uid}/shipping_options/free`, { ...auth, params });
          const cob = r.data?.coverage?.all_country || {};
          p.envio_ml = cob.list_cost ?? null;
          p.envio_detalle = {
            peso_facturable: cob.billable_weight ?? null,
            descuento_rate: cob.discount?.rate ?? null,
            sin_descuento: cob.discount?.promoted_amount ?? null,
          };
        } catch (e) {
          p.avisos.push('No se pudo calcular el envío: ' + (e.response?.data?.message || e.message));
        }

        // --- Promociones: aplicada (started) vs ofrecida (candidate) ---
        try {
          const r = await axios.get(`${API}/seller-promotions/items/${b.id}`, {
            ...auth,
            params: { app_version: 'v2' },
          });
          const lista = Array.isArray(r.data) ? r.data : r.data?.results || [];

          const pct = (orig, promo) =>
            orig > 0 && promo > 0 ? Number((((orig - promo) / orig) * 100).toFixed(2)) : null;

          const activa = lista.find((x) => x.status === 'started' && x.price > 0);
          if (activa) {
            const orig = activa.original_price ?? b.price;
            p.promocion = {
              tipo: activa.type,
              precio_promo: activa.price,
              precio_original: orig,
              descuento_pct: pct(orig, activa.price),
              desde: soloFecha(activa.start_date),
              hasta: soloFecha(activa.finish_date),
              campana: activa.name || null,
            };
          }

          const candidata = lista.find((x) => x.status === 'candidate');
          if (candidata) {
            const sug = candidata.suggested_discounted_price ?? candidata.max_discounted_price ?? null;
            const orig = candidata.original_price ?? b.price;
            p.promo_disponible = {
              tipo: candidata.type,
              precio_sugerido: sug,
              descuento_sugerido_pct: sug ? pct(orig, sug) : null,
              precio_min_permitido: candidata.min_discounted_price ?? null,
              precio_max_permitido: candidata.max_discounted_price ?? null,
              nota: 'Mercado Libre ofrece esta promoción pero todavía no la aplicaste.',
            };
          }
        } catch (e) {
          p.avisos.push('No se pudieron leer las promociones: ' + (e.response?.data?.message || e.message));
        }

        return p;
      });

      res.json({
        generado_en: new Date().toISOString(),
        cantidad: productos.length,
        campanas,
        productos,
      });
    } catch (err) {
      console.error(err.response?.data || err.message);
      res.status(500).json({
        error: 'No se pudieron obtener los costos.',
        detalle: err.response?.data || err.message,
      });
    }
  });

  return router;
};
