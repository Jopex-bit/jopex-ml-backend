const express = require('express');
const axios = require('axios');

// ---------------------------------------------------------------------------
// Aviso por Telegram de cada venta Flex, al instante.
//
// Mercado Libre llama a POST /webhooks/ml cada vez que cambia una orden
// (tópico orders_v2). Respondemos 200 en el acto (ML exige respuesta rápida o
// reintenta) y procesamos en segundo plano:
//   1. Traemos la orden. Si todavía no está pagada, no avisamos (cuando se
//      pague, ML vuelve a notificar).
//   2. Traemos el envío. Solo seguimos si es Flex (logistic_type self_service).
//   3. Marcamos la orden como avisada (una sola vez, aunque ML notifique 5
//      veces la misma orden) y mandamos el mensaje a Telegram.
//
// Variables de entorno:
//   TELEGRAM_BOT_TOKEN   token del bot (lo da @BotFather)
//   TELEGRAM_CHAT_ID     uno o varios chat id separados por coma
//                        (ej. el tuyo y, más adelante, el del motomandado)
//   NOTIFICAR_TODAS=1    opcional: avisar también ventas no Flex (Full, correo)
//
// Rutas de configuración (protegidas con la API key del panel):
//   GET /api/notificaciones/chat-id   muestra los chats que le escribieron al bot
//   GET /api/notificaciones/test      manda un mensaje de prueba
//   GET /api/notificaciones/orden/:id simula el aviso de una orden real
// ---------------------------------------------------------------------------

const TZ_AR = 'America/Argentina/Buenos_Aires';
const TTL_AVISADA = 30 * 24 * 3600; // 30 días
// Estados del envío en los que la venta todavía requiere despacho.
const PENDIENTE_DESPACHO = ['pending', 'handling', 'ready_to_ship'];

const fmtFecha = new Intl.DateTimeFormat('es-AR', {
  timeZone: TZ_AR, weekday: 'short', day: '2-digit', month: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
});
const fmtPesos = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });

const fmtDia = new Intl.DateTimeFormat('es-AR', { timeZone: TZ_AR, weekday: 'short', day: '2-digit', month: '2-digit' });
const fmtHora = new Intl.DateTimeFormat('es-AR', { timeZone: TZ_AR, hour: '2-digit', minute: '2-digit', hour12: false });

// Si ML manda solo el día (hora 00:00 en Argentina), mostramos solo el día:
// "00:00" haría pensar que hay que entregar a medianoche.
function fecha(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d)) return null;
  return fmtHora.format(d) === '00:00' ? fmtDia.format(d) : fmtFecha.format(d);
}

// Telegram en modo HTML: hay que escapar lo que viene de ML.
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function tipoEnvio(lt) {
  if (lt === 'self_service') return 'FLEX';
  if (lt === 'fulfillment') return 'FULL';
  if (lt === 'cross_docking') return 'COLECTA';
  if (lt === 'drop_off' || lt === 'xd_drop_off') return 'CORREO';
  return lt ? String(lt).toUpperCase() : 'SIN ENVÍO';
}

function chatIds() {
  return String(process.env.TELEGRAM_CHAT_ID || '').split(',').map(s => s.trim()).filter(Boolean);
}

async function enviarTelegram(texto) {
  const bot = process.env.TELEGRAM_BOT_TOKEN;
  const ids = chatIds();
  if (!bot || !ids.length) throw new Error('Faltan TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID.');
  const errores = [];
  for (const chat_id of ids) {
    try {
      await axios.post(`https://api.telegram.org/bot${bot}/sendMessage`, {
        chat_id, text: texto, parse_mode: 'HTML', disable_web_page_preview: true,
      }, { timeout: 10000 });
    } catch (e) {
      errores.push(`${chat_id}: ${e.response?.data?.description || e.message}`);
    }
  }
  if (errores.length === ids.length) throw new Error('Telegram rechazó el mensaje — ' + errores.join(' | '));
  if (errores.length) console.error('[notif] algunos chats fallaron:', errores.join(' | '));
}

