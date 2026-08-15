const express = require('express');
const axios = require('axios');

// ---------------------------------------------------------------------------
// GET /api/ads?dias=30
//
// Trae de Mercado Ads (Product Ads):
//   - las campañas vigentes de la cuenta (estado, estrategia, ACOS objetivo,
//     presupuesto diario)
//   - qué publicaciones están dentro de cada campaña
//   - las métricas del período: impresiones, clics, inversión, ingresos y
//     ventas atribuidas — por campaña y por publicación
//
// La API de publicidad de ML cambió varias veces de forma y suele requerir
// habilitación aparte de la cuenta. Por eso este módulo no asume UN endpoint:
// prueba las variantes conocidas en orden y usa la primera que responda.
// Todo lo que falla queda registrado en `diagnostico`, así que si la cuenta
// no tiene la API habilitada, la respuesta lo dice con el detalle exacto
// en lugar de reventar.
// ---------------------------------------------------------------------------

// Métricas que se piden. Si la API rechaza la lista completa se reintenta sin ellas.
const METRICAS = [
  'clicks', 'prints', 'cost', 'cpc', 'acos',
  'units_quantity', 'direct_units_quantity', 'indirect_units_quantity',
  'total_amount', 'direct_amount', 'indirect_amount',
].join(',');

function fechaISO(d) { return d.toISOString().slice(0, 10); }

