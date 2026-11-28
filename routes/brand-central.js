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

  const conAuth = async () => {
    const token = await app.locals.getAccessTokenValido();
    return { API: app.locals.ML_API, auth: { headers: { Authorization: `Bearer ${token}` }, timeout: 20000 } };
  };
  const errorML = (res, e) => res.status(e.response?.status || 500).json({
    error: e.response?.data?.message || e.message, detalle: e.response?.data || null,
  });

  // GET /api/brand-central/ficha/:dominio — atributos que pide ML para sugerir
  // un producto de ese dominio (input de la ficha técnica, canal catalog_suggestions).
  router.get('/ficha/:dominio', async (req, res) => {
    try {
      const { API, auth } = await conAuth();
      const r = await axios.get(`${API}/domains/${encodeURIComponent(req.params.dominio)}/technical_specs/input`, {
        ...auth, params: { channel_id: 'catalog_suggestions' },
      });
      const atributos = [];
      (r.data?.groups || []).forEach((g) => (g.components || []).forEach((c) => (c.attributes || []).forEach((a) => {
        atributos.push({
          grupo: g.label, id: a.id, nombre: a.name, tipo: a.value_type, tags: a.tags || [],
          valores: (a.values || []).slice(0, 40).map((v) => ({ id: v.id, nombre: v.name })),
          unidades: (a.allowed_units || []).map((u) => u.name || u.id),
          ayuda: c.ui_config?.hint || null,
        });
      })));
      res.json({ dominio: req.params.dominio, atributos });
    } catch (e) { errorML(res, e); }
  });

  // GET /api/brand-central/item/:id — datos de UNA publicación propia que sirven
  // para armar la sugerencia (atributos, fotos, descripción).
  router.get('/item/:id', async (req, res) => {
    try {
      const { API, auth } = await conAuth();
      const tokens = app.locals.leerTokens();
      const it = (await axios.get(`${API}/items/${encodeURIComponent(req.params.id)}`, auth)).data;
      if (String(it.seller_id) !== String(tokens.user_id)) return res.status(403).json({ error: 'No es una publicación propia.' });
      let descripcion = null;
      try { descripcion = (await axios.get(`${API}/items/${it.id}/description`, auth)).data?.plain_text || null; } catch (e) { /* sin descripción */ }
      res.json({
        id: it.id, titulo: it.title, dominio: it.domain_id, categoria: it.category_id, precio: it.price,
        vendidos: it.sold_quantity, catalogo: Boolean(it.catalog_listing), catalog_product_id: it.catalog_product_id || null,
        fotos: (it.pictures || []).map((p) => ({ id: p.id, url: p.secure_url || p.url, size: p.size })),
        atributos: (it.attributes || []).map((a) => ({ id: a.id, nombre: a.name, valor: a.value_name, valor_id: a.value_id })),
        variaciones: (it.variations || []).map((v) => ({
          id: v.id, combinacion: (v.attribute_combinations || []).map((a) => `${a.name}: ${a.value_name}`).join(', '),
          fotos: v.picture_ids || [],
        })),
        descripcion,
      });
    } catch (e) { errorML(res, e); }
  });

  // POST /api/brand-central/validar — chequeo previo de una sugerencia (no la crea).
  router.post('/validar', express.json({ limit: '1mb' }), async (req, res) => {
    try {
      const { API, auth } = await conAuth();
      const r = await axios.post(`${API}/catalog_suggestions/validate`, req.body, auth);
      res.json({ ok: true, status: r.status, respuesta: r.data || null });
    } catch (e) {
      if (e.response?.status === 400) return res.json({ ok: false, errores: e.response.data?.cause || e.response.data });
      errorML(res, e);
    }
  });

  // POST /api/brand-central/sugerir — CREA la sugerencia (consume cupo).
  // Requiere confirmar=1 en la query para que no se dispare por error.
  // Body: { sugerencia: {...}, descripcion: "texto" }
  router.post('/sugerir', express.json({ limit: '1mb' }), async (req, res) => {
    if (req.query.confirmar !== '1') return res.status(400).json({ error: 'Falta confirmar=1 (esta acción consume cupo).' });
    try {
      const { API, auth } = await conAuth();
      const s = (await axios.post(`${API}/catalog_suggestions`, req.body.sugerencia, auth)).data;
      let descripcion = null;
      if (req.body.descripcion) {
        try {
          await axios.post(`${API}/catalog_suggestions/${s.id}/description`, { plain_text: req.body.descripcion }, auth);
          descripcion = 'ok';
        } catch (e) { descripcion = e.response?.data?.message || e.message; }
      }
      res.json({ sugerencia: s, descripcion });
    } catch (e) { errorML(res, e); }
  });

  // POST /api/brand-central/sugerencia/:id/descripcion — carga (o modifica, si ya
  // tiene) la descripción de una sugerencia ya creada. Body: { descripcion: "texto" }
  // Existe porque justo después de crear la sugerencia ML a veces todavía no la encuentra.
  router.post('/sugerencia/:id/descripcion', express.json({ limit: '1mb' }), async (req, res) => {
    const texto = String(req.body?.descripcion || '').trim();
    if (!texto) return res.status(400).json({ error: 'Falta la descripción.' });
    try {
      const { API, auth } = await conAuth();
      const url = `${API}/catalog_suggestions/${encodeURIComponent(req.params.id)}/description`;
      try {
        await axios.post(url, { plain_text: texto }, auth);
        return res.json({ ok: true, accion: 'creada' });
      } catch (e) {
        if (!/already has a description/i.test(e.response?.data?.message || '')) throw e;
        await axios.put(url, { plain_text: texto }, auth);
        return res.json({ ok: true, accion: 'modificada' });
      }
    } catch (e) { errorML(res, e); }
  });

  // GET /api/brand-central/sugerencia/:id — estado y validaciones de una sugerencia.
  router.get('/sugerencia/:id', async (req, res) => {
    try {
      const { API, auth } = await conAuth();
      const id = encodeURIComponent(req.params.id);
      const s = (await axios.get(`${API}/catalog_suggestions/${id}`, auth)).data;
      let validaciones = null;
      try { validaciones = (await axios.get(`${API}/catalog_suggestions/${id}/validations`, auth)).data?.validations || []; } catch (e) { /* aún no hay */ }
      res.json({ sugerencia: s, validaciones });
    } catch (e) { errorML(res, e); }
  });

  return router;
};
