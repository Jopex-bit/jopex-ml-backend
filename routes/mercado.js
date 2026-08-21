const express = require('express');
const axios = require('axios');

// ---------------------------------------------------------------------------
// RADAR DE MERCADO v2 — investigación de oportunidades
//
//   GET /api/mercado?q=fuente agua gatos
//   GET /api/mercado/prueba          <- qué puertas de ML están abiertas hoy
//   GET /api/mercado/tendencias?categoria=MLA1071
//   GET /api/mercado/masvendidos?categoria=MLA1071
//   GET /api/mercado/historial?q=fuente agua gatos
//
// Mercado Libre cerró la búsqueda pública (/sites/MLA/search devuelve 403).
// Por eso el radar prueba TRES fuentes en cascada y usa la primera que abra:
//
//   A) Búsqueda pública        -> si algún día la reabren
//   B) Catálogo (la que sirve) -> /products/search + /products/{id}/items
//      Devuelve TODOS los que compiten por cada producto, con precio,
//      unidades vendidas, stock, vendedor y si están en Full.
//   C) Más vendidos            -> /highlights, para explorar una categoría
//
// La respuesta siempre dice qué fuente se usó y qué falló, en "fuente" y
// "diagnostico".
// ---------------------------------------------------------------------------

const SITIO = 'MLA';

