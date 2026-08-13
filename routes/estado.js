const express = require('express');

// ---------------------------------------------------------------------------
// Estado del panel guardado EN EL SERVIDOR
//
//   GET  /api/estado   -> devuelve todo lo cargado (costos, cotizaciones, stock…)
//   PUT  /api/estado   -> lo guarda
//
// Es lo que permite abrir el panel desde la computadora, el celular o cualquier
// navegador y ver siempre la misma información. Antes vivía solo en el navegador.
//
// El cuerpo es el mismo formato del archivo de respaldo: un objeto con las
// claves del panel y su contenido, así el respaldo exportado se puede importar
// tal cual y viceversa.
// ---------------------------------------------------------------------------

const CLAVE = 'jopex_estado_panel';

module.exports = (app) => {
  const router = express.Router();
  const store = app.locals.store;

  router.get('/', async (req, res) => {
    try {
      const guardado = await store.readKey(CLAVE);
      if (!guardado) {
        return res.json({ vacio: true, datos: {}, guardado_en: null, version: 0 });
      }
      res.json({ vacio: false, ...guardado });
    } catch (err) {
      console.error(err.message);
      res.status(500).json({ error: 'No se pudo leer el estado.', detalle: err.message });
    }
  });

  router.put('/', async (req, res) => {
    try {
      const datos = req.body && req.body.datos;
      if (!datos || typeof datos !== 'object') {
        return res.status(400).json({ error: 'Falta el objeto "datos".' });
      }
      // Guardamos un número de versión creciente. Sirve para detectar si otro
      // dispositivo guardó algo más nuevo mientras vos editabas.
      const previo = await store.readKey(CLAVE);
      const version = (previo && Number(previo.version) || 0) + 1;
      const paquete = {
        version,
        guardado_en: new Date().toISOString(),
        origen: req.body.origen || null,
        datos,
      };
      await store.saveKey(CLAVE, paquete);
      res.json({ ok: true, version, guardado_en: paquete.guardado_en });
    } catch (err) {
      console.error(err.message);
      res.status(500).json({ error: 'No se pudo guardar el estado.', detalle: err.message });
    }
  });

  return router;
};
