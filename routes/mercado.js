const express = require('express');
const axios = require('axios');

// ---------------------------------------------------------------------------
// RADAR DE MERCADO — investigación de oportunidades
//
//   GET /api/mercado?q=collar+gps+perro
//
// Devuelve la radiografía de una búsqueda en Mercado Libre y, sobre esa base,
// calcula CUÁNTO PODÉS PAGAR por el producto para que el negocio cierre.
//
// La lógica es al revés de la intuición: no parte del costo para calcular el
// precio, parte del precio real de mercado para calcular el costo máximo.
//
// Parámetros:
//   q             (obligatorio) qué buscar. Ej: q=collar gps perro
//   paginas       cuántas páginas de 50 leer. Por defecto 3 (150 publicaciones).
//   margen        margen neto objetivo en %. Por defecto 35.
//   impuestos     % de impuestos/retenciones sobre la venta. Por defecto 0.
//   envio         costo de envío que pagás vos, en pesos. Si no lo pasás, se
//                 intenta medir con las dimensiones (ver abajo).
//   dimensiones   para medir el envío contra tu cuenta. Ej: 20x15x10,500
//                 (ancho x alto x largo en cm, coma, peso en gramos)
//   multiplicador cuántas veces el precio FOB te sale el producto puesto acá
//                 (flete + impuestos + despacho). Por defecto 2.
//   precio        forzar el precio de referencia en vez de usar la mediana.
//   guardar=0     no guardar la foto de hoy (por defecto sí la guarda).
//
// Rutas auxiliares:
//   GET /api/mercado/tendencias?categoria=MLA1071   -> lo más buscado
//   GET /api/mercado/masvendidos?categoria=MLA1071  -> los más vendidos
//   GET /api/mercado/historial?q=collar+gps+perro   -> fotos guardadas y deltas
//
// IMPORTANTE SOBRE LOS DATOS:
// Mercado Libre ofusca las cantidades en los recursos públicos: en vez de un
// número devuelve rangos ("RANGO_51_100"). Por eso acá NUNCA se lee el campo
// crudo: todo pasa por parseCantidad(), que devuelve mínimo, máximo y un
// estimado. Y por eso el radar guarda una foto por vez: la diferencia entre
// dos fotos es la única medición REAL de cuánto se vendió en el período.
// ---------------------------------------------------------------------------

const SITIO = 'MLA';

// --- Cantidades ofuscadas -> {min, max, estimado} --------------------------
function parseCantidad(v) {
  if (v === null || v === undefined) return { min: null, max: null, estimado: null, exacto: false, crudo: null };
  if (typeof v === 'number' && isFinite(v)) return { min: v, max: v, estimado: v, exacto: true, crudo: v };
  const texto = String(v);
  const m = texto.match(/RANGO_(\d+)_(\d+)/i);
  if (m) {
    const min = Number(m[1]), max = Number(m[2]);
    return { min, max, estimado: Math.round((min + max) / 2), exacto: false, crudo: texto };
  }
  const n = Number(texto);
  if (isFinite(n)) return { min: n, max: n, estimado: n, exacto: true, crudo: texto };
  return { min: null, max: null, estimado: null, exacto: false, crudo: texto };
}

function mediana(nums) {
  if (!nums.length) return null;
  const o = nums.slice().sort((a, b) => a - b);
  const m = Math.floor(o.length / 2);
  return o.length % 2 ? o[m] : (o[m - 1] + o[m]) / 2;
}

function pct(parte, total) {
  if (!total) return null;
  return Number(((parte / total) * 100).toFixed(1));
}

// Clave estable para guardar la foto de una búsqueda
function claveBusqueda(q) {
  return 'jopex_radar_' + String(q).toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60);
}

