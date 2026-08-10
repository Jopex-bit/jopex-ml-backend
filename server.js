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

    const { access_token, refresh_token, expires_in, user_id } = resp.data;
    await guardarTokens({
      access_token,
      refresh_token,
      user_id,
      obtenido_en: Date.now(),
      expira_en_seg: expires_in,
    });

    res.send('Conectado con Mercado Libre correctamente. Ya podés cerrar esta pestaña.');
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

app.get('/', (req, res) => {
  const tokens = leerTokens();
  res.json({
    status: 'ok',
    conectado_con_ml: !!tokens,
    user_id: tokens?.user_id || null,
    persistencia: store.usarUpstash ? 'upstash' : 'archivo-local',
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