// Arma el mensaje a partir de la orden y el envío de ML.
function armarMensaje(orden, envio) {
  const tipo = tipoEnvio(envio?.logistic_type);
  const items = (orden.order_items || []).map(it => {
    const titulo = String(it.item?.title || '');
    // La variante solo si agrega algo que el título no dice ya.
    const extra = (it.item?.variation_attributes || []).map(v => v.value_name).filter(Boolean)
      .filter(v => !titulo.toLowerCase().includes(String(v).toLowerCase()));
    return `• ${esc(it.quantity)} × ${esc(titulo)}` + (extra.length ? ` (${esc(extra.join(', '))})` : '');
  }).join('\n');

  const lineas = [
    `${tipo === 'FLEX' ? '🛵' : '📦'} <b>Venta ${tipo}</b> — ${esc(fmtPesos.format(Number(orden.total_amount) || 0))}`,
    items,
  ];

  const dir = envio?.receiver_address;
  if (dir) {
    const calle = [dir.street_name, dir.street_number].filter(Boolean).join(' ') || dir.address_line;
    const zona = [dir.neighborhood?.name, dir.city?.name].filter(Boolean).join(', ');
    lineas.push('', `📍 ${esc(calle)}${zona ? ' — ' + esc(zona) : ''}`);
    if (dir.comment) lineas.push(`📝 ${esc(dir.comment)}`);
    // ML suele ocultar el teléfono ("XXXXXXX"): solo lo mostramos si trae dígitos.
    const tel = /\d{6,}/.test(String(dir.receiver_phone || '')) ? dir.receiver_phone : null;
    if (dir.receiver_name) lineas.push(`👤 ${esc(dir.receiver_name)}${tel ? ' · ' + esc(tel) : ''}`);
  }

  // Fecha límite de entrega que ML le prometió al comprador.
  const so = envio?.shipping_option || {};
  const limite = fecha(so.estimated_delivery_limit?.date)
    || fecha(so.estimated_delivery_final?.date)
    || fecha(so.estimated_delivery_time?.date);
  if (limite) lineas.push(`⏰ Entregar antes de: <b>${esc(limite)}</b>`);

  lineas.push('', `Orden ${esc(orden.id)}${orden.buyer?.nickname ? ' · ' + esc(orden.buyer.nickname) : ''}`);
  lineas.push(`https://www.mercadolibre.com.ar/ventas/${esc(orden.pack_id || orden.id)}/detalle`);
  return lineas.join('\n');
}

