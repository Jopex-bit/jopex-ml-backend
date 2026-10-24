const express = require('express');
const axios = require('axios');

// ---------------------------------------------------------------------------
// GET /api/atencion/diagnostico
//
// Solo consulta (no modifica nada): prueba si TU cuenta puede leer desde la API de
// Mercado Libre las preguntas sin responder, los reclamos abiertos y las devoluciones,
// para decidir qué se puede mostrar en el panel. Reporta el estado de cada prueba.
// ---------------------------------------------------------------------------
module.exports = (app) => {
  const router = express.Router();

  router.get('/diagnostico', async (req, res) => {
    const token = await app.locals.getAccessTokenValido();
    const tokens = app.locals.leerTokens();
    const headers = { Authorization: `Bearer ${token}` };
    const base = app.locals.ML_API;
    const out = { user_id: tokens.user_id, permisos: tokens.scope || null, pruebas: {} };

    const probar = async (nombre, url, params, extra) => {
      try {
        const r = await axios.get(base + url, { headers, params, timeout: 20000 });
        out.pruebas[nombre] = { ok: true, status: r.status, resumen: extra ? extra(r.data) : null };
        return r.data;
      } catch (e) {
        const d = e.response?.data;
        out.pruebas[nombre] = { ok: false, status: e.response?.status || null, error: d?.message || d?.error || e.message, detalle: d?.cause || null };
        return null;
      }
    };

    await probar('preguntas_sin_responder', '/questions/search',
      { seller_id: tokens.user_id, status: 'UNANSWERED', limit: 5 },
      (d) => ({ total: d.total, ejemplo: (d.questions || []).slice(0, 2).map((q) => ({ item: q.item_id, fecha: q.date_created, texto: String(q.text || '').slice(0, 60) })) }));

    const reclamos = await probar('reclamos_abiertos', '/post-purchase/v1/claims/search',
      { status: 'opened', limit: 5 },
      (d) => ({ total: d.paging?.total ?? null, ejemplo: (d.data || []).slice(0, 2).map((c) => ({ id: c.id, tipo: c.type, etapa: c.stage, estado: c.status, recurso: c.resource, fecha: c.date_created })) }));

    await probar('mensajes_sin_leer', '/messages/unread', { role: 'seller', tag: 'post_sale' },
      (d) => ({ total: d.paging?.total ?? d.results?.length ?? null }));

    // Devoluciones: se leen desde un reclamo concreto (si hay alguno abierto).
    const primero = reclamos && (reclamos.data || [])[0];
    if (primero) {
      await probar('devolucion_de_un_reclamo', `/post-purchase/v1/claims/${primero.id}/returns`, {},
        (d) => ({ estado: d.status, destino: d.shipping?.destination?.name || null, tracking: d.shipping?.tracking_number || null, envio: d.shipping?.status || null }));
    } else {
      out.pruebas.devolucion_de_un_reclamo = { ok: null, nota: 'No hay reclamos abiertos para probar la lectura de devoluciones.' };
    }

    res.json(out);
  });

  return router;
};
