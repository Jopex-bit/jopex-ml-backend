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

function diasDelMes(anio, mesIdx) {
  return new Date(anio, mesIdx + 1, 0).getDate();
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
      const hasta = new Date();
      const desde = new Date();
      desde.setMonth(desde.getMonth() - meses);
      desde.setDate(1);
      desde.setHours(0, 0, 0, 0);

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

      // ---- Agregar por publicación ----
      const porItem = {};
      let contadasPagadas = 0, ignoradasCanceladas = 0;

      todas.forEach((o) => {
        const pagada = o.status === 'paid';
        if (!pagada) { ignoradasCanceladas++; return; }
        contadasPagadas++;
        const f = new Date(o.date_created);
        const claveMes = f.getFullYear() + '-' + String(f.getMonth() + 1).padStart(2, '0');
        const claveDia = f.toISOString().slice(0, 10);

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
            };
          }
          const q = Number(it.quantity) || 0;
          porItem[id].meses[claveMes] = (porItem[id].meses[claveMes] || 0) + q;
          porItem[id].dias[claveDia] = (porItem[id].dias[claveDia] || 0) + q;
          porItem[id].unidades_total += q;
        });
      });

      // ---- Armar la serie de meses continua (incluye meses sin ventas) ----
      const serieMeses = [];
      const cursor = new Date(desde);
      while (cursor <= hasta) {
        serieMeses.push({
          clave: cursor.getFullYear() + '-' + String(cursor.getMonth() + 1).padStart(2, '0'),
          mes: MESES[cursor.getMonth()],
          anio: cursor.getFullYear(),
          dias_calendario: diasDelMes(cursor.getFullYear(), cursor.getMonth()),
        });
        cursor.setMonth(cursor.getMonth() + 1);
      }

      const items = Object.values(porItem).map((x) => ({
        ml_item_id: x.ml_item_id,
        titulo: x.titulo,
        unidades_total: x.unidades_total,
        mensuales: serieMeses.map((m) => ({
          mes: m.mes,
          anio: m.anio,
          clave: m.clave,
          unidades: x.meses[m.clave] || 0,
          // Días de calendario del mes. OJO: el modelo de stock usa "días CON STOCK",
          // que puede ser menor si hubo quiebre. Ese ajuste lo hace el usuario.
          dias_calendario: m.dias_calendario,
        })),
        diarias: Object.keys(x.dias).sort().map((f) => ({ fecha: f, unidades: x.dias[f] })),
      }));

      res.json({
        generado_en: new Date().toISOString(),
        desde: desde.toISOString().slice(0, 10),
        hasta: hasta.toISOString().slice(0, 10),
        ordenes_leidas: todas.length,
        ordenes_pagadas: contadasPagadas,
        ordenes_ignoradas: ignoradasCanceladas,
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
