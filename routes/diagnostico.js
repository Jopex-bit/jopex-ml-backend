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

      // Variante: promociones listadas a nivel usuario (a veces pide otro scope)
      await probar('promociones_por_usuario', async () => {
        const r = await axios.get(`${API}/seller-promotions/users/${uid}`, {
          ...auth,
          params: { app_version: 'v2' },
        });
        const lista = Array.isArray(r.data) ? r.data : r.data?.results || [];
        return { cantidad: lista.length, crudo: lista.slice(0, 3) };
      });

      // Plan B sin permisos especiales: si la publicación tiene precio original
      // mayor al precio actual, hay un descuento vigente. Da el % pero NO la
      // fecha de fin (ese dato solo lo tiene la API de promociones).
      await probar('promocion_plan_b_precio', async () => {
        const orig = b.original_price;
        const hay = orig != null && orig > b.price;
        return {
          hay_descuento_vigente: hay,
          precio_actual: b.price,
          precio_original: orig ?? null,
          descuento_pct: hay ? Number((((orig - b.price) / orig) * 100).toFixed(2)) : 0,
          nota: 'Este plan B detecta el descuento pero no la fecha de fin.',
        };
      });

      // ---- 3) COSTO DE ENVÍO que paga el vendedor ----
      await probar('envio', async () => {
        // La API acepta dimensiones O item_id. Esta publicación no declara
        // dimensiones, así que vamos con item_id (es lo que pide el error 400).
        const params = {
          item_id: itemId,
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
        return {
          costo_vendedor: cob.list_cost ?? null,
          costo_con_descuento: cob.cost ?? null,
          peso_facturable: cob.billable_weight ?? null,
          crudo: r.data,
        };
      });

      // Plan B de envío: costos de envío declarados en la propia publicación
      await probar('envio_plan_b', async () => {
        const r = await axios.get(`${API}/items/${itemId}/shipping_options`, auth);
        const ops = r.data?.options || [];
        return {
          opciones: ops.map((o) => ({
            nombre: o.name,
            costo_comprador: o.cost,
            costo_vendedor: o.list_cost,
            envio_id: o.shipping_method_id,
          })),
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
      // La comisión trae el desglose real: comisión pura + recargo por financiación
      const det = reporte.pruebas.comision?.detalle_crudo || {};
      reporte.valores_para_costos = {
        cargo_venta_pct: det.meli_percentage_fee ?? det.percentage_fee ?? null,
        financiacion_pct: det.financing_add_on_fee ?? null,
        cargo_fijo: det.fixed_fee ?? null,
        envio_ml: reporte.pruebas.envio?.costo_vendedor ?? null,
      };
      reporte.conclusion = {
        comision: reporte.pruebas.comision?.ok ? 'AUTOMATIZABLE' : 'queda manual',
        financiacion:
          det.financing_add_on_fee != null
            ? 'AUTOMATIZABLE (viene en el desglose de la comisión)'
            : 'queda manual',
        envio:
          reporte.pruebas.envio?.ok || reporte.pruebas.envio_plan_b?.ok
            ? 'AUTOMATIZABLE'
            : 'queda manual',
        promociones: reporte.pruebas.promociones?.ok
          ? 'AUTOMATIZABLE'
          : reporte.pruebas.promociones_por_usuario?.ok
          ? 'AUTOMATIZABLE por usuario'
          : 'solo el % por plan B (sin fecha de fin) — revisar scopes de la app',
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
