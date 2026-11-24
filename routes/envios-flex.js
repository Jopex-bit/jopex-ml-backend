const express = require('express');
const axios = require('axios');

// ---------------------------------------------------------------------------
// GET /api/envios-flex?desde=2026-11-03&hasta=2026-11-24
//
// Historial de envíos FLEX (logistic_type self_service) para controlar lo que
// cobra la mensajería (Novaflex) y lo que acredita Mercado Libre por cada envío.
//
// Devuelve datos crudos por envío: dirección de entrega (localidad, provincia,
// código postal), estado y fechas (despacho / entrega), productos y montos, y
// los costos que informa Mercado Libre (/shipments/{id}/costs):
//   - costo_comprador: lo que pagó el comprador por el envío (ventas por debajo
//     del umbral de envío gratis) — Mercado Libre te lo acredita.
//   - costo_vendedor_lista: el valor de lista del envío a cargo del vendedor.
//     En Flex NO es un cobro (verificado en el detalle de venta: no hay cargo
//     de envío); la "Bonificación por envío" acreditada es el 10% de la zona.
//
// La ZONA de Novaflex y la tarifa las calcula el panel (con la tabla de
// códigos postales que el usuario va completando), no este endpoint.
//
// Se guarda un cache en el store: los envíos que no son Flex se recuerdan para
// no volver a consultarlos (el tipo de logística no cambia) y los Flex ya
// terminados (entregado / cancelado) tampoco se vuelven a pedir.
// ---------------------------------------------------------------------------

const CLAVE_CACHE = 'jopex_envios_flex_cache';
const VERSION_CACHE = 1;
const FINALES = ['delivered', 'cancelled', 'not_delivered'];
const esFecha = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const TZ_AR = 'America/Argentina/Buenos_Aires';
const fmtDia = new Intl.DateTimeFormat('en-CA', { timeZone: TZ_AR, year: 'numeric', month: '2-digit', day: '2-digit' });
const diaAR = v => (v ? fmtDia.format(new Date(v)) : null);

