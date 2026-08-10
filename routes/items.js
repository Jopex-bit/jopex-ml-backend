const express = require('express');
const axios = require('axios');

module.exports = (app) => {
  const router = express.Router();

  // GET /api/items — lista todas tus publicaciones activas con stock y precio actual.
  router.get('/', async (req, res) => {
    try {
      const token = await app.locals.getAccessTokenValido();
      const tokens = app.locals.leerTokens();

      // 1) Buscar los IDs de todas las publicaciones del vendedor
      const buscar = await axios.get(`${app.locals.ML_API}/users/${tokens.user_id}/items/search`, {
        headers: { Authorization: `Bearer ${token}` },
        params: { status: 'active', limit: 100 },
      });
      const ids = buscar.data.results;
      if (!ids.length) return res.json({ items: [] });

      // 2) Traer el detalle de todas juntas (multiget, hasta 20 por request según límite de ML)
      const chunks = [];
      for (let i = 0; i < ids.length; i += 20) chunks.push(ids.slice(i, i + 20));

      const items = [];
      for (const chunk of chunks) {
        const detalle = await axios.get(`${app.locals.ML_API}/items`, {
          headers: { Authorization: `Bearer ${token}` },
          params: { ids: chunk.join(',') },
        });
        detalle.data.forEach((d) => {
          if (d.code === 200) {
            items.push({
              id: d.body.id,
              titulo: d.body.title,
              sku: d.body.seller_sku,
              precio: d.body.price,
              stock_disponible: d.body.available_quantity,
              stock_vendido: d.body.sold_quantity,
              estado: d.body.status,
            });
          }
        });
      }

      res.json({ items });
    } catch (err) {
      console.error(err.response?.data || err.message);
      res.status(500).json({ error: 'No se pudieron obtener las publicaciones.', detalle: err.response?.data || err.message });
    }
  });

  return router;
};