// Las cantidades vienen ofuscadas por rangos ("RANGO_51_100"): nunca se lee
// el campo crudo, todo pasa por acá.
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
  // PRUEBA — qué endpoints de ML responden hoy con esta cuenta
  // =========================================================================
  router.get('/prueba', async (req, res) => {
    const salida = {};
    try {
      const token = await app.locals.getAccessTokenValido();
      const tokens = app.locals.leerTokens();
      const API = app.locals.ML_API;
      const auth = { headers: { Authorization: `Bearer ${token}` } };
      const q = String(req.query.q || 'fuente agua gatos');
      const cat = String(req.query.categoria || 'MLA1071');

      const probar = async (nombre, url, params) => {
        try {
          const r = await axios.get(url, { ...auth, params, timeout: 20000 });
          const d = r.data;
          const cant = Array.isArray(d) ? d.length
            : (d?.results?.length ?? d?.content?.length ?? null);
          salida[nombre] = { ok: true, status: r.status, elementos: cant, muestra: JSON.stringify(d).slice(0, 300) };
        } catch (e) {
          salida[nombre] = {
            ok: false,
            status: e.response?.status || null,
            detalle: e.response?.data?.message || e.response?.data?.error || e.message,
          };
        }
      };

      await probar('busqueda_publica', `${API}/sites/${SITIO}/search`, { q, limit: 5 });
      await probar('catalogo_buscar', `${API}/products/search`, { site_id: SITIO, q, limit: 5 });
      await probar('tendencias', `${API}/trends/${SITIO}/${cat}`, null);
      await probar('mas_vendidos', `${API}/highlights/${SITIO}/category/${cat}`, null);
      await probar('mis_publicaciones', `${API}/users/${tokens.user_id}/items/search`, { status: 'active', limit: 1 });

      res.json({
        probado_en: new Date().toISOString(),
        consulta_usada: q,
        categoria_usada: cat,
        resultados: salida,
        lectura: 'Lo que diga ok:true es lo que se puede usar hoy. Lo que dé 403 está cerrado por Mercado Libre.',
      });
    } catch (err) {
      res.status(500).json({ error: 'Falló la prueba.', detalle: err.message, resultados: salida });
    }
  });

  // =========================================================================
  // RADAR PRINCIPAL
  // =========================================================================
  router.get('/', async (req, res) => {
    const diagnostico = [];
    const anotar = (paso, e) => diagnostico.push({
      paso,
      status: e?.response?.status || null,
      detalle: e?.response?.data?.message || e?.response?.data?.error || e?.message || String(e),
    });

    try {
      const q = String(req.query.q || '').trim();
      if (!q) return res.status(400).json({ error: 'Indicá qué buscar. Ej: /api/mercado?q=fuente agua gatos' });

      const token = await app.locals.getAccessTokenValido();
      const tokens = app.locals.leerTokens();
      const API = app.locals.ML_API;
      const auth = { headers: { Authorization: `Bearer ${token}` } };
      const uid = tokens.user_id;

      const margenObjetivo = Math.min(Math.max(Number(req.query.margen) || 35, 1), 90);
      const impuestosPct = Math.min(Math.max(Number(req.query.impuestos) || 0, 0), 60);
      const multiplicador = Math.min(Math.max(Number(req.query.multiplicador) || 2, 1), 10);
      const maxProductos = Math.min(Math.max(Number(req.query.productos) || 6, 1), 15);

      let pubs = [];
      let fuente = null;
      let universo = null;
      const productosCatalogo = [];

      // ---- FUENTE A: búsqueda pública (hoy suele dar 403) ----
      try {
        const r = await axios.get(`${API}/sites/${SITIO}/search`, {
          ...auth, params: { q, limit: 50 }, timeout: 20000,
        });
        const lote = r.data?.results || [];
        if (lote.length) {
          universo = r.data?.paging?.total ?? lote.length;
          fuente = 'busqueda_publica';
          pubs = lote.map((it) => ({
            id: it.id,
            titulo: it.title,
            permalink: it.permalink,
            precio: typeof it.price === 'number' ? it.price : null,
            vendedor_id: it.seller?.id ?? null,
            vendedor: it.seller?.nickname ?? null,
            tienda_oficial: it.official_store_id ?? null,
            categoria: it.category_id ?? null,
            tipo_publicacion: it.listing_type_id === 'gold_pro' ? 'Premium' : 'Clásica',
            full: it.shipping?.logistic_type === 'fulfillment',
            envio_gratis: Boolean(it.shipping?.free_shipping),
            catalogo: Boolean(it.catalog_listing),
            producto_catalogo: it.catalog_product_id ?? null,
            vendidos: parseCantidad(it.sold_quantity),
            stock: parseCantidad(it.available_quantity),
          }));
        }
      } catch (e) {
        anotar('busqueda publica', e);
      }

      // ---- FUENTE B: catálogo (la que funciona) ----
      if (!pubs.length) {
        let encontrados = [];
        try {
          const r = await axios.get(`${API}/products/search`, {
            ...auth,
            // Pedimos de más para poder filtrar los que no tienen que ver.
            params: { site_id: SITIO, q, status: 'active', limit: 20 },
            timeout: 20000,
          });
          encontrados = r.data?.results || [];
          universo = r.data?.paging?.total ?? encontrados.length;
        } catch (e) {
          anotar('buscar en catalogo', e);
        }

        // El buscador de catálogo trae de todo: nos quedamos con las fichas
        // cuyo nombre comparte al menos la mitad de las palabras de la búsqueda.
        const palabras = q.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
          .split(/\s+/).filter((w) => w.length > 2);
        const relevancia = (nombre) => {
          const n = String(nombre || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
          const hits = palabras.filter((w) => n.includes(w)).length;
          return palabras.length ? hits / palabras.length : 1;
        };
        const filtrados = encontrados
          .map((p) => ({ ...p, _rel: relevancia(p.name) }))
          .filter((p) => p._rel >= 0.5)
          .sort((a, b) => b._rel - a._rel);
        const aUsar = (filtrados.length ? filtrados : encontrados).slice(0, maxProductos);
        const descartados = encontrados.length - aUsar.length;
        if (descartados > 0) diagnostico.push({ paso: 'filtro de relevancia', detalle: descartados + ' fichas de catálogo descartadas por no coincidir con la búsqueda.' });

        if (aUsar.length) {
          fuente = 'catalogo';
          await enTandas(aUsar, 3, async (prod) => {
            const pid = prod.id;
            productosCatalogo.push({
              producto_id: pid,
              nombre: prod.name || null,
              estado: prod.status || null,
              competidores: null,
              precio_min: null,
              precio_max: null,
              ganador: null,
            });
            const ficha = productosCatalogo[productosCatalogo.length - 1];

            // Quién gana la ficha hoy. El ganador ya es un competidor válido:
            // lo sumamos siempre, aunque después falle el listado completo.
            try {
              const rp = await axios.get(`${API}/products/${pid}`, { ...auth, timeout: 15000 });
              const w = rp.data?.buy_box_winner;
              ficha.nombre = ficha.nombre || rp.data?.name || null;
              if (w) {
                ficha.ganador = {
                  item_id: w.item_id, vendedor_id: w.seller_id, precio: w.price,
                  full: w.shipping?.logistic_type === 'fulfillment',
                  vendidos: parseCantidad(w.sold_quantity).estimado,
                };
                pubs.push({
                  id: w.item_id,
                  titulo: ficha.nombre,
                  permalink: rp.data?.permalink || null,
                  precio: typeof w.price === 'number' ? w.price : null,
                  vendedor_id: w.seller_id ?? null,
                  vendedor: null,
                  tienda_oficial: w.official_store_id ?? null,
                  categoria: w.category_id ?? null,
                  tipo_publicacion: w.listing_type_id === 'gold_pro' ? 'Premium' : 'Clásica',
                  full: w.shipping?.logistic_type === 'fulfillment',
                  envio_gratis: Boolean(w.shipping?.free_shipping),
                  catalogo: true,
                  producto_catalogo: pid,
                  ganador_ficha: true,
                  vendidos: parseCantidad(w.sold_quantity),
                  stock: parseCantidad(w.available_quantity),
                });
              }
            } catch (e) {
              anotar('ganador de catalogo ' + pid, e);
            }

            // Todos los que compiten por esa ficha
            try {
              const ri = await axios.get(`${API}/products/${pid}/items`, {
                ...auth, params: { limit: 50 }, timeout: 20000,
              });
              const comp = ri.data?.results || [];
              ficha.competidores = ri.data?.paging?.total ?? comp.length;
              const precios = [];
              comp.forEach((c) => {
                if (typeof c.price === 'number') precios.push(c.price);
                pubs.push({
                  id: c.item_id,
                  titulo: prod.name || null,
                  permalink: null,
                  precio: typeof c.price === 'number' ? c.price : null,
                  vendedor_id: c.seller_id ?? null,
                  vendedor: null,
                  tienda_oficial: c.official_store_id ?? null,
                  categoria: c.category_id ?? null,
                  tipo_publicacion: c.listing_type_id === 'gold_pro' ? 'Premium' : 'Clásica',
                  full: c.shipping?.logistic_type === 'fulfillment',
                  envio_gratis: Boolean(c.shipping?.free_shipping),
                  catalogo: true,
                  producto_catalogo: pid,
                  vendidos: parseCantidad(c.sold_quantity),
                  stock: parseCantidad(c.available_quantity),
                });
              });
              if (precios.length) {
                ficha.precio_min = Math.min(...precios);
                ficha.precio_max = Math.max(...precios);
              }
            } catch (e) {
              anotar('competidores de ' + pid, e);
            }
          });
        }
      }

      // El ganador de la ficha también aparece en el listado de competidores:
      // sacamos los repetidos por id de publicación.
      const vistos = {};
      pubs = pubs.filter((p) => {
        if (!p.id) return true;
        if (vistos[p.id]) {
          if (p.ganador_ficha) vistos[p.id].ganador_ficha = true;
          return false;
        }
        vistos[p.id] = p;
        return true;
      });

      if (!pubs.length) {
        return res.json({
          consulta: q, generado_en: new Date().toISOString(), fuente: null,
          error: 'Ninguna fuente de datos respondió. Corré /api/mercado/prueba para ver qué está abierto.',
          diagnostico,
        });
      }

      // ---- Radiografía ----
      const precios = pubs.map((p) => p.precio).filter((n) => typeof n === 'number' && n > 0);
      const precioMediana = mediana(precios);
      const precioRef = Number(req.query.precio) > 0 ? Number(req.query.precio) : precioMediana;

      const porVendedor = {};
      pubs.forEach((p) => {
        const k = p.vendedor_id || 'sin_dato';
        if (!porVendedor[k]) {
          porVendedor[k] = {
            vendedor_id: p.vendedor_id, vendedor: p.vendedor,
            publicaciones: 0, vendidos_estimado: 0, con_full: 0,
            precio_min: null, precio_max: null, medalla: null, reputacion: null, ventas_totales: null,
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

      const totalVendidos = vendedores.reduce((a, v) => a + v.vendidos_estimado, 0);
      const lider = vendedores[0] || null;
      const top3 = vendedores.slice(0, 3).reduce((a, v) => a + v.vendidos_estimado, 0);

      // Medalla de los 10 principales: la señal más fina de saturación
      await enTandas(vendedores.slice(0, 10), 4, async (v) => {
        if (!v.vendedor_id) return;
        try {
          const r = await axios.get(`${API}/users/${v.vendedor_id}`, { ...auth, timeout: 10000 });
          v.medalla = r.data?.seller_reputation?.power_seller_status ?? null;
          v.reputacion = r.data?.seller_reputation?.level_id ?? null;
          v.ventas_totales = r.data?.seller_reputation?.transactions?.completed ?? null;
          if (!v.vendedor) v.vendedor = r.data?.nickname ?? null;
        } catch (e) {
          anotar('reputacion ' + v.vendedor_id, e);
        }
      });
      const conMedalla = vendedores.slice(0, 10).filter((v) => v.medalla);
      const platinum = conMedalla.filter((v) => v.medalla === 'platinum').length;

      const conteoCat = {};
      pubs.forEach((p) => { if (p.categoria) conteoCat[p.categoria] = (conteoCat[p.categoria] || 0) + 1; });
      const categoriaDominante = Object.keys(conteoCat).sort((a, b) => conteoCat[b] - conteoCat[a])[0] || null;

      const radiografia = {
        fuente,
        universo,
        productos_de_catalogo: productosCatalogo.length || null,
        publicaciones_analizadas: pubs.length,
        vendedores_distintos: vendedores.length,
        concentracion_lider_pct: lider ? pct(lider.vendidos_estimado, totalVendidos) : null,
        concentracion_top3_pct: pct(top3, totalVendidos),
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
        ventas_estimadas_acumuladas: totalVendidos || null,
      };

      // ---- El cálculo que decide: cuánto podés pagar ----
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

        if (req.query.envio !== undefined && Number(req.query.envio) >= 0) {
          economia.envio_vendedor = Number(req.query.envio);
        } else if (req.query.dimensiones) {
          try {
            const r = await axios.get(`${API}/users/${uid}/shipping_options/free`, {
              ...auth,
              params: {
                dimensions: req.query.dimensiones, item_price: precioRef,
                listing_type_id: 'gold_pro', mode: 'me2', condition: 'new',
                logistic_type: 'drop_off', verbose: true,
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
        economia.costo_maximo_recomendado = Number((techo * 0.9).toFixed(2));
        economia.precio_fob_maximo = Number((techo * 0.9 / multiplicador).toFixed(2));
        economia.viable = techo > 0;
        economia.como_se_lee = economia.viable
          ? 'Puesto en tu casa, con flete e impuestos de importación incluidos, no te puede costar más de $' +
            economia.costo_maximo_recomendado + '.'
          : 'Al precio de mercado no queda margen: descartado.';
        if (!economia.envio_vendedor) {
          economia.aviso_envio = 'No se calculó el envío. Pasá &envio=7000 o &dimensiones=20x15x10,500 para que el número cierre.';
        }
      }

      // ---- Semáforo ----
      const motivos = [];
      let color = 'verde';
      const r = radiografia;
      if (economia.viable === false) { color = 'rojo'; motivos.push('Al precio de mercado no queda margen.'); }
      if (r.concentracion_lider_pct != null && r.concentracion_lider_pct >= 50) { color = 'rojo'; motivos.push('Un solo vendedor se lleva la mitad o más.'); }
      if (r.platinum_en_top10_pct != null && r.platinum_en_top10_pct >= 70) { color = color === 'rojo' ? 'rojo' : 'amarillo'; motivos.push('El top está dominado por Platinum: mercado maduro.'); }
      if (r.en_full_pct != null && r.en_full_pct >= 70) { color = color === 'rojo' ? 'rojo' : 'amarillo'; motivos.push('Casi todos en Full: sin Full arrancás en desventaja.'); }
      if (fuente === 'catalogo') motivos.push('Datos de catálogo: acá se pelea por precio y reputación en una sola ficha.');
      if (r.vendedores_distintos != null && r.vendedores_distintos < 5) { color = color === 'rojo' ? 'rojo' : 'amarillo'; motivos.push('Muy pocos vendedores: puede ser oportunidad o falta de demanda.'); }
      if (color === 'verde') motivos.push('Competencia repartida y el precio de mercado deja margen.');

      // ---- Foto para medir movimiento la próxima vez ----
      let historial = null;
      if (String(req.query.guardar || '1') !== '0' && app.locals.store) {
        try {
          const clave = claveBusqueda(q);
          const previo = await app.locals.store.readKey(clave);
          const fotos = (previo && Array.isArray(previo.fotos)) ? previo.fotos : [];
          const foto = {
            fecha: new Date().toISOString(), fuente, universo,
            precio_mediana: precioMediana, vendedores_distintos: vendedores.length,
            en_full_pct: radiografia.en_full_pct,
            items: pubs.slice(0, 120).map((p) => ({ id: p.id, v: p.vendedor_id, p: p.precio, e: p.vendidos.estimado })),
          };
          const anterior = fotos.length ? fotos[fotos.length - 1] : null;
          fotos.push(foto);
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
                ? 'Participación REAL de cada vendedor: medida entre las dos fotos.'
                : 'Sin movimiento entre fotos. Dejá pasar al menos una semana.',
            };
          } else {
            historial = { foto_anterior: null, nota: 'Primera foto. Repetí en 7 días para ver quién vendió cuánto.' };
          }
        } catch (e) {
          anotar('guardar foto', e);
        }
      }

      res.json({
        consulta: q,
        generado_en: new Date().toISOString(),
        fuente,
        semaforo: { color, motivos },
        radiografia,
        economia,
        historial,
        productos_catalogo: productosCatalogo,
        vendedores: vendedores.slice(0, 15),
        campos_disponibles: {
          vendidos_exactos: pubs.some((p) => p.vendidos.exacto),
          vendidos_por_rango: pubs.some((p) => !p.vendidos.exacto && p.vendidos.estimado != null),
          vendidos_ausentes: pubs.every((p) => p.vendidos.estimado == null),
          reputacion_de_terceros: conMedalla.length > 0,
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
  // TENDENCIAS — lo más buscado (la demanda)
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
        mas_crecen: lista.slice(0, 10),
        mas_deseadas: lista.slice(10, 30),
        mas_populares: lista.slice(30, 50),
      });
    } catch (err) {
      res.status(500).json({
        error: 'No se pudieron leer las tendencias.',
        status: err.response?.status || null,
        detalle: err.response?.data || err.message,
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

      const r = await axios.get(`${API}/highlights/${SITIO}/category/${cat}`, { ...auth, timeout: 20000 });
      const contenido = r.data?.content || [];

      const ids = contenido.filter((c) => c.type === 'ITEM').map((c) => c.id);
      const detalles = {};
      for (let i = 0; i < ids.length; i += 20) {
        try {
          const d = await axios.get(`${API}/items`, { ...auth, params: { ids: ids.slice(i, i + 20).join(',') } });
          d.data.forEach((x) => { if (x.code === 200 && x.body) detalles[x.body.id] = x.body; });
        } catch (e) { /* seguimos con lo que haya */ }
      }
      // Los puestos de tipo PRODUCT son fichas de catálogo: traemos su ganador.
      const productos = contenido.filter((c) => c.type === 'PRODUCT').map((c) => c.id);
      const fichas = {};
      await enTandas(productos, 3, async (pid) => {
        try {
          const rp = await axios.get(`${API}/products/${pid}`, { ...auth, timeout: 15000 });
          fichas[pid] = rp.data;
        } catch (e) { /* seguimos */ }
      });

      res.json({
        categoria: cat,
        generado_en: new Date().toISOString(),
        ranking: contenido.map((c) => {
          const b = detalles[c.id];
          const f = fichas[c.id];
          const w = f?.buy_box_winner;
          return {
            posicion: c.position,
            tipo: c.type,
            id: c.id,
            titulo: b?.title || f?.name || null,
            precio: b?.price ?? w?.price ?? null,
            vendedor_id: b?.seller_id ?? w?.seller_id ?? null,
            vendidos: parseCantidad(b?.sold_quantity ?? w?.sold_quantity).estimado,
            full: (b?.shipping?.logistic_type || w?.shipping?.logistic_type) === 'fulfillment',
            catalogo: c.type === 'PRODUCT' || Boolean(b?.catalog_listing),
            permalink: b?.permalink || f?.permalink || null,
          };
        }),
      });
    } catch (err) {
      res.status(500).json({
        error: 'No se pudieron leer los más vendidos.',
        status: err.response?.status || null,
        detalle: err.response?.data || err.message,
        ayuda: 'Probá con una categoría más específica (hoja). Ej: MLA1072 en vez de MLA1071.',
      });
    }
  });

  // =========================================================================
  // HISTORIAL
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
          fecha: f.fecha, fuente: f.fuente, universo: f.universo,
          precio_mediana: f.precio_mediana, vendedores_distintos: f.vendedores_distintos,
          en_full_pct: f.en_full_pct, publicaciones_guardadas: (f.items || []).length,
        })),
      });
    } catch (err) {
      res.status(500).json({ error: 'No se pudo leer el historial.', detalle: err.message });
    }
  });

  return router;
};
