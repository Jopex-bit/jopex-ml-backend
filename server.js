require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const store = require('./storage');

const app = express();
app.set('trust proxy', 1); // Render corre detrás de un proxy TLS
app.use(cors()); // El panel JOPEX puede correr como archivo local (file://) — CORS abierto es necesario acá.
// El estado del panel puede pesar bastante (cotizaciones, ventas, stock).
app.use(express.json({ limit: '8mb' }));
app.locals.store = store;

// ---------------------------------------------------------------------------
// Sesión del panel web
// ---------------------------------------------------------------------------
// El panel servido en /panel queda detrás de una contraseña. Se firma un token
// con HMAC y se guarda en una cookie httpOnly (no accesible por JavaScript).
const PANEL_PASSWORD = process.env.PANEL_PASSWORD || process.env.APP_SECRET || '';
const FIRMA = process.env.APP_SECRET || 'jopex';
const DIAS_SESION = 30;

function firmar(valor) {
  return crypto.createHmac('sha256', FIRMA).update(valor).digest('hex');
}
function crearToken() {
  const vence = Date.now() + DIAS_SESION * 24 * 3600 * 1000;
  return vence + '.' + firmar(String(vence));
}
function tokenValido(token) {
  if (!token || typeof token !== 'string') return false;
  const [vence, firma] = token.split('.');
  if (!vence || !firma) return false;
  if (Number(vence) < Date.now()) return false;
  const esperada = firmar(vence);
  // Comparación de tiempo constante para no filtrar información por timing.
  const a = Buffer.from(firma), b = Buffer.from(esperada);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function leerCookie(req, nombre) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const parte of raw.split(';')) {
    const [k, ...v] = parte.trim().split('=');
    if (k === nombre) return decodeURIComponent(v.join('='));
  }
  return null;
}
function haySesion(req) {
  return tokenValido(leerCookie(req, 'jopex_sesion'));
}

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
  // El panel web usa la cookie de sesión; el panel local usa la API key.
  if (haySesion(req)) return next();
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
app.use('/api/costos', requireApiKey, require('./routes/costos')(app));
app.use('/api/curva', requireApiKey, require('./routes/curva')(app));
app.use('/api/ventas', requireApiKey, require('./routes/ventas')(app));
app.use('/api/estado', requireApiKey, require('./routes/estado')(app));

// ---------------------------------------------------------------------------
// Panel web: login + servir el HTML
// ---------------------------------------------------------------------------
const PANEL_FILE = path.join(__dirname, 'panel.html');

function paginaLogin(error) {
  return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>JOPEX</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#070b14;
 font-family:system-ui,-apple-system,sans-serif;color:#eaf2ff}
form{background:#0e1930;border:1px solid rgba(140,163,196,.15);border-radius:14px;
 padding:28px;width:min(360px,90vw)}
h1{font-size:18px;margin:0 0 4px}p{font-size:13px;color:#8ca3c4;margin:0 0 18px}
input{width:100%;box-sizing:border-box;padding:11px 12px;border-radius:8px;
 border:1px solid rgba(140,163,196,.2);background:#0b1526;color:#eaf2ff;font-size:15px}
button{width:100%;margin-top:12px;padding:11px;border:none;border-radius:8px;
 background:linear-gradient(90deg,#3ddc3c,#22c55e);color:#04210a;font-weight:700;
 font-size:15px;cursor:pointer}
.err{color:#ff4d5e;font-size:13px;margin-top:10px}
</style></head><body><form method="POST" action="/panel/login">
<h1>JOPEX Panel</h1><p>Ingresá la contraseña para continuar.</p>
<input type="password" name="password" placeholder="Contraseña" autofocus autocomplete="current-password">
<button type="submit">Entrar</button>
${error ? '<div class="err">' + error + '</div>' : ''}
</form></body></html>`;
}

app.get('/panel/login', (req, res) => res.type('html').send(paginaLogin(null)));

app.post('/panel/login', express.urlencoded({ extended: false }), (req, res) => {
  if (!PANEL_PASSWORD) {
    return res.type('html').send(paginaLogin('No hay contraseña configurada en el servidor (PANEL_PASSWORD).'));
  }
  const pass = (req.body && req.body.password) || '';
  const a = Buffer.from(pass), b = Buffer.from(PANEL_PASSWORD);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) return res.status(401).type('html').send(paginaLogin('Contraseña incorrecta.'));
  // Secure solo cuando la conexión es https (Render lo es). En local sin TLS
  // la cookie se rechazaría y no se podría entrar.
  const esHttps = req.secure || req.get('x-forwarded-proto') === 'https';
  res.setHeader('Set-Cookie',
    'jopex_sesion=' + encodeURIComponent(crearToken()) +
    '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + (DIAS_SESION * 24 * 3600) +
    (esHttps ? '; Secure' : ''));
  res.redirect('/panel');
});

app.get('/panel/salir', (req, res) => {
  res.setHeader('Set-Cookie', 'jopex_sesion=; Path=/; HttpOnly; Max-Age=0');
  res.redirect('/panel/login');
});

app.get('/panel', (req, res) => {
  if (!haySesion(req)) return res.redirect('/panel/login');
  let html;
  try {
    html = fs.readFileSync(PANEL_FILE, 'utf8');
  } catch (e) {
    return res.status(404).type('html').send(
      '<p style="font-family:sans-serif;padding:24px">Falta el archivo <b>panel.html</b> en el repositorio. ' +
      'Subilo a la raíz con ese nombre exacto.</p>');
  }
  // Le avisamos al panel que corre en modo web: así guarda en el servidor
  // en lugar de quedarse solo en el navegador.
  html = html.replace('</head>',
    '<script>window.JOPEX_WEB=true;window.JOPEX_API="";</script></head>');
  res.type('html').send(html);
});

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
