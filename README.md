# JOPEX ↔ Mercado Libre — Backend

Servidor intermedio que guarda de forma segura el permiso de tu cuenta de Mercado Libre
y expone datos reales (ventas, stock, precios) en un formato simple, listo para que el
panel JOPEX los consuma.

## Aviso importante de Mercado Libre (vigente desde el 30/08/2026)

A partir de esa fecha, las aplicaciones deben estar separadas entre Mercado Libre y
Mercado Pago — una aplicación por unidad de negocio. Las apps que mezclen scopes de
las dos plataformas pierden el acceso a las APIs si no se corrigen antes.

Esta app está pensada para traer datos de **Mercado Libre únicamente** (pedidos,
publicaciones, stock, ads) — no toca pagos ni cobros, así que no debería necesitar
ningún scope de Mercado Pago. Aun así, verificalo vos mismo antes de dar por cerrado
el Paso 1:

1. Al crear la Aplicación en developers.mercadolibre.com.ar, no marques ningún permiso
   relacionado a "Pagos" / "Collector" / Mercado Pago — solo los de lectura de
   órdenes, items y publicidad.
2. Una vez creada, confirmá que quedó limpia haciendo:
   ```
   GET https://api.mercadolibre.com/applications/$APP_ID
   ```
   (con `$APP_ID` = tu Client ID). Revisá el campo de scopes en la respuesta: no debe
   aparecer ningún valor que empiece con `urn:mp:`.
3. Si aparece alguno, entrá al DevCenter de Mercado Pago (developers.mercadopago.com)
   y separá esa parte en una aplicación distinta — no la mezcles con esta.

## Qué NO hace este proyecto (todavía)

- No está conectado al panel JOPEX (JOPEX_Panel.html) — eso es un paso aparte, una vez
  que el backend esté funcionando y confirmes que trae datos reales.
- El endpoint de Ads es un esqueleto sin confirmar — la API de Publicidad de ML cambia
  seguido y puede necesitar una habilitación aparte de tu cuenta.

## Paso 1 — Conseguir credenciales de ML

Si todavía no lo hiciste: entrá a developers.mercadolibre.com.ar, creá una Aplicación,
y guardate el **Client ID** y el **Client Secret**.

## Paso 2 — Elegir un hosting

**Importante:** la Redirect URI que ya cargaste en la Aplicación de ML es
`https://jopex-ml-backend.onrender.com/auth/callback` — eso fija dos cosas:
tenés que usar **Render** como hosting (no Railway ni Fly.io, porque la URL que
generan es distinta), y el servicio tenés que nombrarlo exactamente
**`jopex-ml-backend`**, para que la URL que te asigne Render coincida letra por
letra con la que ya quedó cargada en ML. Si el nombre no está disponible o usás
otro hosting, vas a tener que volver a la Aplicación de ML y actualizar la
Redirect URI con la URL real que te toque.

Revisá vos mismo los planes/precios vigentes de Render al momento de desplegar,
porque cambian seguido y no tengo forma de confirmarte el estado actual desde acá.

Pasos generales:

1. Creá una cuenta en render.com.
2. Creá un "Web Service" nuevo, llamado exactamente `jopex-ml-backend`, apuntando a
   este código (podés subirlo a un repositorio de GitHub y conectarlo ahí, que es
   la forma más simple que ofrece Render).
3. En la sección de "Environment Variables" (variables de entorno) del servicio,
   cargá las mismas claves que ves en `.env.example`, con tus valores reales:
   - `ML_CLIENT_ID`
   - `ML_CLIENT_SECRET`
   - `ML_REDIRECT_URI` = `https://jopex-ml-backend.onrender.com/auth/callback`
   - `APP_SECRET` (inventá una cadena larga y aleatoria)
4. Desplegá. Con el nombre correcto, Render te va a asignar exactamente
   `https://jopex-ml-backend.onrender.com` — y ya no hace falta tocar nada en ML.

## Paso 3 — Ajustar la Redirect URI

Con la URL real del paso anterior:

1. Volvé a developers.mercadolibre.com.ar, a tu Aplicación.
2. Cambiá la Redirect URI provisoria por: `https://TU-URL-REAL/auth/callback`
3. Actualizá también la variable `ML_REDIRECT_URI` en el hosting con esa misma URL,
   y volvé a desplegar si hace falta.

## Paso 4 — Autorizar tu cuenta

Abrí en el navegador:

```
https://TU-URL-REAL/auth/login?key=TU_APP_SECRET
```

Te va a llevar a la pantalla de login de Mercado Libre. Iniciá sesión con tu cuenta
vendedora y aceptá los permisos. Si todo salió bien, vas a ver el mensaje
"Conectado con Mercado Libre correctamente."

## Paso 5 — Probar que trae datos reales

Con el navegador o Postman, probá:

- `https://TU-URL-REAL/api/orders` → tus últimos pedidos
- `https://TU-URL-REAL/api/items` → tus publicaciones activas con stock y precio

Si ves datos reales de tu cuenta, el backend está funcionando. Recién ahí tiene sentido
que volvamos a JOPEX_Panel.html para que lo consuma desde ahí.

## Instalación local (para probar antes de desplegar)

```bash
npm install
cp .env.example .env
# completá .env con tus datos reales
npm start
```
