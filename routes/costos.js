const express = require('express');
const axios = require('axios');
const { multigetItems } = require('../ml-items');

// ---------------------------------------------------------------------------
// GET /api/costos
//
// Devuelve, para CADA publicación activa, todo lo que el módulo Costos del
// panel cargaba a mano:
//
//   cargo_venta_pct   -> comisión pura de ML          (meli_percentage_fee)
//   financiacion_pct  -> costo por cuotas             (financing_add_on_fee)
//   cargo_fijo        -> cargo fijo por unidad        (fixed_fee)
//   envio_ml          -> costo de envío del vendedor  (list_cost, ya con descuento)
//   promocion         -> promo APLICADA, con % y fecha de fin
//   promo_disponible  -> promo OFRECIDA que todavía no aplicaste
//
// Lo único que NO sale de acá es el costo del producto (valor de adquisición):
// ese lo ponés vos desde el módulo Investigación, eligiendo el proveedor.
//
// Parámetros opcionales:
//   ?limit=50   cuántas publicaciones traer (por defecto 50)
//   ?item=MLA1  analizar una sola publicación
//   ?items=MLA1,MLA2  analizar solo esas publicaciones (las de un SKU)
//   ?debug=1    agrega promos_raw: las promociones tal como las devuelve ML (para diagnóstico)
// ---------------------------------------------------------------------------

