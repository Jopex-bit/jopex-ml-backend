const express = require('express');
const axios = require('axios');

// ---------------------------------------------------------------------------
// GET /api/ads?dias=30
//
// Trae de Mercado Ads (Product Ads):
//   - las campañas de la cuenta (estado, estrategia, ACOS objetivo, presupuesto)
//   - qué publicaciones están dentro de cada campaña
//   - las métricas del período, por campaña y por publicación
//
// Rutas según la estructura vigente de la API (prefijo /marketplace/advertising):
//   1. GET /advertising/advertisers?product_id=PADS                  (Api-Version: 1)
//   2. GET /marketplace/advertising/{sitio}/advertisers/{id}/product_ads/campaigns/search
//   3. GET /marketplace/advertising/{sitio}/advertisers/{id}/product_ads/ads/search
//      -> los anuncios vienen TODOS juntos, cada uno con su campaign_id,
//         así que se agrupan acá y no hace falta una llamada por campaña.
//
// Igual se conservan variantes de respaldo (rutas viejas sin /marketplace) y
// todo intento fallido queda en `diagnostico`, porque esta API cambia seguido.
// ---------------------------------------------------------------------------

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
      const API = app.locals.ML_API;
      const sitio = String(req.query.sitio || 'MLA');

      const dias = Math.min(Math.max(Number(req.query.dias) || 30, 1), 90);
      const hasta = new Date();
      const desde = new Date(Date.now() - dias * 24 * 3600 * 1000);
      const rango = { date_from: fechaISO(desde), date_to: fechaISO(hasta) };

      // Un intento contra la API. Si falla por las métricas (400), reintenta sin ellas.
      async function llamar(paso, url, headers, params) {
        try {
          const r = await axios.get(url, {
            headers: { Authorization: `Bearer ${token}`, ...headers },
            params, timeout: 20000,
          });
          return r.data;
        } catch (e) {
          const status = e.response?.status || null;
          diagnostico.push({
            paso, url: url.replace(API, ''), status,
            detalle: e.response?.data?.message || e.response?.data?.error || e.message,
          });
          if (status === 400 && params && params.metrics) {
            const { metrics, metrics_summary, ...sinMetricas } = params;
            return llamar(paso + ' (sin métricas)', url, headers, sinMetricas);
          }
          return null;
        }
      }

      // ---- 1) Advertiser ----
      let advertiserId = null;
      const adv = await llamar('advertisers',
        `${API}/advertising/advertisers`, { 'Api-Version': '1' }, { product_id: 'PADS' });
      const listaAdv = adv?.advertisers || (Array.isArray(adv) ? adv : null);
      if (listaAdv && listaAdv.length) {
        advertiserId = listaAdv[0].advertiser_id ?? listaAdv[0].id;
      }
      if (advertiserId == null) {
        return res.json({
          generado_en: new Date().toISOString(),
          habilitado: false,
          mensaje: 'La cuenta no devolvió ningún anunciante (advertiser) de Product Ads. ' +
            'Suele significar que Mercado Ads no está activo en la cuenta.',
          campanas: [], diagnostico,
        });
      }

      const basePads = `${API}/marketplace/advertising/${sitio}/advertisers/${advertiserId}/product_ads`;
      const baseViejo = `${API}/advertising/advertisers/${advertiserId}/product_ads`;

      // ---- 2) Campañas con métricas del período ----
      const paramsCampanas = { limit: 50, offset: 0, metrics: METRICAS, metrics_summary: true, ...rango };
      let crudoCampanas = null;
      for (const [paso, url, headers] of [
        ['campañas (marketplace v2)', `${basePads}/campaigns/search`, { 'Api-Version': '2' }],
        ['campañas (marketplace v1)', `${basePads}/campaigns/search`, { 'Api-Version': '1' }],
        ['campañas (ruta vieja v2)', `${baseViejo}/campaigns`, { 'Api-Version': '2' }],
      ]) {
        crudoCampanas = await llamar(paso, url, headers, paramsCampanas);
        if (crudoCampanas) break;
      }
      if (!crudoCampanas) {
        return res.json({
          generado_en: new Date().toISOString(),
          habilitado: false,
          advertiser_id: advertiserId,
          mensaje: 'El anunciante existe pero ninguna ruta de campañas respondió. ' +
            'Pasame el "diagnostico" para ajustar la ruta.',
          campanas: [], diagnostico,
        });
      }
      const listaCampanas = crudoCampanas.results || crudoCampanas.campaigns ||
        (Array.isArray(crudoCampanas) ? crudoCampanas : []);

      // ---- 3) TODOS los anuncios de una, con su campaign_id ----
      let crudoAds = null;
      for (const [paso, url, headers] of [
        ['anuncios (marketplace v2)', `${basePads}/ads/search`, { 'Api-Version': '2' }],
        ['anuncios (marketplace v1)', `${basePads}/ads/search`, { 'Api-Version': '1' }],
        ['anuncios (items ruta vieja)', `${baseViejo}/items`, { 'Api-Version': '2' }],
      ]) {
        crudoAds = await llamar(paso, url, headers,
          { limit: 200, offset: 0, metrics: METRICAS, ...rango });
        if (crudoAds) break;
      }
      const listaAds = crudoAds
        ? (crudoAds.results || crudoAds.items || (Array.isArray(crudoAds) ? crudoAds : []))
        : [];

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

      // Agrupar los anuncios por campaña
      const porCampana = {};
      const sueltos = [];
      listaAds.forEach(a => {
        const anuncio = {
          item_id: a.item_id ?? a.id ?? null,
          titulo: a.title ?? a.titulo ?? null,
          estado: a.status ?? null,
          precio: a.price ?? null,
          campaign_id: a.campaign_id ?? a.campaignId ?? null,
          metricas: normMetricas(a.metrics_summary || a.metrics || a),
        };
        if (anuncio.campaign_id != null) {
          (porCampana[anuncio.campaign_id] = porCampana[anuncio.campaign_id] || []).push(anuncio);
        } else sueltos.push(anuncio);
      });

      const campanas = listaCampanas.map(c => {
        const id = c.id ?? c.campaign_id;
        const acosObjetivo = c.acos_target ?? c.acosTarget ?? c.target_acos ?? null;
        return {
          id,
          nombre: c.name ?? c.nombre ?? ('Campaña ' + id),
          estado: c.status ?? c.state ?? null,
          // Los mismos conceptos de tu método:
          // visibility = Visibilidad, increase = Crecimiento, profitability = Rentabilidad
          estrategia: c.strategy ?? c.estrategia ?? null,
          canal: c.channel ?? null,
          presupuesto_diario: c.budget ?? c.daily_budget ?? null,
          acos_objetivo: acosObjetivo != null ? Number(acosObjetivo) : null,
          roas_objetivo: acosObjetivo ? Number((100 / Number(acosObjetivo)).toFixed(2)) : null,
          creada_en: c.date_created ?? null,
          ultimo_cambio: c.last_updated ?? null,
          metricas: normMetricas(c.metrics_summary || c.metrics || null),
          anuncios: porCampana[id] || [],
        };
      });

      res.json({
        generado_en: new Date().toISOString(),
        habilitado: true,
        advertiser_id: advertiserId,
        sitio,
        ventana: { desde: rango.date_from, hasta: rango.date_to, dias },
        total_campanas: campanas.length,
        total_anuncios: listaAds.length,
        campanas,
        anuncios_sin_campana: sueltos,
        // Intentos que fallaron antes de dar con la ruta buena (si quedó vacío, todo salió a la primera)
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