module.exports = (app) => {
  const router = express.Router();

  router.get('/', async (req, res) => {
    const diagnostico = [];
    try {
      const token = await app.locals.getAccessTokenValido();
      const tokens = app.locals.leerTokens();
      const API = app.locals.ML_API;
      const uid = tokens.user_id;

      const dias = Math.min(Math.max(Number(req.query.dias) || 30, 1), 90);
      const hasta = new Date();
      const desde = new Date(Date.now() - dias * 24 * 3600 * 1000);
      const rango = { date_from: fechaISO(desde), date_to: fechaISO(hasta) };

      // Un intento contra la API, registrando el fallo si lo hay.
      async function llamar(paso, url, headers, params) {
        try {
          const r = await axios.get(url, {
            headers: { Authorization: `Bearer ${token}`, ...headers },
            params,
            timeout: 15000,
          });
          return r.data;
        } catch (e) {
          diagnostico.push({
            paso,
            url: url.replace(API, ''),
            status: e.response?.status || null,
            detalle: e.response?.data?.message || e.response?.data?.error || e.message,
          });
          return null;
        }
      }

      // ---- 1) Advertiser: el "anunciante" asociado a la cuenta ----
      let advertiserId = null;
      const adv = await llamar('advertisers',
        `${API}/advertising/advertisers`, { 'Api-Version': '1' }, { product_id: 'PADS' });
      const listaAdv = adv?.advertisers || (Array.isArray(adv) ? adv : null);
      if (listaAdv && listaAdv.length) advertiserId = listaAdv[0].advertiser_id ?? listaAdv[0].id;

      // ---- 2) Campañas, probando las variantes conocidas ----
      let crudoCampanas = null;
      const intentosCampanas = [];
      if (advertiserId != null) {
        intentosCampanas.push(
          ['campañas v2 (advertiser)', `${API}/advertising/product_ads/campaigns`,
            { 'api-version': '2' }, { advertiser_id: advertiserId, limit: 50, metrics: METRICAS, metrics_summary: true, ...rango }],
          ['campañas v2 (por advertiser en la ruta)', `${API}/advertising/advertisers/${advertiserId}/product_ads/campaigns`,
            { 'api-version': '2' }, { limit: 50, metrics: METRICAS, metrics_summary: true, ...rango }],
        );
      }
      intentosCampanas.push(
        ['campañas v1', `${API}/advertising/product_ads/campaigns`,
          { 'Api-Version': '1' }, { limit: 50 }],
        ['campañas v1 (por usuario)', `${API}/users/${uid}/product_ads/campaigns`,
          {}, { limit: 50 }],
      );
      let cabeceraUsada = null;
      for (const [paso, url, headers, params] of intentosCampanas) {
        crudoCampanas = await llamar(paso, url, headers, params);
        if (crudoCampanas) { cabeceraUsada = headers; break; }
      }

      if (!crudoCampanas) {
        return res.json({
          generado_en: new Date().toISOString(),
          habilitado: false,
          advertiser_id: advertiserId,
          mensaje: 'No se pudo acceder a la API de Publicidad. Si todos los intentos dan 403, ' +
            'la cuenta no tiene habilitada la API de Product Ads (es una habilitación aparte del scope). ' +
            'El detalle de cada intento está en "diagnostico".',
          campanas: [],
          diagnostico,
        });
      }

      const listaCampanas = crudoCampanas.results || crudoCampanas.campaigns || (Array.isArray(crudoCampanas) ? crudoCampanas : []);

      // Normaliza un bloque de métricas venga con el nombre que venga.
      function normMetricas(m) {
        if (!m) return null;
        const n = (...ks) => { for (const k of ks) { if (m[k] != null) return Number(m[k]); } return null; };
        const directas = n('direct_units_quantity', 'direct_items_quantity');
        const indirectas = n('indirect_units_quantity', 'indirect_items_quantity');
        const ventas = n('units_quantity') != null ? n('units_quantity')
          : (directas != null || indirectas != null ? (directas || 0) + (indirectas || 0) : null);
        return {
          impresiones: n('prints', 'impressions'),
          clics: n('clicks'),
          inversion: n('cost', 'total_cost', 'spent'),
          cpc: n('cpc'),
          ingresos: n('total_amount', 'amount', 'revenue'),
          ventas,
          ventas_directas: directas,
          ventas_indirectas: indirectas,
          acos_real: n('acos'),
        };
      }

      // ---- 3) Por cada campaña: datos + sus publicaciones ----
      const campanas = [];
      for (const c of listaCampanas) {
        const id = c.id ?? c.campaign_id;
        const acosObjetivo = c.acos_target ?? c.acosTarget ?? c.target_acos ?? null;

        // Publicaciones dentro de la campaña (de nuevo, variantes en orden)
        let crudoAds = null;
        const intentosAds = [
          ['anuncios (search v2)', `${API}/advertising/product_ads/ads/search`,
            { 'api-version': '2' }, { campaign_id: id, limit: 50, metrics: METRICAS, ...rango }],
          ['anuncios (items de campaña v2)', `${API}/advertising/product_ads/campaigns/${id}/items`,
            { 'api-version': '2' }, { limit: 50, metrics: METRICAS, ...rango }],
          ['anuncios (items de campaña v1)', `${API}/advertising/product_ads/campaigns/${id}/items`,
            { 'Api-Version': '1' }, { limit: 50 }],
        ];
        for (const [paso, url, headers, params] of intentosAds) {
          crudoAds = await llamar(paso + ` [campaña ${id}]`, url, headers, params);
          if (crudoAds) break;
        }
        const listaAds = crudoAds
          ? (crudoAds.results || crudoAds.items || (Array.isArray(crudoAds) ? crudoAds : []))
          : [];

        campanas.push({
          id,
          nombre: c.name ?? c.nombre ?? ('Campaña ' + id),
          estado: c.status ?? c.state ?? null,
          // La estrategia de ML usa los mismos conceptos que tu método:
          // 'visibility' / 'increase' (crecimiento) / 'profitability' (rentabilidad)
          estrategia: c.strategy ?? c.estrategia ?? null,
          canal: c.channel ?? null,
          presupuesto_diario: c.budget ?? c.daily_budget ?? null,
          acos_objetivo: acosObjetivo != null ? Number(acosObjetivo) : null,
          roas_objetivo: acosObjetivo ? Number((100 / Number(acosObjetivo)).toFixed(2)) : null,
          creada_en: c.date_created ?? null,
          ultimo_cambio: c.last_updated ?? null,
          metricas: normMetricas(c.metrics_summary || c.metrics || null),
          anuncios: listaAds.map(a => ({
            item_id: a.item_id ?? a.id ?? null,
            titulo: a.title ?? a.titulo ?? null,
            estado: a.status ?? null,
            precio: a.price ?? null,
            metricas: normMetricas(a.metrics_summary || a.metrics || null),
          })),
        });
      }

      res.json({
        generado_en: new Date().toISOString(),
        habilitado: true,
        advertiser_id: advertiserId,
        ventana: { desde: rango.date_from, hasta: rango.date_to, dias },
        total_campanas: campanas.length,
        campanas,
        // Los intentos que fallaron antes de encontrar la variante buena.
        diagnostico,
      });
    } catch (err) {
      console.error(err.response?.data || err.message);
      res.status(500).json({
        error: 'No se pudieron obtener las campañas.',
        detalle: err.response?.data || err.message,
        diagnostico,
      });
    }
  });

  return router;
};
