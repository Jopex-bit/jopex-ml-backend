const express = require('express');
const axios = require('axios');
const { multigetItems } = require('../ml-items');

// ---------------------------------------------------------------------------
// Guardia de ofertas: ninguna oferta de Mercado Libre puede dejar margen negativo.
//
// Cada 30 minutos (mientras el servidor está despierto) y a pedido, revisa todas las
// ofertas VIGENTES y PROGRAMADAS de tus campañas (relámpago, ofertas del día, precio
// tachado, etc.). Para cada una calcula lo que te queda con el precio de la oferta:
//
//   precio − cargo por venta − cargo fijo − cuotas − envío − retención IIBB − costo
//
// con los valores que informa Mercado Libre A ESE PRECIO (listing_prices y envío gratis),
// el costo efectivo que guarda el panel (jopex_costos_efectivos, el mismo de Costos) y la
// retención promedio de IIBB (/api/costos/iibb). Si el margen da $0 o menos, saca la
// publicación de esa oferta y avisa por Telegram.
//
// Sin costo cargado en el panel, la publicación NO se toca (se informa como "sin costo").
//
//   GET  /api/guardia-ofertas            simula (no saca nada) y devuelve el análisis
//   POST /api/guardia-ofertas/ejecutar   revisa y saca las ofertas a pérdida
//   GET  /api/guardia-ofertas/ultima     resultado de la última corrida automática
// ---------------------------------------------------------------------------

const CLAVE_ESTADO = 'jopex_estado_panel';
const CLAVE_ULTIMA = 'jopex_guardia_ofertas';
const CLAVE_IIBB = 'jopex_iibb_promedio';
const UMBRAL_ENVIO_GRATIS = 33000;
// Flex: promedio de las zonas de Novaflex + empaquetado; ML acredita el envío del comprador
// debajo de $33.000 (promedio de sus zonas) y una bonificación del 10 % desde $33.000.
const FLEX_COSTO = (4300 + 4500 + 6300 + 8300) / 4 + 1500;
const FLEX_ZONA_ML = (4990 + 6990 + 8990 + 10490) / 4;
// Tipos de promoción con precio por publicación (los cupones no tienen precio propio).
const TIPOS = new Set(['LIGHTNING', 'SMART_LIGHTNING', 'DEAL', 'SMART', 'PRICE_DISCOUNT', 'UNHEALTHY_STOCK',
  'SELLER_CAMPAIGN', 'MARKETPLACE_CAMPAIGN', 'PRICE_MATCHING', 'PRICE_MATCHING_MELI_ALL', 'PRE_NEGOTIATED', 'VOLUME']);
const INTERVALO_MS = 30 * 60 * 1000;

const fmt = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function enTandas(lista, tam, fn) {
  const out = [];
  for (let i = 0; i < lista.length; i += tam) out.push(...(await Promise.all(lista.slice(i, i + tam).map(fn))));
  return out;
}

