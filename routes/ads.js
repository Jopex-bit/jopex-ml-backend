const express = require('express');
const axios = require('axios');

// AVISO IMPORTANTE: la API de Publicidad de Mercado Libre (Product Ads) suele requerir
// una habilitación aparte de la cuenta — no alcanza con crear la Aplicación y pedir el
// scope general. Este archivo queda como esqueleto: hay que confirmar contra la
// documentación vigente de https://developers.mercadolibre.com.ar el endpoint exacto,
// porque cambia más seguido que el resto de la API y no tengo forma de verificarlo
// en vivo desde acá.
module.exports = (app) => {
  const router = express.Router();

  router.get('/', async (req, res) => {
    try {
      const token = await app.locals.getAccessTokenValido();
      const tokens = app.locals.leerTokens();

      // Endpoint de referencia (VERIFICAR vigencia antes de usar en producción):
      // GET https://api.mercadolibre.com/advertising/product_ads/campaigns
      const resp = await axios.get(`${app.locals.ML_API}/advertising/product_ads/campaigns`, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Api-Version': '1',
        },
      });

      res.json(resp.data);
    } catch (err) {
      console.error(err.response?.data || err.message);
      res.status(501).json({
        error: 'Módulo de Ads sin confirmar contra la documentación vigente de ML — revisar antes de usar.',
        detalle: err.response?.data || err.message,
      });
    }
  });

  return router;
};
