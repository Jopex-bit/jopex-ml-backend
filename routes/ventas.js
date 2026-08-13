const express = require('express');
const axios = require('axios');

// ---------------------------------------------------------------------------
// GET /api/ventas?meses=6
//
// Devuelve las ventas REALES por publicación, agregadas por mes y por día.
// Alimenta el módulo Stock: hoy esas unidades se cargan a mano mes por mes.
//
// Solo cuenta órdenes pagadas (excluye canceladas), porque una venta cancelada
// no consumió stock.
// ---------------------------------------------------------------------------

const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

// El servidor de Render corre en UTC, pero el negocio está en Argentina (UTC-3).
// Sin esto, después de las 21:00 hora argentina el servidor ya cuenta el día
// siguiente, y una venta de la noche se imputaría al día equivocado.
const TZ_AR = 'America/Argentina/Buenos_Aires';
const fmtAR = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ_AR, year: 'numeric', month: '2-digit', day: '2-digit'
});

// Devuelve la fecha de un instante EN HORA ARGENTINA, como {anio, mes, dia, iso}
function fechaAR(d) {
  const iso = fmtAR.format(d || new Date()); // en-CA da YYYY-MM-DD
  const [anio, mes, dia] = iso.split('-').map(Number);
  return { anio, mes, dia, iso };
}

function diasDelMes(anio, mesIdx) {
  return new Date(Date.UTC(anio, mesIdx + 1, 0)).getUTCDate();
}