module.exports = (app) => {
  const router = express.Router();
  const store = app.locals.store;

  router.get('/', async (req, res) => {
    const diagnostico = [];
    try {
      const token = await app.locals.getAccessTokenValido();
      const tokens = app.locals.leerTokens();
      const API = app.locals.ML_API;
      const auth = { headers: { Authorization: `Bearer ${token}` } };
      const uid = tokens.user_id;
      const crudo = req.query.crudo === '1';

      const hoy = diaAR(Date.now());
      const desde = esFecha(req.query.desde) ? req.query.desde : '2026-11-03';
      const hasta = esFecha(req.query.hasta) && req.query.hasta <= hoy ? req.query.hasta : hoy;
      if (desde > hasta) return res.status(400).json({ error: '"desde" no puede ser posterior a "hasta".' });

      // ---- Órdenes del rango (todas, también canceladas: el envío pudo haber salido igual) ----
      const ordenes = [];
      let offset = 0;
      while (offset < 5000) {
        const r = await axios.get(`${API}/orders/search`, {
          ...auth, timeout: 20000,
          params: {
            seller: uid,
            'order.date_created.from': `${desde}T00:00:00.000-03:00`,
            'order.date_created.to': `${hasta}T23:59:59.999-03:00`,
            sort: 'date_asc', limit: 50, offset,
          },
        });
        const pag = r.data.results || [];
        ordenes.push(...pag);
        offset += 50;
        const total = (r.data.paging && r.data.paging.total) || 0;
        if (offset >= total || !pag.length) break;
      }

      // Agrupamos por envío (un pack de varias órdenes viaja en un solo envío).
      const porEnvio = {};
      ordenes.forEach(o => {
        const sid = o.shipping && o.shipping.id;
        if (!sid) return;
        const e = porEnvio[sid] || (porEnvio[sid] = { ordenes: [], pack: o.pack_id || null, fecha_venta: o.date_created, estados_orden: [], productos: [] });
        e.ordenes.push(o.id);
        e.estados_orden.push(o.status);
        if (o.date_created < e.fecha_venta) e.fecha_venta = o.date_created;
        (o.order_items || []).forEach(it => e.productos.push({
          titulo: it.item && it.item.title,
          sku: (it.item && (it.item.seller_sku || it.item.seller_custom_field)) || null,
          cant: Number(it.quantity) || 0,
          precio: Number(it.unit_price) || 0,
        }));
      });

      let cache = await store.readKey(CLAVE_CACHE);
      if (!cache || cache.version !== VERSION_CACHE) cache = { version: VERSION_CACHE, no_flex: {}, flex: {} };

      const ids = Object.keys(porEnvio);
      const pendientes = ids.filter(sid => !cache.no_flex[sid] && !(cache.flex[sid] && FINALES.includes(cache.flex[sid].estado) && !crudo));
      for (let i = 0; i < pendientes.length; i += 5) {
        await Promise.all(pendientes.slice(i, i + 5).map(async sid => {
          try {
            const s = (await axios.get(`${API}/shipments/${sid}`, { ...auth, timeout: 10000 })).data || {};
            if (s.logistic_type !== 'self_service') { cache.no_flex[sid] = 1; delete cache.flex[sid]; return; }
            const ra = s.receiver_address || {};
            const sh = s.status_history || {};
            const env = {
              estado: s.status || null,
              subestado: s.substatus || null,
              fecha_despacho: sh.date_shipped || null,
              fecha_entrega: sh.date_delivered || null,
              fecha_no_entregado: sh.date_not_delivered || null,
              fecha_cancelado: sh.date_cancelled || null,
              localidad: (ra.city && ra.city.name) || null,
              provincia: (ra.state && ra.state.name) || null,
              cp: ra.zip_code || null,
              barrio: (ra.neighborhood && ra.neighborhood.name) || null,
              costo_comprador: null,
              costo_vendedor_lista: null,
              bonificacion_informada: null,
            };
            try {
              const c = (await axios.get(`${API}/shipments/${sid}/costs`, { ...auth, timeout: 10000 })).data || {};
              const senders = c.senders || [];
              const yo = senders.find(x => String(x.user_id) === String(uid)) || senders[0] || {};
              env.costo_vendedor_lista = yo.cost != null ? Number(yo.cost) : null;
              env.costo_comprador = c.receiver && c.receiver.cost != null ? Number(c.receiver.cost) : null;
              // Si Mercado Libre informa la compensación al vendedor, la tomamos tal cual.
              const comp = yo.compensation != null ? yo.compensation : (yo.compensations != null ? yo.compensations : null);
              if (comp != null && !isNaN(Number(comp))) env.bonificacion_informada = Number(comp);
              if (crudo) env.crudo_costos = c;
            } catch (e) {
              diagnostico.push({ envio: sid, paso: 'costs', status: e.response ? e.response.status : null });
            }
            if (crudo) env.crudo_cost_components = s.cost_components || null;
            cache.flex[sid] = env;
          } catch (e) {
            diagnostico.push({ envio: sid, paso: 'shipment', status: e.response ? e.response.status : null, detalle: e.message });
          }
        }));
      }
      try { await store.saveKey(CLAVE_CACHE, cache); } catch (e) { diagnostico.push({ paso: 'guardar cache', detalle: e.message }); }

      const envios = ids.filter(sid => cache.flex[sid]).map(sid => {
        const b = porEnvio[sid];
        const f = cache.flex[sid];
        const monto = b.productos.reduce((t, p) => t + p.precio * p.cant, 0);
        return {
          envio_id: Number(sid),
          ordenes: b.ordenes,
          pack: b.pack,
          estados_orden: b.estados_orden,
          fecha_venta: b.fecha_venta,
          dia_venta: diaAR(b.fecha_venta),
          dia_entrega: diaAR(f.fecha_entrega),
          dia_despacho: diaAR(f.fecha_despacho),
          productos: b.productos,
          monto,
          ...f,
        };
      }).sort((a, b) => String(a.fecha_venta).localeCompare(String(b.fecha_venta)));

      res.json({ generado_en: new Date().toISOString(), desde, hasta, ordenes_revisadas: ordenes.length, envios, diagnostico });
    } catch (err) {
      console.error(err.response?.data || err.message);
      res.status(500).json({ error: 'No se pudo armar el historial de envíos Flex.', detalle: err.response?.data || err.message, diagnostico });
    }
  });

  return router;
};
