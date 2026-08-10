const express = require('express');
const axios = require('axios');

module.exports = (app) => {
  const router = express.Router();

  // GET /api/orders?desde=2026-08-01&hasta=2026-08-31
  // Devuelve los pedidos del vendedor en ese rango de fechas.
  router.get('/', async (req, res) => {
    try {
      const token = await app.locals.getAccessTokenValido();
      const tokens = app.locals.leerTokens();
      const { desde, hasta } = req.query;

      const params = { seller: tokens.user_id };
      if (desde) params['order.date_created.from'] = `${desde}T00:00:00.000-00:00`;
      if (hasta) params['order.date_created.to'] = `${hasta}T23:59:59.000-00:00`;

      const resp = await axios.get(`${app.locals.ML_API}/orders/search`, {
        headers: { Authorization: `Bearer ${token}` },
        params,
      });

      // Devolvemos un resumen simplificado, listo para usar en el módulo Evolución/Stock.
      const pedidos = resp.data.results.map((o) => ({
        id: o.id,
        fecha: o.date_created,
        estado: o.status,
        total: o.total_amount,
        items: o.order_items.map((i) => ({
          titulo: i.item.title,
          sku: i.item.seller_sku || i.item.id,
          cantidad: i.quantity,
          precio_unitario: i.unit_price,
        })),
      }));

      res.json({ total: resp.data.paging?.total, pedidos });
    } catch (err) {
      console.error(err.response?.data || err.message);
      res.status(500).json({ error: 'No se pudieron obtener los pedidos.', detalle: err.response?.data || err.message });
    }
  });

  return router;
};
