const express = require('express');
const axios = require('axios');

// ---------------------------------------------------------------------------
// GET /api/diagnostico-direccion?dias=N&tipo=self_service
//
// Pregunta a validar antes de diseñar nada: ¿la API de Mercado Libre expone,
// para una venta por FLEX (self_service), la dirección del comprador
// (localidad/partido, CP) con el detalle suficiente para clasificarla en
// una zona de mensajería (ej. CABA / Cordón 1 / Cordón 2 / Cordón 3 de
// Novaflex)? No hay forma de saberlo sin mirar una respuesta real: se trae
// una tanda de shipments del tipo pedido, recientes, y se reporta, crudo,
// qué trae receiver_address. tipo=fulfillment para repetir la prueba con
// Full en vez de Flex.
//
// Solo lectura. No modifica nada.
// ---------------------------------------------------------------------------

module.exports = (app) => {
  const router = express.Router();

  router.get('/', async (req, res) => {
    const tipoBuscado = req.query.tipo === 'fulfillment' ? 'fulfillment' : 'self_service';
    const reporte = { tipo_buscado: tipoBuscado, ordenes_revisadas: 0, shipments_encontrados: 0, muestras: [] };
    try {
      const token = await app.locals.getAccessTokenValido();
      const tokens = app.locals.leerTokens();
      const API = app.locals.ML_API;
      const auth = { headers: { Authorization: `Bearer ${token}` } };
      const uid = tokens.user_id;

      const dias = Math.min(Math.max(Number(req.query.dias) || 14, 1), 90);
      const desde = new Date(Date.now() - dias * 86400000);
      const hasta = new Date();

      const ordenes = [];
      let offset = 0;
      const limit = 50;
      let total = null;
      const muestraMax = 8;
      // Pagina órdenes hasta juntar bastantes muestras del tipo pedido, o
      // hasta agotar la ventana — sin esto, si Flex es minoría en el mix de
      // despacho, una sola página de 50 puede no traer ninguna.
      while (offset < 500) {
        const r = await axios.get(`${API}/orders/search`, {
          ...auth,
          params: {
            seller: uid,
            'order.date_created.from': desde.toISOString().slice(0, 19) + '.000-00:00',
            'order.date_created.to': hasta.toISOString().slice(0, 19) + '.000-00:00',
            sort: 'date_desc',
            limit,
            offset,
          },
        });
        const pagina = (r.data.results || []);
        ordenes.push(...pagina);
        total = r.data.paging?.total ?? pagina.length;
        offset += limit;
        if (offset >= total || pagina.length === 0) break;
        if (reporte.muestras.length >= muestraMax) break;
      }
      const pagadas = ordenes.filter(o => o.status === 'paid');
      reporte.ordenes_revisadas = pagadas.length;

      const idsVistos = new Set();
      for (const o of pagadas) {
        if (reporte.muestras.length >= muestraMax) break;
        const sid = o.shipping && o.shipping.id;
        if (!sid || idsVistos.has(sid)) continue;
        idsVistos.add(sid);
        try {
          const rs = await axios.get(`${API}/shipments/${sid}`, { ...auth, timeout: 8000 });
          const s = rs.data || {};
          if (s.logistic_type !== tipoBuscado) continue;
          reporte.shipments_encontrados++;
          const ra = s.receiver_address || null;
          reporte.muestras.push({
            shipment_id: sid,
            tiene_receiver_address: !!ra,
            receiver_address: ra ? {
              city: ra.city, state: ra.state, zip_code: ra.zip_code,
              address_line: ra.address_line, neighborhood: ra.neighborhood,
              municipality: ra.municipality || null,
            } : null,
            claves_crudas_shipment: Object.keys(s),
          });
        } catch (e) {
          reporte.muestras.push({ shipment_id: sid, error: (e.response && e.response.status) || e.message });
        }
      }

      reporte.conclusion = reporte.muestras.some(m => m.tiene_receiver_address)
        ? `Al menos una venta ${tipoBuscado} trae receiver_address con detalle de localidad/CP.`
        : `Ninguna de las muestras ${tipoBuscado} trajo receiver_address (o no hubo ventas de ese tipo en la ventana). Revisar claves_crudas_shipment por si el dato viene con otro nombre.`;

      res.json(reporte);
    } catch (err) {
      console.error(err.response?.data || err.message);
      res.status(500).json({ error: 'Falló el diagnóstico de dirección.', detalle: err.response?.data || err.message, reporte_parcial: reporte });
    }
  });

  return router;
};