module.exports = (app) => {
  const router = express.Router();

  async function enTandas(lista, tam, fn) {
    const out = [];
    for (let i = 0; i < lista.length; i += tam) {
      out.push(...await Promise.all(lista.slice(i, i + tam).map(fn)));
    }
    return out;
  }

  // =========================================================================
  // RADAR PRINCIPAL
  // =========================================================================
  router.get('/', async (req, res) => {
    // Cada intento contra la API queda registrado acá: si algo no vino, se ve
    // por qué, en vez de aparecer como un cero silencioso.
    const diagnostico = [];
    const anotar = (paso, e) => diagnostico.push({
      paso,
      status: e?.response?.status || null,
      detalle: e?.response?.data?.message || e?.response?.data?.error || e?.message || String(e),
    });

    try {
      const q = String(req.query.q || '').trim();
      if (!q) return res.status(400).json({ error: 'Indicá qué buscar. Ej: /api/mercado?q=collar gps perro' });

      const token = await app.locals.getAccessTokenValido();
      const tokens = app.locals.leerTokens();
      const API = app.locals.ML_API;
      const auth = { headers: { Authorization: `Bearer ${token}` } };
      const uid = tokens.user_id;

      const paginas = Math.min(Math.max(Number(req.query.paginas) || 3, 1), 10);
      const margenObjetivo = Math.min(Math.max(Number(req.query.margen) || 35, 1), 90);
      const impuestosPct = Math.min(Math.max(Number(req.query.impuestos) || 0, 0), 60);
      const multiplicador = Math.min(Math.max(Number(req.query.multiplicador) || 2, 1), 10);

      // ---- 1) Traer las publicaciones que compiten ----
      const crudos = [];
      let universo = null;
      for (let p = 0; p < paginas; p++) {
        const offset = p * 50;
        if (offset >= 1000) break; // ML no pagina más allá de 1000 en modo normal
        try {
          const r = await axios.get(`${API}/sites/${SITIO}/search`, {
            ...auth,
            params: { q, limit: 50, offset },
            timeout: 20000,
          });
          const lote = r.data?.results || [];
          universo = r.data?.paging?.total ?? universo;
          crudos.push(...lote);
          if (lote.length < 50) break;
        } catch (e) {
          anotar('busqueda offset ' + offset, e);
          break;
        }
      }

      if (!crudos.length) {
        return res.json({
          consulta: q, generado_en: new Date().toISOString(),
          error: 'La búsqueda no devolvió publicaciones.', diagnostico,
        });
      }

      // ---- 2) Normalizar cada publicación ----
      const pubs = crudos.map((it) => {
        const vend = parseCantidad(it.sold_quantity);
        const stock = parseCantidad(it.available_quantity);
        return {
          id: it.id,
          titulo: it.title,
          permalink: it.permalink,
          precio: typeof it.price === 'number' ? it.price : null,
          precio_original: it.original_price ?? null,
          vendedor_id: it.seller?.id ?? null,
          vendedor: it.seller?.nickname ?? null,
          tienda_oficial: it.official_store_id ?? null,
          categoria: it.category_id ?? null,
          tipo_publicacion: it.listing_type_id === 'gold_pro' ? 'Premium' : 'Clásica',
          full: it.shipping?.logistic_type === 'fulfillment',
          envio_gratis: Boolean(it.shipping?.free_shipping),
          catalogo: Boolean(it.catalog_listing),
          producto_catalogo: it.catalog_product_id ?? null,
          cuotas_sin_interes: it.installments ? it.installments.rate === 0 : null,
          vendidos: vend,
          stock,
        };
      });

      // ---- 3) Radiografía del mercado ----
      const precios = pubs.map((p) => p.precio).filter((n) => typeof n === 'number' && n > 0);
      const precioMediana = mediana(precios);
      const precioRef = Number(req.query.precio) > 0 ? Number(req.query.precio) : precioMediana;

      // Reparto por vendedor: por cantidad de publicaciones Y por ventas estimadas
      const porVendedor = {};
      pubs.forEach((p) => {
        const k = p.vendedor_id || 'sin_dato';
        if (!porVendedor[k]) {
          porVendedor[k] = {
            vendedor_id: p.vendedor_id, vendedor: p.vendedor,
            publicaciones: 0, vendidos_estimado: 0, con_full: 0,
            precio_min: null, precio_max: null, medalla: null, reputacion: null,
          };
        }
        const v = porVendedor[k];
        v.publicaciones++;
        if (p.vendidos.estimado != null) v.vendidos_estimado += p.vendidos.estimado;
        if (p.full) v.con_full++;
        if (typeof p.precio === 'number') {
          v.precio_min = v.precio_min == null ? p.precio : Math.min(v.precio_min, p.precio);
          v.precio_max = v.precio_max == null ? p.precio : Math.max(v.precio_max, p.precio);
        }
      });
      const vendedores = Object.values(porVendedor)
        .sort((a, b) => b.vendidos_estimado - a.vendidos_estimado || b.publicaciones - a.publicaciones);

      const totalVendidosEstimado = vendedores.reduce((a, v) => a + v.vendidos_estimado, 0);
      const lider = vendedores[0] || null;
      const top3 = vendedores.slice(0, 3).reduce((a, v) => a + v.vendidos_estimado, 0);

      // ---- 4) Medallas del top 10 (la señal de saturación más fina) ----
      // Mucho Platinum concentrado = mercado maduro, difícil de atacar.
      await enTandas(vendedores.slice(0, 10), 4, async (v) => {
        if (!v.vendedor_id) return;
        try {
          const r = await axios.get(`${API}/users/${v.vendedor_id}`, { ...auth, timeout: 10000 });
          v.medalla = r.data?.seller_reputation?.power_seller_status ?? null; // silver | gold | platinum
          v.reputacion = r.data?.seller_reputation?.level_id ?? null;         // ej "5_green"
          if (!v.vendedor) v.vendedor = r.data?.nickname ?? null;
        } catch (e) {
          anotar('reputacion ' + v.vendedor_id, e);
        }
      });
      const conMedalla = vendedores.slice(0, 10).filter((v) => v.medalla);
      const platinum = conMedalla.filter((v) => v.medalla === 'platinum').length;

      // ---- 5) Categoría dominante (define la comisión) ----
      const conteoCat = {};
      pubs.forEach((p) => { if (p.categoria) conteoCat[p.categoria] = (conteoCat[p.categoria] || 0) + 1; });
      const categoriaDominante = Object.keys(conteoCat).sort((a, b) => conteoCat[b] - conteoCat[a])[0] || null;

      const radiografia = {
        universo_publicaciones: universo,
        publicaciones_analizadas: pubs.length,
        vendedores_distintos: vendedores.length,
        concentracion_lider_pct: lider ? pct(lider.vendidos_estimado, totalVendidosEstimado) : null,
        concentracion_top3_pct: pct(top3, totalVendidosEstimado),
        publicaciones_del_lider_pct: lider ? pct(lider.publicaciones, pubs.length) : null,
        en_full_pct: pct(pubs.filter((p) => p.full).length, pubs.length),
        en_catalogo_pct: pct(pubs.filter((p) => p.catalogo).length, pubs.length),
        envio_gratis_pct: pct(pubs.filter((p) => p.envio_gratis).length, pubs.length),
        premium_pct: pct(pubs.filter((p) => p.tipo_publicacion === 'Premium').length, pubs.length),
        platinum_en_top10_pct: conMedalla.length ? pct(platinum, conMedalla.length) : null,
        precio_min: precios.length ? Math.min(...precios) : null,
        precio_mediana: precioMediana,
        precio_max: precios.length ? Math.max(...precios) : null,
        categoria_dominante: categoriaDominante,
        ventas_estimadas_acumuladas: totalVendidosEstimado || null,
        nota_ventas: 'Las unidades vendidas son ACUMULADAS desde que se publicó cada aviso, y ' +
          'Mercado Libre las devuelve por rangos. Sirven para comparar entre competidores, no ' +
          'como venta mensual. La venta real del período sale de comparar dos fotos: ver /api/mercado/historial.',
      };

      // =====================================================================
      // 6) EL CÁLCULO QUE DECIDE: cuánto podés pagar por este producto
      // =====================================================================
      const economia = {
        precio_referencia: precioRef,
        margen_objetivo_pct: margenObjetivo,
        comision_ml: null,
        comision_detalle: null,
        envio_vendedor: null,
        impuestos: null,
        ganancia_pretendida: null,
        costo_maximo_landed: null,
        costo_maximo_recomendado: null,
        precio_fob_maximo: null,
        multiplicador_importacion: multiplicador,
        viable: null,
      };

      if (precioRef && categoriaDominante) {
        // Comisión real medida contra tu cuenta (incluye cargo fijo y financiación)
        try {
          const r = await axios.get(`${API}/sites/${SITIO}/listing_prices`, {
            ...auth,
            params: { price: precioRef, category_id: categoriaDominante, listing_type_id: 'gold_pro' },
          });
          const d = Array.isArray(r.data) ? r.data[0] : r.data;
          economia.comision_ml = d?.sale_fee_amount ?? null;
          economia.comision_detalle = {
            porcentaje_total: d?.sale_fee_details?.percentage_fee ?? null,
            porcentaje_meli: d?.sale_fee_details?.meli_percentage_fee ?? null,
            porcentaje_financiacion: d?.sale_fee_details?.financing_add_on_fee ?? null,
            cargo_fijo: d?.sale_fee_details?.fixed_fee ?? null,
          };
        } catch (e) {
          anotar('comision', e);
        }

        // Envío: el que pasaste, o medido con las dimensiones contra tu cuenta
        if (Number(req.query.envio) >= 0 && req.query.envio !== undefined) {
          economia.envio_vendedor = Number(req.query.envio);
        } else if (req.query.dimensiones) {
          try {
            const r = await axios.get(`${API}/users/${uid}/shipping_options/free`, {
              ...auth,
              params: {
                dimensions: req.query.dimensiones,
                item_price: precioRef,
                listing_type_id: 'gold_pro',
                mode: 'me2', condition: 'new', logistic_type: 'drop_off', verbose: true,
              },
            });
            economia.envio_vendedor = r.data?.coverage?.all_country?.list_cost ?? null;
          } catch (e) {
            anotar('envio por dimensiones', e);
          }
        }

        const comision = economia.comision_ml || 0;
        const envio = economia.envio_vendedor || 0;
        economia.impuestos = Number((precioRef * impuestosPct / 100).toFixed(2));
        economia.ganancia_pretendida = Number((precioRef * margenObjetivo / 100).toFixed(2));

        const techo = precioRef - comision - envio - economia.impuestos - economia.ganancia_pretendida;
        economia.costo_maximo_landed = Number(techo.toFixed(2));
        // 10% de colchón por el dólar y el flete, que se mueven.
        economia.costo_maximo_recomendado = Number((techo * 0.9).toFixed(2));
        economia.precio_fob_maximo = Number((techo * 0.9 / multiplicador).toFixed(2));
        economia.viable = techo > 0;
        economia.como_se_lee =
          'Puesto en tu casa en Resistencia, con flete e impuestos de importación incluidos, ' +
          'este producto no te puede costar más de $' + economia.costo_maximo_recomendado + '. ' +
          'Si el proveedor pide más, se descarta.';
      } else {
        anotar('economia', new Error('Faltó precio de referencia o categoría dominante.'));
      }

      // =====================================================================
      // 7) SEMÁFORO
      // =====================================================================
      const motivos = [];
      let color = 'verde';
      const r = radiografia;

      if (economia.viable === false) { color = 'rojo'; motivos.push('Al precio de mercado no queda margen: el costo máximo da negativo.'); }
      if (r.concentracion_lider_pct != null && r.concentracion_lider_pct >= 50) { color = 'rojo'; motivos.push('Un solo vendedor se lleva la mitad o más del rubro.'); }
      if (r.en_catalogo_pct != null && r.en_catalogo_pct >= 60) { color = 'rojo'; motivos.push('La mayoría se vende por catálogo: se pelea por precio en una sola ficha.'); }
      if (r.platinum_en_top10_pct != null && r.platinum_en_top10_pct >= 70) { color = color === 'rojo' ? 'rojo' : 'amarillo'; motivos.push('El top está dominado por vendedores Platinum: mercado maduro.'); }
      if (r.en_full_pct != null && r.en_full_pct >= 70) { color = color === 'rojo' ? 'rojo' : 'amarillo'; motivos.push('Casi todos están en Full: sin Full arrancás en desventaja.'); }
      if (r.vendedores_distintos != null && r.vendedores_distintos < 5) { color = color === 'rojo' ? 'rojo' : 'amarillo'; motivos.push('Muy pocos vendedores: puede ser una oportunidad o un producto sin demanda. Verificar a mano.'); }
      if (color === 'verde') motivos.push('Competencia repartida, sin barrera de Full ni de catálogo, y el precio de mercado deja margen.');

      const semaforo = {
        color,
        motivos,
        criterios_usados: {
          margen_minimo_pct: margenObjetivo,
          rojo_si_lider_supera_pct: 50,
          rojo_si_catalogo_supera_pct: 60,
          amarillo_si_platinum_top10_supera_pct: 70,
          amarillo_si_full_supera_pct: 70,
        },
      };

      // =====================================================================
      // 8) Guardar la foto de hoy (para medir movimiento la próxima vez)
      // =====================================================================
      let historial = null;
      if (String(req.query.guardar || '1') !== '0' && app.locals.store) {
        try {
          const clave = claveBusqueda(q);
          const previo = await app.locals.store.readKey(clave);
          const fotos = (previo && Array.isArray(previo.fotos)) ? previo.fotos : [];
          const foto = {
            fecha: new Date().toISOString(),
            universo,
            precio_mediana: precioMediana,
            vendedores_distintos: vendedores.length,
            en_full_pct: radiografia.en_full_pct,
            items: pubs.slice(0, 80).map((p) => ({
              id: p.id, v: p.vendedor_id, p: p.precio, e: p.vendidos.estimado,
            })),
          };
          const anterior = fotos.length ? fotos[fotos.length - 1] : null;
          fotos.push(foto);
          // Guardamos hasta 26 fotos (medio año si la corrés semanal).
          await app.locals.store.saveKey(clave, { consulta: q, fotos: fotos.slice(-26) });

          if (anterior) {
            const antes = {};
            (anterior.items || []).forEach((x) => { antes[x.id] = x; });
            const movidas = [];
            foto.items.forEach((x) => {
              const a = antes[x.id];
              if (a && x.e != null && a.e != null && x.e > a.e) {
                movidas.push({ id: x.id, vendedor_id: x.v, unidades_del_periodo: x.e - a.e, precio: x.p });
              }
            });
            movidas.sort((a, b) => b.unidades_del_periodo - a.unidades_del_periodo);
            const totalPeriodo = movidas.reduce((a, x) => a + x.unidades_del_periodo, 0);
            const porVend = {};
            movidas.forEach((m) => { porVend[m.vendedor_id] = (porVend[m.vendedor_id] || 0) + m.unidades_del_periodo; });
            historial = {
              foto_anterior: anterior.fecha,
              dias_entre_fotos: Number(((Date.parse(foto.fecha) - Date.parse(anterior.fecha)) / 86400000).toFixed(1)),
              unidades_del_periodo: totalPeriodo,
              publicaciones_que_se_movieron: movidas.length,
              top_publicaciones: movidas.slice(0, 10),
              reparto_real_por_vendedor: Object.keys(porVend)
                .map((k) => ({ vendedor_id: k, unidades: porVend[k], participacion_pct: pct(porVend[k], totalPeriodo) }))
                .sort((a, b) => b.unidades - a.unidades).slice(0, 10),
              nota: totalPeriodo > 0
                ? 'ESTA es la participación real de cada vendedor: medida, no estimada.'
                : 'Entre las dos fotos no se detectó movimiento. Puede ser que haya pasado muy ' +
                  'poco tiempo, o que Mercado Libre devuelva las cantidades por rangos demasiado ' +
                  'anchos como para notar el cambio. Dejá pasar al menos una semana entre fotos.',
            };
          } else {
            historial = {
              foto_anterior: null,
              nota: 'Primera foto de esta búsqueda. Volvé a correrla en 7 días y acá vas a ver ' +
                'cuántas unidades vendió cada uno en el período, que es el dato que vale.',
            };
          }
        } catch (e) {
          anotar('guardar foto', e);
        }
      }

      res.json({
        consulta: q,
        generado_en: new Date().toISOString(),
        semaforo,
        radiografia,
        economia,
        historial,
        vendedores: vendedores.slice(0, 15),
        publicaciones: pubs.slice(0, 30),
        // Qué campos llegaron de verdad: sirve para saber en qué confiar.
        campos_disponibles: {
          vendidos_exactos: pubs.some((p) => p.vendidos.exacto),
          vendidos_por_rango: pubs.some((p) => !p.vendidos.exacto && p.vendidos.estimado != null),
          vendidos_ausentes: pubs.every((p) => p.vendidos.estimado == null),
          reputacion_de_terceros: conMedalla.length > 0,
          logistic_type: pubs.some((p) => p.full),
          catalogo: pubs.some((p) => p.catalogo),
        },
        diagnostico,
      });
    } catch (err) {
      console.error(err.response?.data || err.message);
      res.status(500).json({
        error: 'No se pudo armar el radar.',
        detalle: err.response?.data || err.message,
        diagnostico,
      });
    }
  });

  // =========================================================================
  // TENDENCIAS — lo más buscado (la única fuente de DEMANDA que da ML)
  // =========================================================================
  router.get('/tendencias', async (req, res) => {
    try {
      const token = await app.locals.getAccessTokenValido();
      const API = app.locals.ML_API;
      const cat = req.query.categoria ? '/' + req.query.categoria : '';
      const r = await axios.get(`${API}/trends/${SITIO}${cat}`, {
        headers: { Authorization: `Bearer ${token}` }, timeout: 15000,
      });
      const lista = Array.isArray(r.data) ? r.data : [];
      res.json({
        categoria: req.query.categoria || 'todas',
        generado_en: new Date().toISOString(),
        cantidad: lista.length,
        // Orden documentado por ML: las primeras son las que MÁS CRECEN.
        mas_crecen: lista.slice(0, 10),
        mas_deseadas: lista.slice(10, 30),
        mas_populares: lista.slice(30, 50),
        nota: 'Las 10 primeras comparan las últimas dos semanas: ahí están las tendencias que ' +
          'recién arrancan, que es donde conviene entrar. Se actualiza una vez por semana.',
      });
    } catch (err) {
      res.status(500).json({
        error: 'No se pudieron leer las tendencias.',
        status: err.response?.status || null,
        detalle: err.response?.data || err.message,
        ayuda: err.response?.status === 403
          ? 'Un 403 acá significa que tu aplicación no tiene permiso para Tendencias. Se habilita en el DevCenter de ML.'
          : null,
      });
    }
  });

  // =========================================================================
  // MÁS VENDIDOS de una categoría
  // =========================================================================
  router.get('/masvendidos', async (req, res) => {
    try {
      const cat = String(req.query.categoria || '').trim();
      if (!cat) return res.status(400).json({ error: 'Indicá ?categoria=MLA1071' });

      const token = await app.locals.getAccessTokenValido();
      const API = app.locals.ML_API;
      const auth = { headers: { Authorization: `Bearer ${token}` } };

      const r = await axios.get(`${API}/highlights/${SITIO}/category/${cat}`, { ...auth, timeout: 15000 });
      const contenido = r.data?.content || [];

      // Cada puesto puede ser una publicación o un producto de catálogo.
      const items = contenido.filter((c) => c.type === 'ITEM').map((c) => c.id);
      const detalles = {};
      for (let i = 0; i < items.length; i += 20) {
        try {
          const d = await axios.get(`${API}/items`, { ...auth, params: { ids: items.slice(i, i + 20).join(',') } });
          d.data.forEach((x) => { if (x.code === 200 && x.body) detalles[x.body.id] = x.body; });
        } catch (e) { /* seguimos con lo que haya */ }
      }

      res.json({
        categoria: cat,
        generado_en: new Date().toISOString(),
        ranking: contenido.map((c) => {
          const b = detalles[c.id];
          return {
            posicion: c.position,
            tipo: c.type,
            id: c.id,
            titulo: b?.title || null,
            precio: b?.price ?? null,
            vendedor_id: b?.seller_id ?? null,
            full: b?.shipping?.logistic_type === 'fulfillment',
            catalogo: Boolean(b?.catalog_listing),
            permalink: b?.permalink || null,
          };
        }),
        nota: 'Máximo 20 puestos. Si un producto no aparece, no tiene volumen suficiente para el ranking.',
      });
    } catch (err) {
      res.status(500).json({
        error: 'No se pudieron leer los más vendidos.',
        status: err.response?.status || null,
        detalle: err.response?.data || err.message,
      });
    }
  });

  // =========================================================================
  // HISTORIAL — las fotos guardadas de una búsqueda
  // =========================================================================
  router.get('/historial', async (req, res) => {
    try {
      const q = String(req.query.q || '').trim();
      if (!q) return res.status(400).json({ error: 'Indicá ?q=lo que buscaste' });
      const guardado = await app.locals.store.readKey(claveBusqueda(q));
      if (!guardado) return res.json({ consulta: q, fotos: [], nota: 'Todavía no hay fotos de esta búsqueda.' });
      res.json({
        consulta: q,
        cantidad_fotos: guardado.fotos.length,
        fotos: guardado.fotos.map((f) => ({
          fecha: f.fecha, universo: f.universo, precio_mediana: f.precio_mediana,
          vendedores_distintos: f.vendedores_distintos, en_full_pct: f.en_full_pct,
          publicaciones_guardadas: (f.items || []).length,
        })),
      });
    } catch (err) {
      res.status(500).json({ error: 'No se pudo leer el historial.', detalle: err.message });
    }
  });

  return router;
};
