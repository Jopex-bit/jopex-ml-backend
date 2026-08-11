require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const store = require('./storage');

const app = express();
app.use(cors()); // El panel JOPEX puede correr como archivo local (file://) — CORS abierto es necesario acá.
app.use(express.json());

const ML_API = 'https://api.mercadolibre.com';
const ML_AUTH = 'https://auth.mercadolibre.com.ar'; // .com.ar para Argentina — revisar si cambia de país

// ---------- Token en memoria (se carga del store durable al arrancar) ----------
// Mantenemos una copia en memoria para que leerTokens() siga siendo síncrono
// (lo usan las rutas y la raíz). guardarTokens() actualiza la copia Y persiste.
let tokensCache = null;
function leerTokens() {
  return tokensCache;
}
async function guardarTokens(data) {
  tokensCache = data;
  await store.save(data);
}

// ---------- Seguridad: API key para las rutas de datos ----------
// Solo tu panel (que conoce PANEL_API_KEY) puede leer /api/*.
// Si PANEL_API_KEY no está configurada, NO bloquea (para no romper nada antes
// de que la definas). La key se manda en el header 'x-api-key' o como ?api_key=.
function requireApiKey(req, res, next) {
  const configurada = process.env.PANEL_API_KEY;
  if (!configurada) return next(); // sin configurar => modo abierto (compatibilidad)
  const provista = req.get('x-api-key') || req.query.api_key;
  if (provista !== configurada) {
    return res.status(401).json({ error: 'API key inválida o faltante.' });
  }
  next();
}

// ---------- Paso 1: arrancar el login ----------
// Abrí esta URL en el navegador (con tu APP_SECRET) para iniciar el permiso de ML.
// Ej: https://tu-app.onrender.com/auth/login?key=TU_APP_SECRET
app.get('/auth/login', (req, res) => {
  if (req.query.key !== process.env.APP_SECRET) {
    return res.status(403).send('No autorizado.');
  }
  const url = `${ML_AUTH}/authorization?response_type=code&client_id=${process.env.ML_CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.ML_REDIRECT_URI)}`;
  res.redirect(url);
});

// ---------- Paso 2: ML te devuelve acá con un "code" ----------
app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Falta el parámetro "code".');

  try {
    const resp = await axios.post(`${ML_API}/oauth/token`, null, {
      params: {
        grant_type: 'authorization_code',
        client_id: process.env.ML_CLIENT_ID,
        client_secret: process.env.ML_CLIENT_SECRET,
        code,
        redirect_uri: process.env.ML_REDIRECT_URI,
      },
      headers: { Accept: 'application/json' },
    });

    const { access_token, refresh_token, expires_in, user_id, scope } = resp.data;
    await guardarTokens({
      access_token,
      refresh_token,
      user_id,
      obtenido_en: Date.now(),
      expira_en_seg: expires_in,
      scope: scope || null,
    });

    // ML solo emite refresh_token si la app tiene el permiso "offline_access".
    // Sin él, la conexión se cae cuando vence el access token (~6 h) y hay que
    // volver a autorizar a mano. Avisamos en pantalla para no descubrirlo tarde.
    if (!refresh_token) {
      return res.send(
        'Conectado con Mercado Libre, PERO ATENCIÓN: ML no envió refresh token. ' +
          'Eso pasa cuando la aplicación no tiene habilitado el permiso "offline_access". ' +
          'La conexión va a durar unas 6 horas y después habrá que autorizar de nuevo. ' +
          'Para que sea permanente: habilitá offline_access en el DevCenter y volvé a entrar a /auth/login. ' +
          (scope ? 'Permisos recibidos: ' + scope : '')
      );
    }
    res.send('Conectado con Mercado Libre correctamente (con renovación automática). Ya podés cerrar esta pestaña.');
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).send('Error al conectar con ML. Revisá los logs del servidor.');
  }
});

// ---------- Renovación automática del token cuando está por vencer ----------
async function getAccessTokenValido() {
  const tokens = leerTokens();
  if (!tokens) throw new Error('Todavía no iniciaste sesión con ML (visitá /auth/login primero).');

  const vencidoEn = tokens.obtenido_en + tokens.expira_en_seg * 1000;
  const faltaMenosDe5Min = vencidoEn - Date.now() < 5 * 60 * 1000;

  if (!faltaMenosDe5Min) return tokens.access_token;

  if (!tokens.refresh_token) {
    throw new Error(
      'El token de Mercado Libre venció y no hay refresh token para renovarlo. ' +
        'Esto pasa cuando la aplicación no tiene el permiso "offline_access". ' +
        'Solución: habilitá offline_access en el DevCenter de ML y volvé a entrar a /auth/login?key=TU_APP_SECRET'
    );
  }

  const resp = await axios.post(`${ML_API}/oauth/token`, null, {
    params: {
      grant_type: 'refresh_token',
      client_id: process.env.ML_CLIENT_ID,
      client_secret: process.env.ML_CLIENT_SECRET,
      refresh_token: tokens.refresh_token,
    },
  });

  // ML rota el refresh_token en cada renovación: guardamos SIEMPRE el nuevo.
  const nuevos = {
    access_token: resp.data.access_token,
    refresh_token: resp.data.refresh_token || tokens.refresh_token,
    user_id: tokens.user_id,
    obtenido_en: Date.now(),
    expira_en_seg: resp.data.expires_in,
    scope: resp.data.scope || tokens.scope || null,
  };
  await guardarTokens(nuevos);
  return nuevos.access_token;
}

app.locals.getAccessTokenValido = getAccessTokenValido;
app.locals.ML_API = ML_API;
app.locals.leerTokens = leerTokens;

// ---------- Rutas de datos (protegidas con API key) ----------
app.use('/api/orders', requireApiKey, require('./routes/orders')(app));
app.use('/api/items', requireApiKey, require('./routes/items')(app));
app.use('/api/ads', requireApiKey, require('./routes/ads')(app));
app.use('/api/competencia', requireApiKey, require('./routes/competencia')(app));
app.use('/api/diagnostico', requireApiKey, require('./routes/diagnostico')(app));

app.get('/', (req, res) => {
  const tokens = leerTokens();
  const vence = tokens ? tokens.obtenido_en + tokens.expira_en_seg * 1000 : null;
  res.json({
    status: 'ok',
    conectado_con_ml: !!tokens,
    user_id: tokens?.user_id || null,
    persistencia: store.usarUpstash ? 'upstash' : 'archivo-local',
    // Diagnóstico de la conexión
    renovacion_automatica: tokens ? Boolean(tokens.refresh_token) : false,
    token_vencido: vence ? Date.now() > vence : null,
    vence_en_minutos: vence ? Math.round((vence - Date.now()) / 60000) : null,
    permisos: tokens?.scope || null,
  });
});

// ---------- Arranque: primero cargamos el token del store, después escuchamos ----------
const PORT = process.env.PORT || 3000;
store
  .read()
  .then((t) => {
    tokensCache = t;
  })
  .catch((e) => {
    console.error('No se pudo cargar el token del store al arrancar:', e.message);
  })
  .finally(() => {
    app.listen(PORT, () =>
      console.log(
        `Servidor JOPEX-ML corriendo en el puerto ${PORT} — persistencia: ${
          store.usarUpstash ? 'Upstash Redis (durable)' : 'archivo local (efímero)'
        }`
      )
    );
  });
