const express = require('express');
const axios = require('axios');

// ---------------------------------------------------------------------------
// GET /api/dashboard?desde=2026-10-01&hasta=2026-10-28
//
// Datos crudos (ya normalizados) para el módulo Dashboard del panel:
//   - las órdenes de la ventana (período elegido + período anterior + últimos
//     28 días), con comisión, envío a cargo del vendedor, tipo de envío,
//     provincia, cuotas y si el comprador ya había comprado antes
//   - Ads: inversión del período, del período anterior y por día
//   - visitas del período y del anterior (para la conversión)
//   - reputación del vendedor
//   - clientes que vuelven, sobre todo el historial guardado
//
// Los CÁLCULOS de ganancia y margen los hace el panel, porque el costo de cada
// producto (Valor de Adquisición) vive en Costos, en el estado del panel.
//
// Las órdenes y sus envíos se guardan en el store (Upstash) para no volver a
// pedirle a Mercado Libre lo que ya se consultó. Las de los últimos días se
// vuelven a leer siempre, porque pueden cancelarse o cambiar de estado.
// ---------------------------------------------------------------------------

const CLAVE_CACHE = 'jopex_dashboard_cache';
const VERSION_CACHE = 1;
const DIAS_HISTORIAL = 365; // para "clientes que vuelven"
const DIAS_REFRESCO = 20;   // las órdenes más nuevas que esto se releen siempre

// El negocio está en Argentina (UTC-3); el servidor de Render corre en UTC.
const TZ_AR = 'America/Argentina/Buenos_Aires';
const fmtDia = new Intl.DateTimeFormat('en-CA', { timeZone: TZ_AR, year: 'numeric', month: '2-digit', day: '2-digit' });
const fmtHora = new Intl.DateTimeFormat('en-GB', { timeZone: TZ_AR, hour: '2-digit', hour12: false });
const diaAR = d => fmtDia.format(d);
const horaAR = d => Number(fmtHora.format(d)) % 24;
function sumarDias(iso, n) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function diasEntre(a, b) {
  return Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 86400000);
}
const esFecha = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

// Tipo de envío según logistic_type de Mercado Libre.
function tipoEnvio(lt) {
  if (!lt) return null;
  if (lt === 'fulfillment') return 'full';
  if (lt === 'self_service') return 'flex';
  if (lt === 'cross_docking') return 'colecta';
  if (lt === 'drop_off' || lt === 'xd_drop_off') return 'correo';
  return 'otro';
}

// Una orden de ML reducida a lo que usa el Dashboard.
function normalizarOrden(o) {
  const f = new Date(o.date_created);
  const pagos = (o.payments || []).filter(p => p.status === 'approved');
  const cuotas = (pagos.length ? pagos : (o.payments || []))
    .reduce((mx, p) => Math.max(mx, Number(p.installments) || 0), 0) || null;
  return {
    id: o.id,
    ts: f.getTime(),
    dia: diaAR(f),
    hora: horaAR(f),
    estado: o.status || null,
    pack: o.pack_id || null,
    comprador: o.buyer && o.buyer.id ? o.buyer.id : null,
    envio_id: o.shipping && o.shipping.id ? o.shipping.id : null,
    cuotas,
    items: (o.order_items || []).map(it => ({
      id: it.item && it.item.id,
      sku: (it.item && (it.item.seller_sku || it.item.seller_custom_field)) || null,
      titulo: it.item && it.item.title,
      cant: Number(it.quantity) || 0,
      precio: Number(it.unit_price) || 0,
      // sale_fee viene POR UNIDAD (verificado: venta de 1 u a $70.500 → $11.632,5 = 16,5%).
      comision: Number(it.sale_fee) || 0,
    })),
    envio: null, // se completa con /shipments
  };
}

// Serializa las lecturas/escrituras del cache: el refresco del historial corre
// en segundo plano y no tiene que pisar lo que guarda un pedido en paralelo.
let colaCache = Promise.resolve();
function conCache(store, fn, soloLectura) {
  const p = colaCache.then(async () => {
    let c = await store.readKey(CLAVE_CACHE);
    if (!c || c.version !== VERSION_CACHE) c = { version: VERSION_CACHE, ordenes: {}, historial_desde: null, ads_diario: {} };
    if (!c.ads_diario) c.ads_diario = {};
    const r = await fn(c);
    if (!soloLectura) await store.saveKey(CLAVE_CACHE, c);
    return r;
  });
  colaCache = p.catch(() => {});
  return p;
}

let historialEnCurso = false;

