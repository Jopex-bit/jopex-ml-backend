// ---------- Almacenamiento del token ----------
// Guarda/lee el token de Mercado Libre en un lugar DURABLE.
//
// - Si están configuradas las variables UPSTASH_REDIS_REST_URL y
//   UPSTASH_REDIS_REST_TOKEN, usa Upstash Redis (gratis, sobrevive reinicios
//   y "dormidas" del plan Free de Render). Se accede por HTTP con axios,
//   sin librerías extra.
// - Si NO están configuradas, cae automáticamente al archivo local tokens.json
//   (igual que antes). Es EFÍMERO: en Render Free se pierde al reiniciar,
//   pero sirve para probar y no rompe el arranque.
//
// De esta forma podés desplegar este código sin tocar nada y, cuando quieras
// que la conexión sea permanente, solo agregás las 2 variables de Upstash.

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const TOKENS_FILE = path.join(__dirname, 'tokens.json');
const KEY = 'jopex_ml_tokens';

const URL = process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const usarUpstash = Boolean(URL && TOKEN);

// Ejecuta un comando de Redis contra la REST API de Upstash.
// El comando se manda como un array JSON en el cuerpo, ej: ['SET', 'clave', 'valor'].
async function redisCmd(comando) {
  const resp = await axios.post(URL, comando, {
    headers: { Authorization: `Bearer ${TOKEN}` },
    timeout: 10000,
  });
  return resp.data.result;
}

async function read() {
  if (usarUpstash) {
    const crudo = await redisCmd(['GET', KEY]);
    return crudo ? JSON.parse(crudo) : null;
  }
  try {
    return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
  } catch (e) {
    return null;
  }
}

async function save(data) {
  if (usarUpstash) {
    await redisCmd(['SET', KEY, JSON.stringify(data)]);
    return;
  }
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(data, null, 2));
}

// ---------- Almacén genérico (para el estado del panel) ----------
// Mismo mecanismo, pero con clave libre: permite guardar el contenido completo
// del panel (costos, cotizaciones, stock, etc.) además del token de ML.
async function readKey(clave) {
  if (usarUpstash) {
    const crudo = await redisCmd(['GET', clave]);
    return crudo ? JSON.parse(crudo) : null;
  }
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, clave + '.json'), 'utf8'));
  } catch (e) {
    return null;
  }
}

async function saveKey(clave, data) {
  if (usarUpstash) {
    await redisCmd(['SET', clave, JSON.stringify(data)]);
    return;
  }
  fs.writeFileSync(path.join(__dirname, clave + '.json'), JSON.stringify(data, null, 2));
}

module.exports = { read, save, usarUpstash, readKey, saveKey };