module.exports = (app) => {
  const router = express.Router();

  // Corre las promesas de a tandas para no golpear la API de ML de una sola vez.
  async function enTandas(lista, tam, fn) {
    const out = [];
    for (let i = 0; i < lista.length; i += tam) {
      const t = await Promise.all(lista.slice(i, i + tam).map(fn));
      out.push(...t);
    }
    return out;
  }

  const soloFecha = (s) => (typeof s === 'string' && s.length >= 10 ? s.slice(0, 10) : null);

  router.get('/', async (req, res) => {
    try {
      const token = await app.locals.getAccessTokenValido();
      const tokens = app.locals.leerTokens();
      const API = app.locals.ML_API;
      const auth = { headers: { Authorization: `Bearer ${token}` } };
      const uid = tokens.user_id;
      const limit = Math.min(Number(req.query.limit) || 50, 100);

      // ---- 1) Qué publicaciones analizar ----
      let ids;
      if (req.query.items) {
        // Varias publicaciones puntuales (las de un SKU), separadas por coma.
        ids = Array.from(new Set(String(req.query.items).toUpperCase().split(',').map((x) => x.trim()).filter((x) => /^MLA\d+$/.test(x)))).slice(0, 20);
      } else if (req.query.item) {
        ids = [String(req.query.item).toUpperCase()];
      } else {
        const busq = await axios.get(`${API}/users/${uid}/items/search`, {
          ...auth,
          params: { status: 'active', limit },
        });
        ids = busq.data.results || [];
      }
      if (!ids.length) return res.json({ productos: [], campanas: [], generado_en: new Date().toISOString() });

      // ---- 2) Detalle de las publicaciones (multiget de a 20) ----
      const detalles = [];
      for (let i = 0; i < ids.length; i += 20) {
        const lote = await multigetItems(API, auth, ids.slice(i, i + 20));
        lote.forEach((d) => {
          if (d.code === 200 && d.body) detalles.push(d.body);
        });
      }

      // ---- 3) Campañas activas del vendedor (para nombrar las promos) ----
      let campanas = [];
      try {
        const r = await axios.get(`${API}/seller-promotions/users/${uid}`, {
          ...auth,
          params: { app_version: 'v2' },
        });
        const lista = Array.isArray(r.data) ? r.data : r.data?.results || [];
        campanas = lista.map((c) => ({
          id: c.id,
          nombre: c.name || c.type,
          tipo: c.type,
          estado: c.status,
          desde: soloFecha(c.start_date),
          hasta: soloFecha(c.finish_date),
        }));
      } catch (e) {
        campanas = [];
      }

      // ---- 3b) Ofertas por campaña (relámpago, ofertas, etc.) ----
      // Las ofertas relámpago no figuran en la lista de promociones de cada ítem: viven en la campaña.
      // Se lee cada campaña vigente o próxima UNA vez (paginada) y se cruza por ID de publicación.
      const TIPOS_OFERTA = new Set(['LIGHTNING', 'SMART_LIGHTNING', 'DEAL', 'SMART', 'PRICE_DISCOUNT', 'UNHEALTHY_STOCK']);
      const ofertasPorItem = {};
      try {
        await enTandas(
          campanas.filter((c) => TIPOS_OFERTA.has(c.tipo) && (c.estado === 'started' || c.estado === 'pending')),
          3,
          async (c) => {
            let searchAfter = null;
            for (let pag = 0; pag < 12; pag++) {
              let r;
              try {
                r = await axios.get(`${API}/seller-promotions/promotions/${c.id}/items`, {
                  ...auth,
                  params: { promotion_type: c.tipo, app_version: 'v2', limit: 49, ...(searchAfter ? { search_after: searchAfter } : {}) },
                });
              } catch (e) { break; }
              const filas = Array.isArray(r.data) ? r.data : r.data?.results || [];
              filas.forEach((x) => {
                if (!x.id || !(x.status === 'started' || x.status === 'pending') || !(x.price > 0)) return;
                (ofertasPorItem[x.id] = ofertasPorItem[x.id] || []).push({
                  campana: c.nombre || c.tipo,
                  tipo: c.tipo,
                  estado: x.status,
                  precio: x.price,
                  precio_original: x.original_price ?? null,
                  desde: x.start_date || null,
                  hasta: x.finish_date || x.end_date || null,
                  stock: x.stock?.remaining_stock ?? null,
                  meli_pct: x.meli_percentage ?? null,
                  vendedor_pct: x.seller_percentage ?? null,
                });
              });
              searchAfter = r.data?.paging?.searchAfter || r.data?.paging?.search_after || null;
              if (!searchAfter || !filas.length) break;
            }
          }
        );
      } catch (e) { /* si falla, se sigue con lo que informa cada ítem */ }

      // ---- 4) Por cada publicación: comisión + envío + promociones ----
      const skuDe = (attrs) => {
        const a = (attrs || []).find((x) => x.id === 'SELLER_SKU');
        return a ? (a.value_name || (a.values && a.values[0] && a.values[0].name) || null) : null;
      };
      const productos = await enTandas(detalles, 4, async (b) => {
        const p = {
          ml_item_id: b.id,
          titulo: b.title,
          sku: skuDe(b.attributes),
          // Foto principal de la publicación (para la miniatura en el panel).
          foto: (b.pictures && b.pictures[0] && (b.pictures[0].secure_url || b.pictures[0].url)) || b.secure_thumbnail || b.thumbnail || null,
          precio: b.price,
          categoria: b.category_id,
          listing_type_id: b.listing_type_id,
          tipo_publicacion: b.listing_type_id === 'gold_pro' ? 'Premium' : 'Clásica',
          logistic_type: b.shipping?.logistic_type || null,
          envio_gratis: Boolean(b.shipping?.free_shipping),
          stock: b.available_quantity,
          vendidos: b.sold_quantity,
          // valores para el módulo Costos
          cargo_venta_pct: null,
          financiacion_pct: null,
          cargo_fijo: null,
          comision_total: null,
          envio_ml: null,
          promocion: null,
          promo_disponible: null,
          avisos: [],
        };

        // --- Comisión y financiación (vienen juntas en el mismo llamado) ---
        try {
          const r = await axios.get(`${API}/sites/MLA/listing_prices`, {
            ...auth,
            params: { price: b.price, category_id: b.category_id, listing_type_id: b.listing_type_id },
          });
          const d = Array.isArray(r.data) ? r.data[0] : r.data;
          const det = d?.sale_fee_details || {};
          // percentage_fee = meli_percentage_fee + financing_add_on_fee
          p.cargo_venta_pct = det.meli_percentage_fee ?? det.percentage_fee ?? null;
          p.financiacion_pct = det.financing_add_on_fee ?? 0;
          p.cargo_fijo = det.fixed_fee ?? 0;
          p.comision_total = d?.sale_fee_amount ?? null;
        } catch (e) {
          p.avisos.push('No se pudo leer la comisión: ' + (e.response?.data?.message || e.message));
        }

        // --- Costo de envío que paga el vendedor ---
        try {
          const params = {
            item_id: b.id,
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
          p.envio_ml = cob.list_cost ?? null;
          p.envio_detalle = {
            peso_facturable: cob.billable_weight ?? null,
            descuento_rate: cob.discount?.rate ?? null,
            sin_descuento: cob.discount?.promoted_amount ?? null,
          };
        } catch (e) {
          p.avisos.push('No se pudo calcular el envío: ' + (e.response?.data?.message || e.message));
        }

        // --- Promociones: aplicada (started) vs ofrecida (candidate) ---
        try {
          const r = await axios.get(`${API}/seller-promotions/items/${b.id}`, {
            ...auth,
            params: { app_version: 'v2' },
          });
          const lista = Array.isArray(r.data) ? r.data : r.data?.results || [];
          // Diagnóstico (solo lectura): con ?debug=1 se devuelve la lista cruda de promociones de ML.
          if (req.query.debug === '1') { p.promos_raw = lista; p.user_product_id = b.user_product_id || null; }

          const pct = (orig, promo) =>
            orig > 0 && promo > 0 ? Number((((orig - promo) / orig) * 100).toFixed(2)) : null;

          const activa = lista.find((x) => x.status === 'started' && x.price > 0);
          if (activa) {
            const orig = activa.original_price ?? b.price;
            p.promocion = {
              tipo: activa.type,
              precio_promo: activa.price,
              precio_original: orig,
              descuento_pct: pct(orig, activa.price),
              desde: soloFecha(activa.start_date),
              hasta: soloFecha(activa.finish_date),
              campana: activa.name || null,
            };
          }

          const candidata = lista.find((x) => x.status === 'candidate');
          if (candidata) {
            const sug = candidata.suggested_discounted_price ?? candidata.max_discounted_price ?? null;
            const orig = candidata.original_price ?? b.price;
            p.promo_disponible = {
              tipo: candidata.type,
              precio_sugerido: sug,
              descuento_sugerido_pct: sug ? pct(orig, sug) : null,
              precio_min_permitido: candidata.min_discounted_price ?? null,
              precio_max_permitido: candidata.max_discounted_price ?? null,
              nota: 'Mercado Libre ofrece esta promoción pero todavía no la aplicaste.',
            };
          }
        } catch (e) {
          p.avisos.push('No se pudieron leer las promociones: ' + (e.response?.data?.message || e.message));
        }

        // --- Ofertas de campaña (relámpago, etc.): vigentes ahora y programadas ---
        {
          const o = ofertasPorItem[b.id] || [];
          const dpct = (orig, precio) => (orig > 0 && precio > 0 ? Number((((orig - precio) / orig) * 100).toFixed(2)) : null);
          const conPct = (x) => ({ ...x, precio_original: x.precio_original ?? b.price, descuento_pct: dpct(x.precio_original ?? b.price, x.precio) });
          const ahora = o.filter((x) => x.estado === 'started').sort((x, y) => x.precio - y.precio).map(conPct);
          const prog = o.filter((x) => x.estado === 'pending').sort((x, y) => String(x.desde).localeCompare(String(y.desde))).map(conPct);
          p.promos_ahora = ahora;
          p.promos_programadas = prog.slice(0, 12);
          if (!p.promocion && ahora[0]) {
            p.promocion = {
              tipo: ahora[0].tipo,
              precio_promo: ahora[0].precio,
              precio_original: ahora[0].precio_original,
              descuento_pct: ahora[0].descuento_pct,
              desde: soloFecha(ahora[0].desde),
              hasta: soloFecha(ahora[0].hasta),
              campana: ahora[0].campana,
            };
          }
        }

        return p;
      });

      res.json({
        generado_en: new Date().toISOString(),
        cantidad: productos.length,
        campanas,
        productos,
      });
    } catch (err) {
      console.error(err.response?.data || err.message);
      res.status(500).json({
        error: 'No se pudieron obtener los costos.',
        detalle: err.response?.data || err.message,
      });
    }
  });

  // GET /api/costos/simular?item=MLA...&precios=32999,33000,38999
  // Lo que cobraría Mercado Libre por esa publicación A CADA PRECIO (hasta 8): % de cargo,
  // financiación, cargo fijo y el envío gratis a cargo del vendedor. Sirve para confirmar con ML
  // el precio piso y el de equilibrio que calcula el panel (el cargo fijo y el envío cambian
  // según el precio, sobre todo al cruzar los $33.000).
  router.get('/simular', async (req, res) => {
    try {
      const token = await app.locals.getAccessTokenValido();
      const tokens = app.locals.leerTokens();
      const API = app.locals.ML_API;
      const auth = { headers: { Authorization: `Bearer ${token}` } };
      const itemId = String(req.query.item || '').toUpperCase();
      if (!/^MLA\d+$/.test(itemId)) return res.status(400).json({ error: 'Falta ?item=MLA...' });
      const precios = Array.from(new Set(String(req.query.precios || '').split(',').map(Number).filter((n) => n > 0 && n < 1e8).map((n) => Math.round(n)))).slice(0, 8);
      if (!precios.length) return res.status(400).json({ error: 'Falta ?precios=...' });

      const lote = await multigetItems(API, auth, [itemId]);
      const b = lote[0] && lote[0].code === 200 ? lote[0].body : null;
      if (!b) return res.status(404).json({ error: 'No se encontró la publicación ' + itemId });
      const logistic = b.shipping?.logistic_type || 'drop_off';

      const resultado = await enTandas(precios, 4, async (precio) => {
        const fila = { precio, cargo_venta_pct: null, financiacion_pct: null, cargo_fijo: null, envio_ml: null, avisos: [] };
        try {
          const r = await axios.get(`${API}/sites/MLA/listing_prices`, {
            ...auth,
            params: { price: precio, category_id: b.category_id, listing_type_id: b.listing_type_id, logistic_type: logistic, shipping_mode: 'me2' },
          });
          const d = Array.isArray(r.data) ? r.data[0] : r.data;
          const det = d?.sale_fee_details || {};
          fila.cargo_venta_pct = det.meli_percentage_fee ?? det.percentage_fee ?? null;
          fila.financiacion_pct = det.financing_add_on_fee ?? 0;
          fila.cargo_fijo = det.fixed_fee ?? 0;
        } catch (e) {
          fila.avisos.push('comisión: ' + (e.response?.data?.message || e.message));
        }
        // En Flex el envío lo paga el vendedor a su mensajería: ML no lo cobra.
        if (logistic !== 'self_service') {
          try {
            const params = {
              item_id: b.id, item_price: precio, listing_type_id: b.listing_type_id, mode: 'me2',
              condition: b.condition || 'new', logistic_type: logistic, verbose: true,
            };
            if (b.shipping?.dimensions) params.dimensions = b.shipping.dimensions;
            const r = await axios.get(`${API}/users/${tokens.user_id}/shipping_options/free`, { ...auth, params });
            fila.envio_ml = r.data?.coverage?.all_country?.list_cost ?? null;
          } catch (e) {
            fila.avisos.push('envío: ' + (e.response?.data?.message || e.message));
          }
        }
        return fila;
      });
      res.json({ item: itemId, logistic_type: logistic, listing_type_id: b.listing_type_id, precio_publicado: b.price, simulacion: resultado, generado_en: new Date().toISOString() });
    } catch (err) {
      console.error(err.response?.data || err.message);
      res.status(500).json({ error: 'No se pudo simular el precio.', detalle: err.response?.data || err.message });
    }
  });

  // GET /api/costos/iibb   (?refrescar=1 para recalcular, ?dias=60)
  // Retención de Ingresos Brutos REAL sobre tus ventas: Mercado Pago retiene un % según la
  // provincia del comprador (p. ej. "SIRTAC por falta de alta Neuquén", 1,5 %) y en otras ventas
  // no retiene nada. Se lee de cada pago (charges_details de tipo "tax") y se devuelve
  // retenido ÷ vendido, contando también las ventas sin retención. Se guarda 12 h.
  const CLAVE_IIBB = 'jopex_iibb_promedio';
  router.get('/iibb', async (req, res) => {
    const store = app.locals.store;
    try {
      if (req.query.refrescar !== '1') {
        const c = await store.readKey(CLAVE_IIBB).catch(() => null);
        if (c && c.generado_en && Date.now() - new Date(c.generado_en).getTime() < 12 * 3600 * 1000) return res.json({ ...c, cache: true });
      }
      const token = await app.locals.getAccessTokenValido();
      const tokens = app.locals.leerTokens();
      const API = app.locals.ML_API;
      const auth = { headers: { Authorization: `Bearer ${token}` } };
      const dias = Math.min(Math.max(Number(req.query.dias) || 60, 7), 180);
      const desde = new Date(Date.now() - dias * 86400000).toISOString().slice(0, 10);

      // Órdenes pagadas del período (como mucho 300, de la más nueva a la más vieja).
      const ordenes = [];
      for (let offset = 0; offset < 300; offset += 50) {
        const r = await axios.get(`${API}/orders/search`, {
          ...auth, timeout: 20000,
          params: { seller: tokens.user_id, 'order.status': 'paid', 'order.date_created.from': `${desde}T00:00:00.000-03:00`, sort: 'date_desc', limit: 50, offset },
        });
        const lista = r.data.results || [];
        ordenes.push(...lista);
        if (lista.length < 50 || offset + 50 >= (r.data.paging?.total || 0)) break;
      }
      const pagos = [];
      ordenes.forEach((o) => (o.payments || []).forEach((p) => {
        if (p.status === 'approved' && p.transaction_amount > 0) pagos.push({ id: p.id, monto: p.transaction_amount });
      }));

      let vendido = 0, retenido = 0, conRetencion = 0, leidos = 0, fallidos = 0;
      const porProvincia = {};
      await enTandas(pagos, 6, async (p) => {
        try {
          const r = await axios.get(`https://api.mercadopago.com/v1/payments/${p.id}`, { ...auth, timeout: 15000 });
          const impuestos = (r.data.charges_details || []).filter((c) => c.type === 'tax' && c.accounts?.from === 'collector' && /withholding|retenc/i.test(c.name || ''));
          const monto = impuestos.reduce((s, c) => s + (Number(c.amounts?.original) || 0) - (Number(c.amounts?.refunded) || 0), 0);
          vendido += p.monto; retenido += monto; leidos++;
          if (monto > 0) {
            conRetencion++;
            impuestos.forEach((c) => {
              const prov = c.metadata?.mov_financial_entity || String(c.name || '').split('-').pop() || 'otra';
              porProvincia[prov] = (porProvincia[prov] || 0) + 1;
            });
          }
        } catch (e) { fallidos++; }
      });
      const out = {
        pct: vendido > 0 ? Number(((retenido / vendido) * 100).toFixed(3)) : null,
        ventas: leidos, con_retencion: conRetencion, no_leidas: fallidos,
        vendido: Math.round(vendido), retenido: Math.round(retenido * 100) / 100,
        por_provincia: porProvincia, desde, dias, generado_en: new Date().toISOString(),
      };
      if (leidos > 0) await store.saveKey(CLAVE_IIBB, out).catch(() => {});
      res.json(out);
    } catch (err) {
      console.error(err.response?.data || err.message);
      res.status(500).json({ error: 'No se pudo calcular la retención de IIBB.', detalle: err.response?.data || err.message });
    }
  });

  // GET /api/costos/pago?order=2000...   (diagnóstico, solo lectura)
  // Muestra el pago de una orden tal como lo devuelven ML y Mercado Pago, para ubicar
  // dónde viene la retención de Ingresos Brutos que figura en el detalle de la venta.
  router.get('/pago', async (req, res) => {
    try {
      const token = await app.locals.getAccessTokenValido();
      const API = app.locals.ML_API;
      const auth = { headers: { Authorization: `Bearer ${token}` } };
      const orderId = String(req.query.order || '').replace(/\D/g, '');
      if (!orderId) return res.status(400).json({ error: 'Falta ?order=...' });
      const intento = async (url) => {
        try { const r = await axios.get(url, { ...auth, timeout: 15000 }); return { ok: true, data: r.data }; }
        catch (e) { return { ok: false, status: e.response?.status, error: e.response?.data || e.message }; }
      };
      const orden = await intento(`${API}/orders/${orderId}`);
      const pagos = orden.ok ? (orden.data.payments || []) : [];
      const out = { order: orderId, payments: pagos, mp: [], collections: [] };
      for (const p of pagos) {
        out.mp.push(await intento(`https://api.mercadopago.com/v1/payments/${p.id}`));
        out.collections.push(await intento(`${API}/collections/${p.id}`));
      }
      if (!orden.ok) out.error_orden = orden;
      res.json(out);
    } catch (err) {
      res.status(500).json({ error: 'No se pudo leer el pago.', detalle: err.response?.data || err.message });
    }
  });

  // GET /api/costos/promos?item=MLA...   (diagnóstico, solo lectura)
  // Muestra dónde vive cada promoción de ese ítem: la lista cruda del ítem, la del "producto de usuario"
  // (user_product_id) y, por cada campaña del vendedor, si el ítem o su producto aparece adentro y con
  // qué estado, precio y fechas. Sirve para ver las promociones activas / programadas.
  router.get('/promos', async (req, res) => {
    try {
      const token = await app.locals.getAccessTokenValido();
      const tokens = app.locals.leerTokens();
      const API = app.locals.ML_API;
      const auth = { headers: { Authorization: `Bearer ${token}` } };
      const itemId = String(req.query.item || '').toUpperCase();
      if (!itemId) return res.status(400).json({ error: 'Falta ?item=MLA...' });

      const intento = async (url, params) => {
        try {
          const r = await axios.get(url, { ...auth, params });
          return { ok: true, data: r.data };
        } catch (e) {
          return { ok: false, error: e.response?.data || e.message, status: e.response?.status };
        }
      };

      const item = await intento(`${API}/items/${itemId}`, undefined);
      const upid = item.ok ? item.data.user_product_id || null : null;

      const out = {
        item: itemId,
        user_product_id: upid,
        precio: item.ok ? item.data.price : null,
        promos_del_item: await intento(`${API}/seller-promotions/items/${itemId}`, { app_version: 'v2' }),
      };
      if (upid) {
        out.promos_del_producto = await intento(`${API}/seller-promotions/items/${upid}`, { app_version: 'v2' });
        out.promos_user_products = await intento(`${API}/seller-promotions/user-products/${upid}`, { app_version: 'v2' });
      }

      // Campañas del vendedor y si este ítem (o su producto) está adentro.
      const camp = await intento(`${API}/seller-promotions/users/${tokens.user_id}`, { app_version: 'v2' });
      const lista = camp.ok ? (Array.isArray(camp.data) ? camp.data : camp.data?.results || []) : [];
      out.en_campanas = await enTandas(lista, 4, async (c) => {
        const r = await intento(`${API}/seller-promotions/promotions/${c.id}/items`, {
          promotion_type: c.type, app_version: 'v2', item_id: itemId, limit: 49,
        });
        if (!r.ok) return { id: c.id, nombre: c.name, tipo: c.type, estado_campana: c.status, error: r.error };
        const filas = Array.isArray(r.data) ? r.data : r.data?.results || [];
        const mias = filas.filter((x) => x.id === itemId || (upid && x.id === upid));
        // Si ML no filtra por item_id, se devuelven solo las primeras filas; 'paging' ayuda a ver si hay más.
        return { paging: r.data?.paging || null,
          id: c.id, nombre: c.name, tipo: c.type, estado_campana: c.status,
          desde: c.start_date || null, hasta: c.finish_date || null,
          items_en_campana: filas.length, aparece: mias,
        };
      });
      res.json(out);
    } catch (err) {
      console.error(err.response?.data || err.message);
      res.status(500).json({ error: 'No se pudo hacer el diagnóstico.', detalle: err.response?.data || err.message });
    }
  });

  return router;
};
