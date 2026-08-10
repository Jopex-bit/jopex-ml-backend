require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors()); // El panel JOPEX corre como archivo local (file://) — CORS abierto es necesario acá.
app.use(express.json());

const TOKENS_FILE = path.join(__dirname, 'tokens.json');
const ML_API = 'https://api.mercadolibre.com';
const ML_AUTH = 'https://auth.mercadolibre.com.ar'; // .com.ar para Argentina — revisar si cambia de país

// ---------- Guardado simple de tokens (un solo usuario: vos) ----------
function leerTokens() {
  try {
    return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
  } catch (e) {
    return null;
  }
}
function guardarTokens(data) {
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(data, null, 2));
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
      headers: { 'Accept': 'application/json' },
    });

    const { access_token, refresh_token, expires_in, user_id } = resp.data;
    guardarTokens({
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

  const nuevos = {
    access_token: resp.data.access_token,
    refresh_token: resp.data.refresh_token || tokens.refresh_token,
    user_id: tokens.user_id,
    obtenido_en: Date.now(),
    expira_en_seg: resp.data.expires_in,
  };
  guardarTokens(nuevos);
  return nuevos.access_token;
}

app.locals.getAccessTokenValido = getAccessTokenValido;
app.locals.ML_API = ML_API;
app.locals.leerTokens = leerTokens;

// ---------- Rutas de datos (una por tipo de información) ----------
app.use('/api/orders', require('./routes/orders')(app));
app.use('/api/items', require('./routes/items')(app));
app.use('/api/ads', require('./routes/ads')(app));

app.get('/', (req, res) => {
  const tokens = leerTokens();
  res.json({
    status: 'ok',
    conectado_con_ml: !!tokens,
    user_id: tokens?.user_id || null,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor JOPEX-ML corriendo en el puerto ${PORT}`));