module.exports = (app, enviarTelegram) => {
  const store = app.locals.store;
  let corriendo = false;

  async function ctx() {
    const token = await app.locals.getAccessTokenValido();
    const tokens = app.locals.leerTokens();
    return { API: app.locals.ML_API, uid: tokens.user_id, auth: { headers: { Authorization: `Bearer ${token}` }, timeout: 20000 } };
  }

  async function leerCostos() {
    const e = await store.readKey(CLAVE_ESTADO).catch(() => null);
    try { return JSON.parse((e && e.datos && e.datos.jopex_costos_efectivos) || '{}') || {}; } catch (x) { return {}; }
  }

  // Todas las ofertas vigentes y programadas de las campañas del vendedor, agrupadas por publicación.
  async function leerOfertas(c) {
    const r = await axios.get(`${c.API}/seller-promotions/users/${c.uid}`, { ...c.auth, params: { app_version: 'v2' } });
    const campanas = (Array.isArray(r.data) ? r.data : r.data?.results || [])
      .filter((x) => TIPOS.has(x.type) && (x.status === 'started' || x.status === 'pending'));
    const porItem = {};
    await enTandas(campanas, 3, async (camp) => {
      let searchAfter = null;
      for (let pag = 0; pag < 20; pag++) {
        let rr;
        try {
          rr = await axios.get(`${c.API}/seller-promotions/promotions/${camp.id}/items`, {
            ...c.auth,
            params: { promotion_type: camp.type, app_version: 'v2', limit: 49, ...(searchAfter ? { search_after: searchAfter } : {}) },
          });
        } catch (e) { break; }
        const filas = Array.isArray(rr.data) ? rr.data : rr.data?.results || [];
        filas.forEach((x) => {
          if (!x.id || !(x.status === 'started' || x.status === 'pending') || !(x.price > 0)) return;
          const m = /^OFFER-[A-Z]+\d+-(\d+)$/.exec(String(x.ref_id || ''));
          (porItem[x.id] = porItem[x.id] || []).push({
            promotion_id: camp.id, promotion_type: camp.type, campana: camp.name || camp.type,
            estado: x.status, precio: x.price, precio_original: x.original_price ?? null,
            offer_id: m ? m[1] : null, desde: x.start_date || null, hasta: x.finish_date || x.end_date || null,
            meli_pct: x.meli_percentage ?? null, vendedor_pct: x.seller_percentage ?? null,
          });
        });
        searchAfter = rr.data?.paging?.searchAfter || rr.data?.paging?.search_after || null;
        if (!searchAfter || !filas.length) break;
      }
    });
    return porItem;
  }

  // Lo que te queda por unidad vendiendo esa publicación a ese precio.
  async function margenA(c, b, precio, costo, finPct, iibbPct) {
    const lt = b.shipping?.logistic_type || 'drop_off';
    const r = await axios.get(`${c.API}/sites/MLA/listing_prices`, {
      ...c.auth, params: { price: precio, category_id: b.category_id, listing_type_id: b.listing_type_id, logistic_type: lt, shipping_mode: 'me2' },
    });
    const d = Array.isArray(r.data) ? r.data[0] : r.data;
    const det = d?.sale_fee_details || {};
    const cargoPct = Number(det.meli_percentage_fee ?? det.percentage_fee ?? 0);
    const fijo = Number(det.fixed_fee ?? 0);
    let envio = 0;
    if (lt === 'self_service') envio = precio >= UMBRAL_ENVIO_GRATIS ? FLEX_COSTO - FLEX_ZONA_ML * 0.1 : FLEX_COSTO - FLEX_ZONA_ML;
    else if (precio >= UMBRAL_ENVIO_GRATIS) {
      const params = { item_id: b.id, item_price: precio, listing_type_id: b.listing_type_id, mode: 'me2', condition: b.condition || 'new', logistic_type: lt, verbose: true };
      if (b.shipping?.dimensions) params.dimensions = b.shipping.dimensions;
      const s = await axios.get(`${c.API}/users/${c.uid}/shipping_options/free`, { ...c.auth, params });
      envio = Number(s.data?.coverage?.all_country?.list_cost ?? 0);
    }
    const partes = {
      cargo: precio * cargoPct / 100, fijo, cuotas: precio * (Number(finPct) || 0) / 100, envio,
      iibb: precio * (Number(iibbPct) || 0) / 100,
    };
    const margen = precio - partes.cargo - partes.fijo - partes.cuotas - partes.envio - partes.iibb - costo;
    return { precio, costo, cargoPct, ...partes, margen: Math.round(margen * 100) / 100, margenPct: Math.round((margen / precio) * 10000) / 100 };
  }

  async function quitar(c, item, o) {
    const params = { promotion_type: o.promotion_type, app_version: 'v2' };
    if (o.promotion_id) params.promotion_id = o.promotion_id;
    if (o.offer_id) params.offer_id = o.offer_id;
    try {
      await axios.delete(`${c.API}/seller-promotions/items/${item}`, { ...c.auth, params });
      return { ok: true };
    } catch (e) {
      return { ok: false, status: e.response?.status, error: e.response?.data?.message || e.message };
    }
  }

  async function revisar({ ejecutar }) {
    if (corriendo) return { ocupado: true };
    corriendo = true;
    try {
      const c = await ctx();
      const costos = await leerCostos();
      const iibb = await store.readKey(CLAVE_IIBB).catch(() => null);
      const iibbPct = Number(iibb && iibb.pct) || 0;
      const porItem = await leerOfertas(c);
      const ids = Object.keys(porItem);

      const detalles = {};
      for (let i = 0; i < ids.length; i += 20) {
        const lote = await multigetItems(c.API, c.auth, ids.slice(i, i + 20));
        lote.forEach((d) => { if (d.code === 200 && d.body) detalles[d.body.id] = d.body; });
      }

      const revisadas = [], aPerdida = [], sinCosto = [], errores = [];
      await enTandas(ids, 3, async (id) => {
        const b = detalles[id];
        const k = costos[id];
        if (!b) { errores.push({ item: id, error: 'no se pudo leer la publicación' }); return; }
        if (!k || !(k.costo > 0)) { sinCosto.push({ item: id, titulo: b.title, ofertas: porItem[id].length }); return; }
        // Una cuenta por precio distinto (las tandas de una relámpago suelen repetir precio).
        const precios = {};
        for (const o of porItem[id]) {
          // Oferta co-financiada: ML pone su parte del descuento, a vos te llega más que el precio de oferta.
          let pv = o.precio;
          if (o.meli_pct > 0 && o.vendedor_pct >= 0 && o.precio_original > o.precio) {
            pv = o.precio_original - (o.precio_original - o.precio) * (o.vendedor_pct / (o.vendedor_pct + o.meli_pct));
          }
          pv = Math.round(pv * 100) / 100;
          try {
            if (!precios[pv]) precios[pv] = await margenA(c, b, pv, k.costo, k.finPct, iibbPct);
          } catch (e) { errores.push({ item: id, error: e.response?.data?.message || e.message }); continue; }
          const fila = { item: id, sku: k.sku || b.seller_custom_field || '', titulo: b.title, ...o, precio_vendedor: pv, calculo: precios[pv] };
          revisadas.push(fila);
          if (precios[pv].margen <= 0) aPerdida.push(fila);
        }
      });

      // Sacar las que dan pérdida.
      if (ejecutar) {
        for (const f of aPerdida) f.baja = await quitar(c, f.item, f);
      }

      const resultado = {
        en: new Date().toISOString(), ejecutar: !!ejecutar, iibb_pct: iibbPct,
        ofertas_revisadas: revisadas.length, publicaciones: ids.length,
        a_perdida: aPerdida.map((f) => ({
          item: f.item, sku: f.sku, titulo: f.titulo, campana: f.campana, tipo: f.promotion_type, estado: f.estado,
          precio: f.precio, desde: f.desde, hasta: f.hasta, margen: f.calculo.margen, margen_pct: f.calculo.margenPct, baja: f.baja || null,
        })),
        sin_costo: sinCosto, errores,
      };
      if (ejecutar) {
        await store.saveKey(CLAVE_ULTIMA, resultado).catch(() => {});
        await avisar(resultado);
      } else {
        resultado.detalle = revisadas.map((f) => ({ item: f.item, sku: f.sku, campana: f.campana, estado: f.estado, precio: f.precio, ...f.calculo }));
      }
      return resultado;
    } finally {
      corriendo = false;
    }
  }

  // Telegram: aviso de cada baja y, una vez cada 12 h por oferta, de las que no se pudieron sacar.
  async function avisar(r) {
    if (!enviarTelegram) return;
    const quitadas = r.a_perdida.filter((f) => f.baja && f.baja.ok);
    const fallidas = [];
    for (const f of r.a_perdida.filter((x) => !(x.baja && x.baja.ok))) {
      const clave = `jopex_guardia_aviso:${f.item}:${f.tipo}:${f.precio}`;
      if (await store.marcarUnaVez(clave, 12 * 3600).catch(() => true)) fallidas.push(f);
    }
    if (!quitadas.length && !fallidas.length) return;
    const linea = (f) => `• ${esc(f.sku || f.item)} — ${esc(f.campana)} a ${esc(fmt.format(f.precio))}: margen ${esc(fmt.format(f.margen))} (${esc(String(f.margen_pct).replace('.', ','))} %)`;
    const partes = [];
    if (quitadas.length) partes.push('🛑 <b>Ofertas a pérdida que saqué de Mercado Libre</b>', ...quitadas.map(linea));
    if (fallidas.length) {
      if (partes.length) partes.push('');
      partes.push('⚠️ <b>Ofertas a pérdida que NO pude sacar — sacalas a mano</b>',
        ...fallidas.map((f) => linea(f) + `\n   ${esc((f.baja && f.baja.error) || '')}`));
    }
    try { await enviarTelegram(partes.join('\n')); } catch (e) { console.error('[guardia] Telegram:', e.message); }
  }

  const api = express.Router();
  api.get('/', async (req, res) => {
    try { res.json(await revisar({ ejecutar: false })); }
    catch (e) { res.status(500).json({ error: 'No se pudo revisar las ofertas.', detalle: e.response?.data || e.message }); }
  });
  api.post('/ejecutar', async (req, res) => {
    try { res.json(await revisar({ ejecutar: true })); }
    catch (e) { res.status(500).json({ error: 'No se pudo revisar las ofertas.', detalle: e.response?.data || e.message }); }
  });
  api.get('/ultima', async (req, res) => {
    res.json((await store.readKey(CLAVE_ULTIMA).catch(() => null)) || { vacio: true });
  });

  // Automático: un minuto después de arrancar y cada 30 minutos.
  function programar() {
    const correr = () => revisar({ ejecutar: true }).catch((e) => console.error('[guardia] error:', e.response?.data || e.message));
    setTimeout(correr, 60 * 1000);
    setInterval(correr, INTERVALO_MS);
  }

  return { api, revisar, programar };
};
