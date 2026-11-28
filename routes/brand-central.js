const express = require('express');
const axios = require('axios');
const { multigetItems } = require('../ml-items');

// ---------------------------------------------------------------------------
// GET /api/brand-central — consulta de SOLO LECTURA de Brand Central
// (sugerencias de productos nuevos para el catálogo de Mercado Libre).
// Doc: https://developers.mercadolibre.com.ar/brand-central
//
// Devuelve:
//   - habilitado / cupo: GET /catalog_suggestions/users/{id}/quota
//     (403 "User not allowed" = la cuenta no puede sugerir productos)
//   - sugerencias ya enviadas: GET /catalog_suggestions/users/{id}/suggestions/search
//   - dominios de mis publicaciones activas y si aceptan sugerencias:
//     GET /catalog_suggestions/domains/MLA/available/full
// No crea ni modifica nada.
// ---------------------------------------------------------------------------

module.exports = (app) => {
  const router = express.Router();

  router.get('/', async (req, res) => {
    const diagnostico = [];
    const anotar = (paso, e) => diagnostico.push({
      paso,
      status: e?.response?.status || null,
      detalle: e?.response?.data?.message || e?.response?.data?.error || e?.message || String(e),
    });
    try {
      const token = await app.locals.getAccessTokenValido();
      const tokens = app.locals.leerTokens();
      const API = app.locals.ML_API;
      const auth = { headers: { Authorization: `Bearer ${token}` }, timeout: 20000 };
      const uid = tokens.user_id;
      const out = { user_id: uid, consultado_en: new Date().toISOString() };

      // 1) Cupo / habilitación
      try {
        const r = await axios.get(`${API}/catalog_suggestions/users/${uid}/quota`, auth);
        out.habilitado = true;
        out.cupo = r.data?.quota ?? r.data;
      } catch (e) {
        out.habilitado = e.response?.status === 403 ? false : null;
        out.cupo = null;
        anotar('cupo', e);
      }

      // 2) Sugerencias ya enviadas
      try {
        const r = await axios.get(`${API}/catalog_suggestions/users/${uid}/suggestions/search`, { ...auth, params: { limit: 50 } });
        out.sugerencias = {
          total: r.data?.total ?? 0,
          lista: (r.data?.suggestions || []).map((s) => ({
            id: s.id, titulo: s.title, dominio: s.domain_id, estado: s.status, subestado: s.sub_status || null,
          })),
        };
      } catch (e) {
        out.sugerencias = null;
        anotar('sugerencias', e);
      }

      // 3) Dominios de mis publicaciones activas
      const dominios = {};
      try {
        const b = await axios.get(`${API}/users/${uid}/items/search`, { ...auth, params: { status: 'active', limit: 100 } });
        const ids = b.data?.results || [];
        for (let i = 0; i < ids.length; i += 20) {
          const lote = await multigetItems(API, auth, ids.slice(i, i + 20));
          lote.forEach((d) => {
            if (d.code !== 200 || !d.body?.domain_id) return;
            const dom = d.body.domain_id;
            if (!dominios[dom]) dominios[dom] = { dominio: dom, publicaciones: [] };
            dominios[dom].publicaciones.push({ id: d.body.id, titulo: d.body.title, catalogo: Boolean(d.body.catalog_listing) });
          });
        }
      } catch (e) {
        anotar('mis publicaciones', e);
      }

      try {
        const r = await axios.get(`${API}/catalog_suggestions/domains/MLA/available/full`, { ...auth, timeout: 40000 });
        const disp = {};
        (r.data?.domains || []).forEach((d) => { disp[d.id] = { nombre: d.name, disponible: Boolean(d.available) }; });
        Object.values(dominios).forEach((d) => {
          d.nombre = disp[d.dominio]?.nombre || null;
          d.acepta_sugerencias = disp[d.dominio] ? disp[d.dominio].disponible : null;
        });
        out.dominios_totales_mla = Object.keys(disp).length;
        out.dominios_disponibles_mla = Object.values(disp).filter((d) => d.disponible).length;
      } catch (e) {
        anotar('dominios disponibles', e);
      }
      out.mis_dominios = Object.values(dominios);
      out.diagnostico = diagnostico;
      res.json(out);
    } catch (e) {
      res.status(500).json({ error: e.message, diagnostico });
    }
  });

  return router;
};
