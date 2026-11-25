const express = require('express');
const axios = require('axios');

// ---------------------------------------------------------------------------
// Stock publicado en Mercado Libre para una FAMILIA de SKU que comparten el
// mismo producto físico (ej. COLLAR TAG GATOS: GENERICO, CUIDADORA, TORMENTA,
// VIAJE, PACK2, PACK3).
//
// Problema: cada venta baja solo el stock de la publicación vendida, pero el
// producto físico es uno solo. Decisión del usuario (24/11/2026):
//   - Se publica SOLO el stock del depósito Flex.
//   - Se actualiza automático después de cada venta.
//
// Cálculo (la misma regla que el panel, módulo Stock > tarjeta Flex):
//   Flex = conteo Flex + envíos que llegaron − devoluciones − ventas Flex
//          (ventas en collares: pack x2 = 2, pack x3 = 3) − margen
//   Publicado por SKU = piso(Flex / unidades del pack)
// Las publicaciones que salen por FULL no se tocan (ese stock lo maneja ML).
//
// GET /api/familia-stock?familia=COLLAR%20TAG%20GATOS          -> vista previa
//     ...&aplicar=1                                             -> aplica todo
//     ...&aplicar=1&item=MLA123                                 -> aplica solo esa
// GET /api/familia-stock/ultimo                                -> última corrida
// Automático: alNotificar(ordenId) desde el webhook de órdenes.
// La configuración (familias activas y margen) vive en el estado del panel,
// clave jopex_familias_stock_cfg: { "COLLAR TAG GATOS": { activo, margen } }.
// ---------------------------------------------------------------------------

const TZ_AR = 'America/Argentina/Buenos_Aires';
const fmtDia = new Intl.DateTimeFormat('en-CA', { timeZone: TZ_AR, year: 'numeric', month: '2-digit', day: '2-digit' });
const diaAR = v => fmtDia.format(new Date(v));
const CLAVE_ENVIOS = 'jopex_familia_stock_envios';
const CLAVE_ULTIMO = 'jopex_familia_stock_ultimo';
const ESPERA_MS = 15000; // junta las notificaciones repetidas de una misma venta

const num = v => (v === '' || v == null || isNaN(v) ? 0 : Number(v));
const factorDe = c => (Array.isArray(c.componentes) && c.componentes.length === 1 ? Math.max(1, Number(c.componentes[0].cantidad) || 1) : 1);
const parse = (s, def) => { try { return s ? JSON.parse(s) : def; } catch (e) { return def; } };

