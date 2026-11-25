const axios = require('axios');

// ---------------------------------------------------------------------------
// Detalle de varias publicaciones de Mercado Libre, a prueba de publicaciones
// "rebeldes".
//
// Desde fines de nov/2026 ML responde 403 "Resource deprecated - client no
// longer allowed to consume this resource" al multiget /items?ids=... cuando
// en el lote entra alguna publicación puntual (verificado: 7 de 75 de la
// cuenta), y eso tiraba abajo TODO el lote — y con él la sincronización de
// Costos y Stock. Esas mismas publicaciones se leen bien con /items/{id}.
//
// Por eso: se intenta el multiget y, si falla el lote entero o alguna
// entrada viene con error, se piden esas publicaciones de a una. Devuelve el
// mismo formato que el multiget ([{ code, body }], en el orden de `ids`), así
// los que lo usan no cambian. Una publicación que tampoco se puede leer sola
// vuelve con code != 200 y body { id, message } — no corta al resto.
// ---------------------------------------------------------------------------

async function unaPorUna(API, auth, id) {
  try {
    const r = await axios.get(`${API}/items/${id}`, { ...auth, timeout: 15000 });
    return { code: 200, body: r.data, individual: true };
  } catch (e) {
    const d = e.response && e.response.data;
    return { code: (e.response && e.response.status) || 500, body: { id, message: (d && (d.message || d.error)) || e.message } };
  }
}

async function multigetItems(API, auth, ids) {
  let data = null;
  try {
    const r = await axios.get(`${API}/items`, { ...auth, timeout: 20000, params: { ids: ids.join(',') } });
    data = Array.isArray(r.data) ? r.data : null;
  } catch (e) {
    data = null; // el lote entero falló: van todas de a una
  }
  const out = new Array(ids.length);
  const pendientes = [];
  ids.forEach((id, i) => {
    const d = data && data[i];
    if (d && d.code === 200 && d.body) out[i] = d;
    else pendientes.push(i);
  });
  for (let k = 0; k < pendientes.length; k += 5) {
    await Promise.all(pendientes.slice(k, k + 5).map(async (i) => { out[i] = await unaPorUna(API, auth, ids[i]); }));
  }
  return out;
}

module.exports = { multigetItems };
