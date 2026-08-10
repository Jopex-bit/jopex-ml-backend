const express = require('express');
const axios = require('axios');

// ---------------------------------------------------------------------------
// GET /api/diagnostico            -> usa tu primera publicación activa
// GET /api/diagnostico?item=MLA123456789
//
// Prueba, contra TU cuenta real, qué datos de costos expone la API de ML.
// No modifica nada: solo consulta y reporta qué funcionó y qué no, para
// decidir qué se puede automatizar en el módulo Costos y qué queda manual.
//
// Prueba 4 capacidades:
//   1) Comisión / cargo por venta   (el "simulador de costos")
//   2) Promociones vigentes + fecha de fin
//   3) Costo de envío que paga el vendedor
//   4) Costo de financiación (cuotas)
// ---------------------------------------------------------------------------

module.exports = (app) => {
  const router = express.Router();

  router.get('/', async (req, res) => {
    const reporte = { item: null, pruebas: {}, resumen: {} };

    const probar = async (nombre, fn) => {
      try {
        const r = await fn();
        reporte.pruebas[nombre] = { ok: true, ...r };
        reporte.resumen[nombre] = 'OK';
      } catch (e) {
        const detalle = e.response?.data;
        reporte.pruebas[nombre] = {
          ok: false,
          status: e.response?.status || null,
          error: detalle?.message || detalle?.error || e.message,
          endpoint_probado: e.config?.url || null,
        };
        reporte.resumen[nombre] = 'FALLÓ (' + (e.response?.status || 'sin status') + ')';
      }
    };

    try {
      const token = await app.locals.getAccessTokenValido();
      const tokens = app.locals.leerTokens();
      const API = app.locals.ML_API;
      const auth = { headers: { Authorization: `Bearer ${token}` } };
      const uid = tokens.user_id;

      // ---- Elegir la publicación a analizar ----
      let itemId = req.query.item;
      if (!itemId) {
        const busq = await axios.get(`${API}/users/${uid}/items/search`, {
          ...auth,
          params: { status: 'active', limit: 1 },
        });
        itemId = busq.data.results && busq.data.results[0];
      }
      if (!itemId) return res.status(404).json({ error: 'No se encontró ninguna publicación activa.' });

      // ---- Datos base de la publicación ----
      const it = await axios.get(`${API}/items/${itemId}`, auth);
      const b = it.data;
      reporte.item = {
        id: b.id,
        titulo: b.title,
        precio: b.price,
        categoria: b.category_id,
        listing_type_id: b.listing_type_id,
        envio_gratis: Boolean(b.shipping?.free_shipping),
        logistic_type: b.shipping?.logistic_type || null,
        modo_envio: b.shipping?.mode || null,
        dimensiones_declaradas: b.shipping?.dimensions || null,
        cuotas_que_ve_el_comprador: b.installments || null,
      };

      // ---- 1) COMISIÓN (cargo por venta) ----
      await probar('comision', async () => {
        const r = await axios.get(`${API}/sites/MLA/listing_prices`, {
          ...auth,
          params: {
            price: b.price,
            category_id: b.category_id,
            listing_type_id: b.listing_type_id,
          },
        });
        const d = Array.isArray(r.data) ? r.data[0] : r.data;
        return {
          comision_total: d?.sale_fee_amount ?? null,
          porcentaje: d?.sale_fee_details?.percentage_fee ?? null,
          cargo_fijo: d?.sale_fee_details?.fixed_fee ?? null,
          detalle_crudo: d?.sale_fee_details ?? null,
        };
      });

      // ---- 2) PROMOCIONES vigentes ----
      await probar('promociones', async () => {
        const r = await axios.get(`${API}/seller-promotions/items/${itemId}`, {
          ...auth,
          params: { app_version: 'v2' },
        });
        const lista = Array.isArray(r.data) ? r.data : r.data?.results || [];
        return {
          cantidad: lista.length,
          promociones: lista.map((p) => ({
            tipo: p.type || p.promotion_type || null,
            precio_promo: p.price ?? p.deal_price ?? null,
            precio_original: p.original_price ?? null,
            descuento_pct: p.discount_percentage ?? null,
            desde: p.start_date || null,
            hasta: p.finish_date || p.end_date || null,
            estado: p.status || null,
          })),
          crudo: lista.length ? lista[0] : null,
        };
      });

      // ---- 3) COSTO DE ENVÍO que paga el vendedor ----
      await probar('envio', async () => {
        const dim = b.shipping?.dimensions || null;
        const params = {
          item_price: b.price,
          listing_type_id: b.listing_type_id,
          mode: 'me2',
          condition: b.condition || 'new',
          logistic_type: b.shipping?.logistic_type || 'drop_off',
          verbose: true,
        };
        if (dim) params.dimensions = dim;
        const r = await axios.get(`${API}/users/${uid}/shipping_options/free`, { ...auth, params });
        return {
          costo_vendedor: r.data?.coverage?.all_country?.list_cost ?? null,
          bonificado: r.data?.coverage?.all_country?.billable_weight ?? null,
          crudo: r.data,
        };
      });

      // ---- 4) FINANCIACIÓN (costo de cuotas para el vendedor) ----
      // Intento A: sale_terms de la publicación
      await probar('financiacion_sale_terms', async () => {
        const st = b.sale_terms || [];
        const rel = st.filter((t) =>
          /INSTALLMENT|FINANC|CUOTA/i.test(t.id || '') || /cuota|financ/i.test(t.name || '')
        );
        if (!rel.length) throw new Error('La publicación no expone términos de financiación.');
        return { encontrados: rel };
      });

      // Intento B: costos reales cobrados en una orden concretada
      await probar('financiacion_ordenes', async () => {
        const o = await axios.get(`${API}/orders/search`, {
          ...auth,
          params: { seller: uid, sort: 'date_desc', limit: 1 },
        });
        const orden = o.data?.results?.[0];
        if (!orden) throw new Error('No hay órdenes para analizar.');
        const pagos = (orden.payments || []).map((p) => ({
          marketplace_fee: p.marketplace_fee ?? null,
          installments: p.installments ?? null,
          shipping_cost: p.shipping_cost ?? null,
          total_paid: p.total_paid_amount ?? null,
          transaction: p.transaction_amount ?? null,
        }));
        return {
          orden_id: orden.id,
          sale_fee_en_items: (orden.order_items || []).map((i) => i.sale_fee ?? null),
          pagos,
        };
      });

      // ---- Conclusión legible ----
      reporte.conclusion = {
        comision: reporte.pruebas.comision?.ok ? 'AUTOMATIZABLE' : 'queda manual',
        promociones: reporte.pruebas.promociones?.ok ? 'AUTOMATIZABLE' : 'queda manual',
        envio: reporte.pruebas.envio?.ok ? 'AUTOMATIZABLE' : 'queda manual',
        financiacion:
          reporte.pruebas.financiacion_sale_terms?.ok || reporte.pruebas.financiacion_ordenes?.ok
            ? 'PARCIAL — revisar los valores devueltos'
            : 'queda manual',
      };

      res.json(reporte);
    } catch (err) {
      console.error(err.response?.data || err.message);
      res.status(500).json({
        error: 'Falló el diagnóstico.',
        detalle: err.response?.data || err.message,
        reporte_parcial: reporte,
      });
    }
  });

  return router;
};