module.exports = (app) => {
  const store = app.locals.store;

  async function ctx() {
    const token = await app.locals.getAccessTokenValido();
    const tokens = app.locals.leerTokens();
    return { API: app.locals.ML_API, uid: tokens.user_id, auth: { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 } };
  }

  async function leerEstado() {
    const g = await store.readKey('jopex_estado_panel');
    const d = (g && g.datos) || {};
    return {
      costos: parse(d.jopex_costos_productos, []),
      stock: parse(d.jopex_stock_productos, []),
      cfg: parse(d.jopex_familias_stock_cfg, {}),
    };
  }

  function datosFamilia(est, nombre) {
    const miembros = est.costos
      .filter(c => c.mlItemId && (c.familia || '').trim() === nombre)
      .map(c => ({ id: c.mlItemId, sku: (c.sku || '').trim(), factor: factorDe(c) }));
    const ids = new Set(miembros.map(m => m.id));
    const sps = est.stock.filter(p => p.mlItemId && ids.has(p.mlItemId));
    // Los datos de Flex de la familia viven en la publicación "principal" (la que tiene los lotes/movimientos).
    const prim = sps.find(p => (p.envios || []).length > 0) || sps.find(p => p.flexConteo || (p.movimientosFlex || []).length) || sps[0] || null;
    return { miembros, prim, cfg: est.cfg[nombre] || {} };
  }

  // Ventas Flex (pagadas) de la familia desde una fecha, en unidades físicas.
  async function ventasFlex(c, miembros, desde, inclusivo) {
    const fac = {};
    miembros.forEach(m => { fac[m.id] = m.factor; });
    const ordenes = [];
    let offset = 0;
    while (offset < 3000) {
      const r = await axios.get(`${c.API}/orders/search`, {
        ...c.auth, timeout: 20000,
        params: { seller: c.uid, 'order.date_created.from': `${desde}T00:00:00.000-03:00`, sort: 'date_asc', limit: 50, offset },
      });
      const pag = r.data.results || [];
      ordenes.push(...pag);
      offset += 50;
      if (offset >= ((r.data.paging && r.data.paging.total) || 0) || !pag.length) break;
    }
    let cache = (await store.readKey(CLAVE_ENVIOS)) || {};
    let unidades = 0;
    const detalle = [];
    for (const o of ordenes) {
      if (o.status !== 'paid') continue;
      const dia = diaAR(o.date_created);
      if (inclusivo ? dia < desde : dia <= desde) continue;
      const its = (o.order_items || []).filter(it => it.item && fac[it.item.id]);
      if (!its.length) continue;
      const sid = o.shipping && o.shipping.id;
      if (!sid) continue;
      if (!cache[sid]) {
        const s = (await axios.get(`${c.API}/shipments/${sid}`, c.auth)).data || {};
        cache[sid] = s.logistic_type || 'sin_dato';
      }
      if (cache[sid] !== 'self_service') continue;
      its.forEach(it => {
        const u = num(it.quantity) * fac[it.item.id];
        unidades += u;
        detalle.push({ dia, orden: o.id, item: it.item.id, cant: num(it.quantity), unidades: u });
      });
    }
    await store.saveKey(CLAVE_ENVIOS, cache).catch(() => {});
    return { unidades, detalle };
  }

  async function calcular(nombre, { aplicar = false, soloItem = null, motivo = 'manual' } = {}) {
    const est = await leerEstado();
    const { miembros, prim, cfg } = datosFamilia(est, nombre);
    if (!miembros.length) throw new Error(`No hay publicaciones en Costos con la familia "${nombre}".`);
    if (!prim) throw new Error(`La familia "${nombre}" no tiene tarjeta en Stock.`);

    const movs = (prim.movimientosFlex || []).filter(m => m.fecha && num(m.unidades));
    const signo = m => (m.tipo === 'devolucion' ? -1 : 1) * num(m.unidades);
    const corte = prim.flexFechaConteo || '';
    const desdeMov = movs.map(m => m.fecha).sort()[0] || '';
    if (!corte && !desdeMov) throw new Error('La familia no tiene datos de Flex (ni conteo ni envíos a Flex): no se puede calcular.');
    const base = num(prim.flexConteo);
    const movNeto = movs.filter(m => m.fecha > corte && m.estado !== 'enCamino').reduce((t, m) => t + signo(m), 0);

    const c = await ctx();
    const v = await ventasFlex(c, miembros, corte || desdeMov, !corte);
    const margen = Math.max(0, num(cfg.margen));
    const flexReal = Math.max(0, base + movNeto - v.unidades);
    const pool = Math.max(0, flexReal - margen);

    const publicaciones = [];
    for (const m of miembros) {
      const fila = { item: m.id, sku: m.sku, factor: m.factor, actual: null, objetivo: Math.floor(pool / m.factor), estado: null, logistica: null, accion: 'sin cambios' };
      try {
        const b = (await axios.get(`${c.API}/items/${m.id}`, c.auth)).data;
        fila.actual = b.available_quantity;
        fila.estado = b.status;
        fila.logistica = b.shipping && b.shipping.logistic_type;
        if (fila.logistica === 'fulfillment') { fila.accion = 'FULL: no se toca'; fila.objetivo = null; }
        else if (Array.isArray(b.variations) && b.variations.length) { fila.accion = 'tiene variaciones: no se toca'; }
        else if (fila.actual !== fila.objetivo) {
          fila.accion = aplicar && (!soloItem || soloItem === m.id) ? 'actualizar' : 'cambiaría';
        }
      } catch (e) {
        fila.accion = 'error al leer';
        fila.error = (e.response && e.response.data && e.response.data.message) || e.message;
      }
      publicaciones.push(fila);
    }

    if (aplicar) {
      for (const f of publicaciones.filter(x => x.accion === 'actualizar')) {
        try {
          await axios.put(`${c.API}/items/${f.item}`, { available_quantity: f.objetivo }, c.auth);
          f.accion = 'actualizado';
        } catch (e) {
          f.accion = 'error al actualizar';
          f.error = (e.response && e.response.data && (e.response.data.message || JSON.stringify(e.response.data.cause || ''))) || e.message;
        }
      }
    }

    const reporte = {
      familia: nombre, generado_en: new Date().toISOString(), motivo, aplicado: !!aplicar, solo_item: soloItem,
      flex: { conteo: base, fecha_conteo: corte || null, envios_y_devoluciones: movNeto, ventas_flex: v.unidades, real: flexReal, margen, publicado: pool },
      ventas_flex_detalle: v.detalle,
      publicaciones,
    };
    if (aplicar) {
      const ult = (await store.readKey(CLAVE_ULTIMO)) || {};
      ult[nombre] = reporte;
      await store.saveKey(CLAVE_ULTIMO, ult).catch(() => {});
    }
    return reporte;
  }

  // ---- Automático: después de cada venta ----
  const timers = {};
  const corriendo = {};
  function programar(nombre, motivo) {
    clearTimeout(timers[nombre]);
    timers[nombre] = setTimeout(async () => {
      if (corriendo[nombre]) { programar(nombre, motivo); return; }
      corriendo[nombre] = true;
      try {
        const r = await calcular(nombre, { aplicar: true, motivo });
        const cambios = r.publicaciones.filter(p => p.accion === 'actualizado').map(p => `${p.sku} ${p.actual}→${p.objetivo}`);
        console.log(`[familia-stock] ${nombre}: Flex ${r.flex.publicado} u (${motivo}). ${cambios.length ? cambios.join(', ') : 'sin cambios'}`);
      } catch (e) {
        console.error(`[familia-stock] ${nombre}:`, e.response?.data || e.message);
      } finally { corriendo[nombre] = false; }
    }, ESPERA_MS);
  }

  async function alNotificar(ordenId) {
    const est = await leerEstado();
    const activas = Object.keys(est.cfg).filter(k => est.cfg[k] && est.cfg[k].activo);
    if (!activas.length) return;
    const c = await ctx();
    const orden = (await axios.get(`${c.API}/orders/${ordenId}`, c.auth)).data;
    const itemIds = new Set((orden.order_items || []).map(it => it.item && it.item.id));
    activas.forEach(nombre => {
      const { miembros } = datosFamilia(est, nombre);
      if (miembros.some(m => itemIds.has(m.id))) programar(nombre, `orden ${ordenId} (${orden.status})`);
    });
  }

  const api = express.Router();
  api.get('/ultimo', async (req, res) => {
    try { res.json((await store.readKey(CLAVE_ULTIMO)) || {}); } catch (e) { res.status(500).json({ error: e.message }); }
  });
  api.get('/', async (req, res) => {
    const nombre = String(req.query.familia || '').trim();
    if (!nombre) return res.status(400).json({ error: 'Falta ?familia=' });
    try {
      res.json(await calcular(nombre, { aplicar: req.query.aplicar === '1', soloItem: req.query.item ? String(req.query.item).toUpperCase() : null }));
    } catch (e) {
      res.status(500).json({ error: e.message, detalle: e.response?.data });
    }
  });

  return { api, alNotificar };
};
