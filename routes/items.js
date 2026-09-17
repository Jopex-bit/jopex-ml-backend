const express = require('express');
const axios = require('axios');

module.exports = (app) => {
  const router = express.Router();

  // GET /api/items — lista todas tus publicaciones activas con stock, precio,
  // variaciones (si tiene) y el SKU real de cada una.
  //
  // Identificación técnica (confirmado contra la doc oficial de ML):
  //   - "item"     = la publicación completa, id = MLA... (uno por publicación).
  //   - "variación"= dentro de un item con variantes (talle/color/etc.), cada
  //                  una tiene su propio variation_id (un número, NO un MLA
  //                  aparte) y puede tener su propio stock/SKU/precio.
  //   - El SKU del vendedor se guarda correctamente en el atributo SELLER_SKU
  //     (a nivel item si no hay variantes, a nivel de cada variación si las
  //     tiene) — NO en seller_custom_field (deprecado, sin relación con el
  //     atributo, y solo existe a nivel item).
  //   - user_product_id / family_id: entidades nuevas de ML para agrupar
  //     publicaciones que son el mismo producto físico. Se informan tal cual
  //     vienen, sin usarlas todavía.
  const skuDeAtributos = (attrs) => {
    const a = (attrs || []).find((x) => x.id === 'SELLER_SKU');
    return a ? (a.value_name || (a.values && a.values[0] && a.values[0].name) || null) : null;
  };

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
          if (d.code !== 200) return;
          const b = d.body;
          const tieneVariaciones = Array.isArray(b.variations) && b.variations.length > 0;
          items.push({
            id: b.id,
            titulo: b.title,
            sku: skuDeAtributos(b.attributes),
            seller_custom_field: b.seller_custom_field || null, // deprecado, solo referencia
            user_product_id: b.user_product_id || null,
            family_id: b.family_name || null,
            precio: b.price,
            stock_disponible: b.available_quantity,
            stock_vendido: b.sold_quantity,
            estado: b.status,
            tiene_variaciones: tieneVariaciones,
            variaciones: tieneVariaciones ? b.variations.map((v) => ({
              variation_id: v.id,
              sku: skuDeAtributos(v.attribute_combinations) || skuDeAtributos(v.attributes),
              atributos: (v.attribute_combinations || []).map((a) => a.value_name).filter(Boolean).join(' / '),
              precio: v.price != null ? v.price : b.price,
              stock_disponible: v.available_quantity,
            })) : [],
          });
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