module.exports = (app) => {
  const router = express.Router();
  const store = app.locals.store;

  async function contexto() {
    const token = await app.locals.getAccessTokenValido();
    const tokens = app.locals.leerTokens();
    return { API: app.locals.ML_API, uid: tokens.user_id, auth: { headers: { Authorization: `Bearer ${token}` } }, token };
  }

  // Todas las órdenes creadas entre dos días (hora argentina), paginado.
  async function traerOrdenes(ctx, desde, hasta) {
    const todas = [];
    let offset = 0;
    const limit = 50;
    while (offset < 5000) {
      const r = await axios.get(`${ctx.API}/orders/search`, {
        ...ctx.auth,
        timeout: 20000,
        params: {
          seller: ctx.uid,
          'order.date_created.from': `${desde}T00:00:00.000-03:00`,
          'order.date_created.to': `${hasta}T23:59:59.999-03:00`,
          sort: 'date_asc',
          limit,
          offset,
        },
      });
      const res = r.data.results || [];
      todas.push(...res);
      offset += limit;
      const total = (r.data.paging && r.data.paging.total) || 0;
      if (offset >= total || res.length === 0) break;
    }
    return todas;
  }

  // Tipo de envío, provincia y quién paga cuánto. null si ML no respondió.
  async function leerEnvio(ctx, sid) {
    const out = { tipo: null, provincia: null, vendedor: null, comprador: null, ok: false };
    try {
      const r = await axios.get(`${ctx.API}/shipments/${sid}`, { ...ctx.auth, timeout: 10000 });
      out.tipo = tipoEnvio(r.data && r.data.logistic_type);
      const st = r.data && r.data.receiver_address && r.data.receiver_address.state;
      out.provincia = st ? (st.name || st.id || null) : null;
      out.ok = true;
    } catch (e) { return out; }
    try {
      const c = await axios.get(`${ctx.API}/shipments/${sid}/costs`, { ...ctx.auth, timeout: 10000 });
      const senders = (c.data && c.data.senders) || [];
      const yo = senders.find(s => String(s.user_id) === String(ctx.uid)) || senders[0];
      out.vendedor = yo && yo.cost != null ? Number(yo.cost) : null;
      out.comprador = c.data && c.data.receiver && c.data.receiver.cost != null ? Number(c.data.receiver.cost) : null;
    } catch (e) { /* sin costos: queda null y el panel lo marca como sin dato */ }
    return out;
  }

  // ---- Ads ----
  async function adsBase(ctx, diag) {
    try {
      const r = await axios.get(`${ctx.API}/advertising/advertisers`, {
        headers: { ...ctx.auth.headers, 'Api-Version': '1' }, params: { product_id: 'PADS' }, timeout: 15000,
      });
      const lista = (r.data && r.data.advertisers) || (Array.isArray(r.data) ? r.data : []);
      const id = lista.length ? (lista[0].advertiser_id != null ? lista[0].advertiser_id : lista[0].id) : null;
      return id != null ? `${ctx.API}/marketplace/advertising/MLA/advertisers/${id}/product_ads` : null;
    } catch (e) {
      diag.push({ paso: 'ads: advertiser', status: e.response ? e.response.status : null, detalle: e.message });
      return null;
    }
  }
  function sumarMetricas(lista) {
    const t = { inversion: 0, ingresos: 0, ventas: 0, clics: 0, impresiones: 0 };
    lista.forEach(m => {
      if (!m) return;
      t.inversion += Number(m.cost) || 0;
      t.ingresos += Number(m.total_amount) || 0;
      t.ventas += Number(m.units_quantity) || 0;
      t.clics += Number(m.clicks) || 0;
      t.impresiones += Number(m.prints) || 0;
    });
    return t;
  }
  // Totales de Ads entre dos días. Mercado Ads solo guarda 90 días.
  async function adsTotales(ctx, base, desde, hasta, diag) {
    if (!base) return null;
    if (diasEntre(desde, diaAR(new Date())) > 89) return null;
    try {
      const r = await axios.get(`${base}/campaigns/search`, {
        headers: { ...ctx.auth.headers, 'Api-Version': '2' }, timeout: 20000,
        params: { limit: 50, offset: 0, metrics: 'clicks,prints,cost,units_quantity,total_amount', metrics_summary: true, date_from: desde, date_to: hasta },
      });
      if (r.data && r.data.metrics_summary) return sumarMetricas([r.data.metrics_summary]);
      const lista = (r.data && (r.data.results || r.data.campaigns)) || [];
      return sumarMetricas(lista.map(c => c.metrics_summary || c.metrics));
    } catch (e) {
      diag.push({ paso: 'ads: totales ' + desde + '→' + hasta, status: e.response ? e.response.status : null, detalle: (e.response && e.response.data && e.response.data.message) || e.message });
      return null;
    }
  }

  // ---- Clientes que vuelven (sobre todo el historial guardado) ----
  function clientesQueVuelven(ordenes) {
    const pagadas = Object.values(ordenes).filter(o => o.estado === 'paid' && o.comprador)
      .sort((a, b) => a.ts - b.ts);
    const compras = {}; // comprador -> claves de compra (un pack cuenta como una sola compra)
    const recurrente = {};
    pagadas.forEach(o => {
      const k = o.pack || o.id;
      const previas = compras[o.comprador] || (compras[o.comprador] = []);
      recurrente[o.id] = previas.some(x => x !== k);
      if (!previas.includes(k)) previas.push(k);
    });
    const dist = { '1': 0, '2': 0, '3': 0, '4+': 0 };
    Object.values(compras).forEach(l => { const n = l.length; dist[n >= 4 ? '4+' : String(n)]++; });
    const clientes = Object.keys(compras).length;
    return { recurrente, clientes, vuelven: clientes - dist['1'], distribucion: dist };
  }

  // Trae en segundo plano las órdenes viejas (solo fecha, estado y comprador)
  // para que "clientes que vuelven" mire todo el último año.
  async function completarHistorial(ctx, hastaDia) {
    if (historialEnCurso) return;
    historialEnCurso = true;
    try {
      const desde = sumarDias(diaAR(new Date()), -DIAS_HISTORIAL);
      if (hastaDia <= desde) return;
      const crudas = await traerOrdenes(ctx, desde, sumarDias(hastaDia, -1));
      await conCache(store, c => {
        crudas.forEach(o => { if (!c.ordenes[o.id]) c.ordenes[o.id] = normalizarOrden(o); });
        c.historial_desde = desde;
      });
    } catch (e) {
      console.error('Dashboard: no se pudo completar el historial:', e.message);
    } finally {
      historialEnCurso = false;
    }
  }

  router.get('/', async (req, res) => {
    const diagnostico = [];
    try {
      const ctx = await contexto();
      const hoy = diaAR(new Date());
      const desde = esFecha(req.query.desde) ? req.query.desde : hoy.slice(0, 8) + '01';
      const hasta = esFecha(req.query.hasta) && req.query.hasta <= hoy ? req.query.hasta : hoy;
      if (desde > hasta) return res.status(400).json({ error: '"desde" no puede ser posterior a "hasta".' });
      const largo = diasEntre(desde, hasta) + 1;
      const antHasta = sumarDias(desde, -1);
      const antDesde = sumarDias(antHasta, -(largo - 1));
      // Ventana: período + anterior + los últimos 28 días (Ganancia del día compara 14 vs 14).
      const vDesde = antDesde < sumarDias(hoy, -27) ? antDesde : sumarDias(hoy, -27);
      const vHasta = hoy;

      // ---- Órdenes de la ventana: se releen siempre (pueden cancelarse) ----
      const crudas = await traerOrdenes(ctx, vDesde, vHasta);
      const limiteRefresco = sumarDias(hoy, -DIAS_REFRESCO);

      // Qué envíos hay que consultar: los que no están en el cache.
      const previo = await conCache(store, c => ({ ordenes: c.ordenes, ads_diario: c.ads_diario }), true);
      const nuevas = crudas.map(normalizarOrden);
      const pedirEnvio = {};
      nuevas.forEach(o => {
        const vieja = previo.ordenes[o.id];
        const reusar = vieja && vieja.envio && vieja.envio.ok && vieja.envio_id === o.envio_id &&
          (vieja.envio.vendedor != null || o.dia < limiteRefresco);
        if (reusar) o.envio = vieja.envio;
        else if (o.envio_id && o.estado === 'paid') pedirEnvio[o.envio_id] = null;
      });
      const ids = Object.keys(pedirEnvio);
      let enviosFallidos = 0;
      for (let i = 0; i < ids.length; i += 5) {
        await Promise.all(ids.slice(i, i + 5).map(async sid => {
          pedirEnvio[sid] = await leerEnvio(ctx, sid);
          if (!pedirEnvio[sid].ok) enviosFallidos++;
        }));
      }
      nuevas.forEach(o => { if (!o.envio && o.envio_id && pedirEnvio[o.envio_id]) o.envio = pedirEnvio[o.envio_id]; });

      // Un mismo envío puede cubrir varias órdenes (carrito/pack): el costo va
      // una sola vez, a la primera orden; las demás quedan con 0.
      const vistoEnvio = {};
      nuevas.slice().sort((a, b) => a.ts - b.ts).forEach(o => {
        if (!o.envio || !o.envio_id) return;
        if (vistoEnvio[o.envio_id]) o.envio = { ...o.envio, vendedor: o.envio.vendedor != null ? 0 : null, compartido: true };
        else vistoEnvio[o.envio_id] = true;
      });

      // ---- Ads por día (últimos 28 días). Los días cerrados no cambian: se
      // guardan y solo se vuelven a pedir hoy y ayer. ----
      const base = await adsBase(ctx, diagnostico);
      const adsDiario = {};
      if (base) {
        const faltan = [];
        for (let i = 27; i >= 0; i--) {
          const d = sumarDias(hoy, -i);
          if (i >= 2 && previo.ads_diario[d] != null) adsDiario[d] = previo.ads_diario[d];
          else faltan.push(d);
        }
        for (let i = 0; i < faltan.length; i += 4) {
          await Promise.all(faltan.slice(i, i + 4).map(async d => {
            const t = await adsTotales(ctx, base, d, d, diagnostico);
            if (t) adsDiario[d] = t.inversion;
          }));
        }
      }

      const cache = await conCache(store, c => {
        nuevas.forEach(o => { c.ordenes[o.id] = o; });
        Object.assign(c.ads_diario, adsDiario);
        // No guardar días de Ads más viejos que 120 días.
        const corte = sumarDias(hoy, -120);
        Object.keys(c.ads_diario).forEach(d => { if (d < corte) delete c.ads_diario[d]; });
        c.actualizado_en = new Date().toISOString();
        return { ordenes: c.ordenes, historial_desde: c.historial_desde };
      });

      // El historial para "clientes que vuelven" se completa en segundo plano.
      const historialCompleto = !!cache.historial_desde && cache.historial_desde <= sumarDias(hoy, -DIAS_HISTORIAL + 1);
      if (!historialCompleto) completarHistorial(ctx, vDesde);

      const cq = clientesQueVuelven(cache.ordenes);
      const ordenes = nuevas.map(o => ({ ...o, recurrente: !!cq.recurrente[o.id] }));

      // ---- Ads: totales del período y del anterior ----
      const [adsPeriodo, adsAnterior] = await Promise.all([
        adsTotales(ctx, base, desde, hasta, diagnostico),
        adsTotales(ctx, base, antDesde, antHasta, diagnostico),
      ]);

      // ---- Visitas (para la conversión) ----
      const visitas = async (d, h) => {
        try {
          const r = await axios.get(`${ctx.API}/users/${ctx.uid}/items_visits`, {
            ...ctx.auth, timeout: 15000,
            params: { date_from: `${d}T00:00:00.000-03:00`, date_to: `${h}T23:59:59.999-03:00` },
          });
          return r.data && r.data.total_visits != null ? Number(r.data.total_visits) : null;
        } catch (e) {
          diagnostico.push({ paso: 'visitas ' + d + '→' + h, status: e.response ? e.response.status : null, detalle: e.message });
          return null;
        }
      };
      const [visPeriodo, visAnterior] = await Promise.all([visitas(desde, hasta), visitas(antDesde, antHasta)]);

      // ---- Reputación ----
      let reputacion = null;
      try {
        const r = await axios.get(`${ctx.API}/users/${ctx.uid}`, { ...ctx.auth, timeout: 15000 });
        const sr = (r.data && r.data.seller_reputation) || {};
        reputacion = {
          nivel: sr.level_id || null,
          lider: sr.power_seller_status || null,
          ventas_completadas: sr.transactions && sr.transactions.completed != null ? sr.transactions.completed : null,
        };
      } catch (e) {
        diagnostico.push({ paso: 'reputación', status: e.response ? e.response.status : null, detalle: e.message });
      }

      res.json({
        generado_en: new Date().toISOString(),
        hoy,
        zona_horaria: TZ_AR,
        periodo: { desde, hasta, dias: largo },
        anterior: { desde: antDesde, hasta: antHasta },
        ventana: { desde: vDesde, hasta: vHasta },
        ordenes,
        ads: {
          periodo: adsPeriodo,
          anterior: adsAnterior,
          diario: Object.keys(adsDiario).length ? adsDiario : null,
          nota: 'Inversión según Mercado Ads (cost), sin IVA.',
        },
        visitas: { periodo: visPeriodo, anterior: visAnterior },
        reputacion,
        clientes: {
          historial_desde: cache.historial_desde || vDesde,
          historial_completo: historialCompleto,
          clientes: cq.clientes,
          vuelven: cq.vuelven,
          distribucion: cq.distribucion,
        },
        meta: {
          ordenes_leidas: crudas.length,
          envios_consultados: ids.length,
          envios_fallidos: enviosFallidos,
        },
        diagnostico,
      });
    } catch (err) {
      console.error(err.response?.data || err.message);
      res.status(500).json({
        error: 'No se pudo armar el Dashboard.',
        detalle: err.response?.data || err.message,
        diagnostico,
      });
    }
  });

  return router;
};