module.exports = (app) => {
  const store = app.locals.store;

  async function ctx() {
    const token = await app.locals.getAccessTokenValido();
    return { API: app.locals.ML_API, auth: { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 } };
  }

  // Trae orden + envío. Devuelve null si no corresponde avisar.
  async function evaluarOrden(ordenId, { forzar } = {}) {
    const c = await ctx();
    const orden = (await axios.get(`${c.API}/orders/${ordenId}`, c.auth)).data;
    if (!forzar && orden.status !== 'paid') return { avisar: false, motivo: `estado ${orden.status}` };

    let envio = null;
    const sid = orden.shipping?.id;
    if (sid) envio = (await axios.get(`${c.API}/shipments/${sid}`, c.auth)).data;

    const esFlex = envio?.logistic_type === 'self_service';
    if (!forzar && !esFlex && process.env.NOTIFICAR_TODAS !== '1') {
      return { avisar: false, motivo: `envío ${envio?.logistic_type || 'sin envío'}` };
    }
    // Solo avisamos lo que todavía hay que despachar. ML vuelve a notificar la
    // orden cuando se despacha, se entrega, se califica, etc.: esos cambios no
    // son ventas nuevas y no tienen que generar mensaje.
    if (!forzar && envio && !PENDIENTE_DESPACHO.includes(envio.status)) {
      return { avisar: false, motivo: `envío en estado ${envio.status}` };
    }
    // Red de seguridad: una orden de hace más de 3 días no es una venta nueva.
    const horas = (Date.now() - new Date(orden.date_created).getTime()) / 3600000;
    if (!forzar && horas > 72) return { avisar: false, motivo: `orden de hace ${Math.round(horas)} h` };
    return { avisar: true, orden, envio, mensaje: armarMensaje(orden, envio) };
  }

  async function procesarNotificacion(n) {
    const tokens = app.locals.leerTokens();
    if (tokens && n.user_id && String(n.user_id) !== String(tokens.user_id)) return; // no es de esta cuenta

    const m = String(n.resource || '').match(/\/orders\/(\d+)/);
    if (n.topic !== 'orders_v2' || !m) return;
    const ordenId = m[1];

    // Stock compartido de las familias de SKU: se recalcula con cualquier cambio de la orden
    // (venta, cancelación). Corre aparte: no depende de que la venta sea Flex ni del aviso.
    if (app.locals.familiaStock) {
      app.locals.familiaStock.alNotificar(ordenId).catch(e =>
        console.error('[familia-stock] orden', ordenId, e.response?.data || e.message));
    }

    const r = await evaluarOrden(ordenId);
    if (!r.avisar) { console.log(`[notif] orden ${ordenId}: sin aviso (${r.motivo})`); return; }

    const clave = `jopex_avisada_${ordenId}`;
    if (!(await store.marcarUnaVez(clave, TTL_AVISADA))) return; // ya se avisó
    try {
      await enviarTelegram(r.mensaje);
      console.log(`[notif] orden ${ordenId}: avisada por Telegram`);
    } catch (e) {
      // Si Telegram falló, liberamos la marca para que el próximo reintento de ML vuelva a probar.
      await store.desmarcar(clave).catch(() => {});
      throw e;
    }
  }

  // ---- Webhook público que llama Mercado Libre ----
  const webhook = express.Router();
  webhook.post('/ml', (req, res) => {
    res.status(200).end(); // ML pide respuesta inmediata; procesamos después
    const n = req.body || {};
    procesarNotificacion(n).catch(e =>
      console.error('[notif] error procesando', n.resource, e.response?.data || e.message));
  });
  // ML a veces valida la URL con un GET
  webhook.get('/ml', (req, res) => res.status(200).send('ok'));

  // ---- Rutas de configuración (con API key) ----
  const api = express.Router();

  api.get('/chat-id', async (req, res) => {
    const bot = process.env.TELEGRAM_BOT_TOKEN;
    if (!bot) return res.status(400).json({ error: 'Falta TELEGRAM_BOT_TOKEN en Render.' });
    try {
      const r = await axios.get(`https://api.telegram.org/bot${bot}/getUpdates`, { timeout: 10000 });
      const chats = {};
      for (const u of r.data.result || []) {
        const ch = (u.message || u.channel_post || {}).chat;
        if (ch) chats[ch.id] = { chat_id: ch.id, nombre: [ch.first_name, ch.last_name].filter(Boolean).join(' ') || ch.title, usuario: ch.username || null };
      }
      res.json({ chats: Object.values(chats), ayuda: 'Si sale vacío: escribile cualquier cosa al bot desde Telegram y volvé a abrir esta URL.' });
    } catch (e) {
      res.status(500).json({ error: e.response?.data?.description || e.message });
    }
  });

  // Mensaje libre al Telegram de JOPEX (lo usa la tarea mensual en la nube que revisa los
  // costos de Mercado Libre). Body: { "texto": "..." }. Va en texto plano, escapado.
  api.post('/mensaje', async (req, res) => {
    const texto = String((req.body && req.body.texto) || '').trim();
    if (!texto) return res.status(400).json({ error: 'Falta "texto".' });
    try {
      await enviarTelegram(esc(texto.slice(0, 3800)));
      res.json({ ok: true, enviado_a: chatIds().length });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  api.get('/test', async (req, res) => {
    try {
      await enviarTelegram('✅ <b>JOPEX</b>: las notificaciones de ventas Flex están funcionando.');
      res.json({ ok: true, enviado_a: chatIds() });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Simula el aviso con una orden real (no marca nada como avisado).
  // Acepta el ID de orden o el número de venta que muestra ML ("Venta #…", que es el pack).
  api.get('/orden/:id', async (req, res) => {
    try {
      let id = req.params.id;
      try {
        const c = await ctx();
        await axios.get(`${c.API}/orders/${id}`, c.auth);
      } catch (e) {
        if (e.response?.status !== 404) throw e;
        const c = await ctx();
        const pack = (await axios.get(`${c.API}/packs/${id}`, c.auth)).data;
        const primera = (pack.orders || [])[0];
        if (!primera) throw new Error('No se encontró orden ni pack con ese número.');
        id = primera.id;
      }
      const r = await evaluarOrden(id, { forzar: true });
      if (req.query.enviar === '1') {
        await enviarTelegram(r.mensaje);
        // La prueba cuenta como aviso: así ML no la vuelve a mandar más tarde.
        await store.marcarUnaVez(`jopex_avisada_${r.orden.id}`, TTL_AVISADA).catch(() => {});
      }
      res.json({ tipo: tipoEnvio(r.envio?.logistic_type), enviado: req.query.enviar === '1', mensaje: r.mensaje });
    } catch (e) {
      res.status(500).json({ error: e.response?.data || e.message });
    }
  });

  return { webhook, api, enviarTelegram };
};
