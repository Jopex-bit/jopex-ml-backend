const express = require('express');
const axios = require('axios');

// ---------------------------------------------------------------------------
// GET /api/curva?item=MLA3723993960
// GET /api/curva?categoria=MLA458037&tipo=gold_pro
//
// Mide la estructura REAL de costos de Mercado Libre para una categoría,
// consultando el endpoint oficial de comisiones a muchos precios distintos.
// Sirve para descubrir dónde aparece el cargo fijo, cómo cambia el porcentaje
// y desde qué precio se activa el envío gratis obligatorio.
//
// No documenta nada de memoria: mide contra tu propia cuenta.
// ---------------------------------------------------------------------------

const PRECIOS = [
  500, 1000, 1500, 2000, 2500, 3000, 4000, 5000, 6000, 8000, 10000,
  12000, 15000, 18000, 20000, 25000, 30000, 40000, 50000, 65000,
  80000, 100000, 150000, 200000
];

module.exports = (app) => {
  const router = express.Router();

  async function enTandas(lista, tam, fn) {
    const out = [];
    for (let i = 0; i < lista.length; i += tam) {
      out.push(...await Promise.all(lista.slice(i, i + tam).map(fn)));
    }
    return out;
  }

  router.get('/', async (req, res) => {
    try {
      const token = await app.locals.getAccessTokenValido();
      const tokens = app.locals.leerTokens();
      const API = app.locals.ML_API;
      const auth = { headers: { Authorization: `Bearer ${token}` } };
      const uid = tokens.user_id;

      let categoria = req.query.categoria;
      let tipo = req.query.tipo || 'gold_pro';
      let itemRef = null;

      if (req.query.item) {
        const it = await axios.get(`${API}/items/${req.query.item}`, auth);
        categoria = it.data.category_id;
        tipo = it.data.listing_type_id;
        itemRef = {
          id: it.data.id, titulo: it.data.title, precio: it.data.price,
          categoria, listing_type_id: tipo
        };
      }
      if (!categoria) {
        return res.status(400).json({ error: 'Indicá ?item=MLA... o ?categoria=MLA...' });
      }

      const conEnvio = req.query.envio === '1';

      const puntos = await enTandas(PRECIOS, 4, async (precio) => {
        const fila = { precio };
        try {
          const r = await axios.get(`${API}/sites/MLA/listing_prices`, {
            ...auth, params: { price: precio, category_id: categoria, listing_type_id: tipo }
          });
          const d = Array.isArray(r.data) ? r.data[0] : r.data;
          const det = d?.sale_fee_details || {};
          fila.comision_total = d?.sale_fee_amount ?? null;
          fila.pct_total = det.percentage_fee ?? null;
          fila.pct_meli = det.meli_percentage_fee ?? null;
          fila.pct_financiacion = det.financing_add_on_fee ?? null;
          fila.cargo_fijo = det.fixed_fee ?? null;
          // Cuánto representa la comisión sobre el precio (incluye el fijo)
          fila.carga_efectiva_pct = fila.comision_total != null
            ? Number(((fila.comision_total / precio) * 100).toFixed(2)) : null;
        } catch (e) {
          fila.error = e.response?.data?.message || e.message;
        }

        if (conEnvio) {
          try {
            const r2 = await axios.get(`${API}/users/${uid}/shipping_options/free`, {
              ...auth,
              params: {
                item_id: req.query.item, item_price: precio, listing_type_id: tipo,
                mode: 'me2', condition: 'new', logistic_type: 'drop_off', verbose: true
              }
            });
            fila.envio_vendedor = r2.data?.coverage?.all_country?.list_cost ?? null;
          } catch (e) {
            fila.envio_vendedor = null;
          }
        }
        return fila;
      });

      // ---- Detección automática de quiebres ----
      const quiebres = [];
      for (let i = 1; i < puntos.length; i++) {
        const a = puntos[i - 1], b = puntos[i];
        if (a.cargo_fijo !== b.cargo_fijo) {
          quiebres.push({
            tipo: 'cargo_fijo',
            entre: [a.precio, b.precio],
            de: a.cargo_fijo, a_: b.cargo_fijo
          });
        }
        if (a.pct_total !== b.pct_total) {
          quiebres.push({
            tipo: 'porcentaje',
            entre: [a.precio, b.precio],
            de: a.pct_total, a_: b.pct_total
          });
        }
        if (a.pct_financiacion !== b.pct_financiacion) {
          quiebres.push({
            tipo: 'financiacion',
            entre: [a.precio, b.precio],
            de: a.pct_financiacion, a_: b.pct_financiacion
          });
        }
        if (conEnvio && a.envio_vendedor !== b.envio_vendedor) {
          quiebres.push({
            tipo: 'envio',
            entre: [a.precio, b.precio],
            de: a.envio_vendedor, a_: b.envio_vendedor
          });
        }
      }

      res.json({
        item: itemRef,
        categoria,
        listing_type_id: tipo,
        medido_en: new Date().toISOString(),
        quiebres,
        puntos
      });
    } catch (err) {
      console.error(err.response?.data || err.message);
      res.status(500).json({ error: 'No se pudo medir la curva.', detalle: err.response?.data || err.message });
    }
  });

  return router;
};