module.exports = (app) => {
  const router = express.Router();

  router.get('/', async (req, res) => {
    try {
      const token = await app.locals.getAccessTokenValido();
      const tokens = app.locals.leerTokens();
      const API = app.locals.ML_API;
      const auth = { headers: { Authorization: `Bearer ${token}` } };
      const uid = tokens.user_id;

      const meses = Math.min(Math.max(Number(req.query.meses) || 6, 1), 24);
      // Qué estados cuentan como venta. Por defecto solo 'paid'.
      // El panel de métricas de ML puede contar otros estados, por eso es configurable.
      const estadosOk = String(req.query.estados || 'paid').split(',').map(s => s.trim()).filter(Boolean);
      // Todo el cálculo de fechas se hace en hora argentina, no en la del servidor.
      const hoyAR = fechaAR();
      const hasta = new Date();
      // Primer día del mes, "meses" atrás, en hora argentina
      let anioDesde = hoyAR.anio;
      let mesDesde = hoyAR.mes - meses; // 1..12
      while (mesDesde <= 0) { mesDesde += 12; anioDesde -= 1; }
      // 03:00 UTC = 00:00 en Argentina
      const desde = new Date(Date.UTC(anioDesde, mesDesde - 1, 1, 3, 0, 0));

      // ---- Traer TODAS las órdenes del período (paginado) ----
      const todas = [];
      let offset = 0;
      const limit = 50;
      let total = null;
      while (offset < 2000) {
        const r = await axios.get(`${API}/orders/search`, {
          ...auth,
          params: {
            seller: uid,
            'order.date_created.from': desde.toISOString().slice(0, 19) + '.000-00:00',
            'order.date_created.to': hasta.toISOString().slice(0, 19) + '.000-00:00',
            sort: 'date_asc',
            limit,
            offset,
          },
        });
        const res_ = r.data.results || [];
        todas.push(...res_);
        total = r.data.paging?.total ?? res_.length;
        offset += limit;
        if (offset >= total || res_.length === 0) break;
      }

      // ---- Clasificar cada venta por vía de despacho ----
      // FULL (fulfillment) descuenta del stock que informa ML.
      // Envío propio (correo/colecta) descuenta de TU depósito.
      // Sin esto no se puede saber de dónde salió cada unidad.
      const tipoPorShipment = {};
      const idsEnvio = [];
      todas.forEach((o) => {
        if (!estadosOk.includes(o.status)) return;
        const sid = o.shipping && o.shipping.id;
        if (sid && !tipoPorShipment[sid]) { tipoPorShipment[sid] = null; idsEnvio.push(sid); }
      });
      let enviosLeidos = 0, enviosFallidos = 0;
      for (let i = 0; i < idsEnvio.length; i += 5) {
        const tanda = idsEnvio.slice(i, i + 5);
        await Promise.all(tanda.map(async (sid) => {
          try {
            const r = await axios.get(`${API}/shipments/${sid}`, { ...auth, timeout: 8000 });
            tipoPorShipment[sid] = r.data?.logistic_type || null;
            enviosLeidos++;
          } catch (e) {
            enviosFallidos++;
          }
        }));
      }
      const esFull = (o) => {
        const sid = o.shipping && o.shipping.id;
        const lt = sid ? tipoPorShipment[sid] : null;
        return lt === 'fulfillment';
      };

      // ---- Agregar por publicación ----
      const porItem = {};
      let contadasPagadas = 0, ignoradasCanceladas = 0;
      // Desglose por estado: sirve para comparar contra el panel de métricas de ML
      // y entender de dónde sale cualquier diferencia.
      const porEstado = {};

      todas.forEach((o) => {
        const st = o.status || 'desconocido';
        if (!porEstado[st]) porEstado[st] = { ordenes: 0, unidades: 0 };
        porEstado[st].ordenes++;
        (o.order_items || []).forEach((it) => {
          porEstado[st].unidades += Number(it.quantity) || 0;
        });

        const pagada = estadosOk.includes(st);
        if (!pagada) { ignoradasCanceladas++; return; }
        contadasPagadas++;
        // La fecha de la orden también se interpreta en hora argentina.
        const fAR = fechaAR(new Date(o.date_created));
        const claveMes = fAR.anio + '-' + String(fAR.mes).padStart(2, '0');
        const claveDia = fAR.iso;

        (o.order_items || []).forEach((it) => {
          const id = it.item?.id;
          if (!id) return;
          if (!porItem[id]) {
            porItem[id] = {
              ml_item_id: id,
              titulo: it.item?.title || null,
              meses: {},
              dias: {},
              unidades_total: 0,
              unidades_full: 0,      // vendidas y despachadas por FULL
              unidades_propias: 0,   // vendidas y despachadas por vos
              unidades_sin_dato: 0,
            };
          }
          const q = Number(it.quantity) || 0;
          porItem[id].meses[claveMes] = (porItem[id].meses[claveMes] || 0) + q;
          porItem[id].dias[claveDia] = (porItem[id].dias[claveDia] || 0) + q;
          porItem[id].unidades_total += q;
          const sid = o.shipping && o.shipping.id;
          const lt = sid ? tipoPorShipment[sid] : null;
          if (lt === 'fulfillment') porItem[id].unidades_full += q;
          else if (lt) porItem[id].unidades_propias += q;
          else porItem[id].unidades_sin_dato += q;
        });
      });

      // ---- Armar la serie de meses continua (incluye meses sin ventas) ----
      const claveMesActual = hoyAR.anio + '-' + String(hoyAR.mes).padStart(2, '0');
      const diasTranscurridosMesActual = hoyAR.dia; // hoy es el día N del mes, en Argentina
      const serieMeses = [];
      const cursor = new Date(Date.UTC(anioDesde, mesDesde - 1, 1, 12, 0, 0));
      const finSerie = new Date(Date.UTC(hoyAR.anio, hoyAR.mes - 1, 1, 12, 0, 0));
      while (cursor <= finSerie) {
        const clave = cursor.getUTCFullYear() + '-' + String(cursor.getUTCMonth() + 1).padStart(2, '0');
        const esMesActual = clave === claveMesActual;
        const calendario = diasDelMes(cursor.getUTCFullYear(), cursor.getUTCMonth());
        serieMeses.push({
          clave,
          mes: MESES[cursor.getUTCMonth()],
          anio: cursor.getUTCFullYear(),
          es_mes_actual: esMesActual,
          dias_calendario: calendario,
          // Para el mes en curso hay que dividir por los días TRANSCURRIDOS, no por
          // el mes entero: si no, el ritmo del mes actual queda subestimado y el
          // modelo de stock termina pidiendo de menos.
          dias_transcurridos: esMesActual ? diasTranscurridosMesActual : calendario,
        });
        cursor.setUTCMonth(cursor.getUTCMonth() + 1);
      }

      const items = Object.values(porItem).map((x) => ({
        ml_item_id: x.ml_item_id,
        titulo: x.titulo,
        unidades_total: x.unidades_total,
        // De dónde salió cada unidad vendida:
        unidades_vendidas_full: x.unidades_full,
        unidades_vendidas_propias: x.unidades_propias,
        unidades_vendidas_sin_dato: x.unidades_sin_dato,
        mensuales: serieMeses.map((m) => ({
          mes: m.mes,
          anio: m.anio,
          clave: m.clave,
          unidades: x.meses[m.clave] || 0,
          es_mes_actual: m.es_mes_actual,
          dias_calendario: m.dias_calendario,
          // Días a usar como divisor: el mes entero, salvo el mes en curso, donde
          // van los días transcurridos. OJO: el modelo usa "días CON STOCK", que
          // puede ser menor si hubo quiebre. Ese ajuste lo hace el usuario.
          dias_transcurridos: m.dias_transcurridos,
        })),
        diarias: Object.keys(x.dias).sort().map((f) => ({ fecha: f, unidades: x.dias[f] })),
      }));

      const unidadesContadas = items.reduce((a, x) => a + x.unidades_total, 0);
      const totalTodosLosEstados = Object.values(porEstado)
        .reduce((a, x) => ({ ordenes: a.ordenes + x.ordenes, unidades: a.unidades + x.unidades }),
                { ordenes: 0, unidades: 0 });

      res.json({
        generado_en: new Date().toISOString(),
        envios_consultados: enviosLeidos,
        envios_sin_dato: enviosFallidos,
        zona_horaria: TZ_AR,
        hoy_en_argentina: hoyAR.iso,
        desde: fechaAR(desde).iso,
        hasta: hoyAR.iso,
        estados_contados: estadosOk,
        ordenes_leidas: todas.length,
        ordenes_pagadas: contadasPagadas,
        ordenes_ignoradas: ignoradasCanceladas,
        unidades_contadas: unidadesContadas,
        // Para comparar contra el panel de métricas de Mercado Libre:
        comparacion: {
          contando_solo: estadosOk.join(', '),
          ordenes: contadasPagadas,
          unidades: unidadesContadas,
          contando_todos_los_estados: totalTodosLosEstados,
          por_estado: porEstado
        },
        meses: serieMeses,
        items,
      });
    } catch (err) {
      console.error(err.response?.data || err.message);
      res.status(500).json({
        error: 'No se pudieron obtener las ventas.',
        detalle: err.response?.data || err.message,
      });
    }
  });

  return router;
};
