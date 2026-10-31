const express = require('express');
const axios = require('axios');

// ---------------------------------------------------------------------------
// GET /api/diagnostico-ads
//
// Prueba, contra TU cuenta real de Mercado Ads, si la API expone el dato que
// Mercado Libre muestra en su propio panel de Publicidad como "Rendimiento al
// competir por impresiones" (Ganadas / Perdidas por presupuesto / Perdidas
// por ranking). No hay documentación pública que confirme el nombre del
// campo, así que se prueban varios candidatos uno por uno contra el endpoint
// real de campañas, y también se trae una campaña entera "cruda" por si el
// dato no es una métrica sino un campo propio de la campaña.
//
// No modifica nada: solo consulta y reporta qué vino y qué no.
// ---------------------------------------------------------------------------

const CANDIDATOS = [
  'impression_share',
  'lost_impression_share_by_budget',
  'lost_impression_share_by_ad_rank',
  'won_impression_share',
  'budget_lost_impression_share',
  'ad_rank_lost_impression_share',
  'share_of_voice',
  'top_impression_share',
  'absolute_top_impression_share',
];

module.exports = (app) => {
  const router = express.Router();

  router.get('/', async (req, res) => {
    const reporte = { advertiser_id: null, campana_probada: null, candidatos: {}, pruebas: {} };

    try {
      const token = await app.locals.getAccessTokenValido();
      const API = app.locals.ML_API;
      const auth = { headers: { Authorization: `Bearer ${token}` } };

      const hoy = new Date().toISOString().slice(0, 10);
      const hace30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

      // ---- Advertiser ----
      const adv = await axios.get(`${API}/advertising/advertisers`, {
        headers: { ...auth.headers, 'Api-Version': '1' }, params: { product_id: 'PADS' },
      });
      const lista = (adv.data && adv.data.advertisers) || (Array.isArray(adv.data) ? adv.data : []);
      const advertiserId = lista.length ? (lista[0].advertiser_id != null ? lista[0].advertiser_id : lista[0].id) : null;
      reporte.advertiser_id = advertiserId;
      if (advertiserId == null) return res.json({ ...reporte, error: 'Sin advertiser de Product Ads en la cuenta.' });

      const base = `${API}/marketplace/advertising/MLA/advertisers/${advertiserId}/product_ads`;

      // ---- Una campaña real para probar (y para ver sus campos crudos) ----
      const camps = await axios.get(`${base}/campaigns/search`, {
        headers: { ...auth.headers, 'Api-Version': '2' }, params: { limit: 1, offset: 0 },
      });
      const listaCamp = (camps.data && (camps.data.results || camps.data.campaigns)) || [];
      const campanaId = listaCamp.length ? (listaCamp[0].id ?? listaCamp[0].campaign_id) : null;
      reporte.campana_probada = campanaId;
      reporte.campana_cruda = listaCamp[0] || null;

      // ---- 1) Cada candidato, uno por uno, contra campaigns/search ----
      for (const campo of CANDIDATOS) {
        try {
          const r = await axios.get(`${base}/campaigns/search`, {
            headers: { ...auth.headers, 'Api-Version': '2' }, timeout: 15000,
            params: { limit: 1, offset: 0, metrics: campo, metrics_summary: true, date_from: hace30, date_to: hoy },
          });
          const resumen = r.data && r.data.metrics_summary;
          const valor = resumen ? resumen[campo] : undefined;
          reporte.candidatos[campo] = { status: 200, acepta_el_campo: true, valor: valor === undefined ? '(no vino en la respuesta)' : valor, crudo: resumen || null };
        } catch (e) {
          reporte.candidatos[campo] = { status: e.response ? e.response.status : null, acepta_el_campo: false, detalle: (e.response && e.response.data && (e.response.data.message || e.response.data.error)) || e.message };
        }
      }

      // ---- 2) Todos los candidatos que sí fueron aceptados, juntos ----
      const aceptados = Object.keys(reporte.candidatos).filter(k => reporte.candidatos[k].acepta_el_campo);
      if (aceptados.length) {
        try {
          const r = await axios.get(`${base}/campaigns/search`, {
            headers: { ...auth.headers, 'Api-Version': '2' }, timeout: 15000,
            params: { limit: 1, offset: 0, metrics: aceptados.join(','), metrics_summary: true, date_from: hace30, date_to: hoy },
          });
          reporte.pruebas.combinado = { ok: true, campos_pedidos: aceptados, metrics_summary: r.data && r.data.metrics_summary };
        } catch (e) {
          reporte.pruebas.combinado = { ok: false, status: e.response ? e.response.status : null, detalle: (e.response && e.response.data) || e.message };
        }
      }

      // ---- 3) El detalle de la campaña (no vía metrics): por si el dato es
      // un campo propio de la campaña, no una métrica que haya que pedir. ----
      if (campanaId != null) {
        try {
          const r = await axios.get(`${base}/campaigns/${campanaId}`, { headers: { ...auth.headers, 'Api-Version': '2' }, timeout: 15000 });
          reporte.pruebas.detalle_campana = { ok: true, claves: Object.keys(r.data || {}), crudo: r.data };
        } catch (e) {
          reporte.pruebas.detalle_campana = { ok: false, status: e.response ? e.response.status : null, detalle: (e.response && e.response.data) || e.message };
        }
      }

      reporte.conclusion = aceptados.length
        ? 'Encontrado: ' + aceptados.join(', ')
        : 'Ningún candidato probado funcionó. Revisar reporte.pruebas.detalle_campana por si el dato viene de otro lado.';

      res.json(reporte);
    } catch (err) {
      console.error(err.response?.data || err.message);
      res.status(500).json({ error: 'Falló el diagnóstico de Ads.', detalle: err.response?.data || err.message, reporte_parcial: reporte });
    }
  });

  return router;
};
