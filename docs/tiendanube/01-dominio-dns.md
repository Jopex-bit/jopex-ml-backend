# 1. Conectar jopexarg.com (GoDaddy) a Tiendanube

Objetivo: que `jopexarg.com` y `www.jopexarg.com` apunten a la tienda Tiendanube.
Hay dos formas — usá la primera si Tiendanube te la ofrece para tu plan, es más
simple y evita errores manuales de DNS.

## Opción A (recomendada): dejar que Tiendanube administre el DNS

1. En el panel de Tiendanube: **Mi Negocio → Configuración → Dominios**.
2. Elegí **"Conectar un dominio que ya tengo"** (o "Agregar dominio propio") e
   ingresá `jopexarg.com`.
3. Tiendanube te va a pedir cambiar los **nameservers (DNS)** del dominio en
   GoDaddy por los que te indique Tiendanube en ese momento (algo del estilo
   `ns1.tiendanube.com`, `ns2.tiendanube.com` — copiá los que te muestre la
   pantalla, no uses estos de memoria porque pueden variar).
4. En GoDaddy: **Mis productos → jopexarg.com → DNS → Nameservers → Cambiar →
   Personalizados**, y pegás ahí los que te dio Tiendanube.
5. Guardás. La propagación puede tardar de un par de horas hasta 24-48hs.

Con esta opción, Tiendanube maneja el resto de los registros (A, CNAME, MX si
tenés casillas de mail en GoDaddy — **atención**, ver nota abajo) automáticamente.

⚠️ **Si usás casillas de email `@jopexarg.com` en GoDaddy (Microsoft 365 /
Workspace)**, cambiar los nameservers puede romper el correo. Antes de moverlos:
- Anotá los registros **MX, SPF (TXT) y CNAME de autodiscover** actuales en
  GoDaddy (DNS → Registros).
- Elegí la Opción B (abajo) en vez de la A, para mantener el resto del DNS bajo tu
  control y sumar solo los registros que pide Tiendanube.

## Opción B: dejar el DNS en GoDaddy y solo agregar los registros de Tiendanube

1. En Tiendanube: **Configuración → Dominios → Conectar dominio propio** →
   ingresá `jopexarg.com` → elegí la opción de **"usar mi propio DNS"** (o
   "configuración manual"). Ahí te va a mostrar dos datos puntuales:
   - Una **IP** para el registro **A** del dominio raíz (`@`).
   - Un **destino** para el registro **CNAME** de `www` (normalmente algo tipo
     `ecommerce.tiendanube.com` o el subdominio de tu tienda,
     `tu-tienda.mitiendanube.com` — confirmalo en pantalla).
2. En GoDaddy: **Mis productos → jopexarg.com → DNS → Administrar zona DNS**.
3. Cargá/editá:

   | Tipo | Nombre | Valor | TTL |
   |---|---|---|---|
   | A | `@` | *(IP que te dio Tiendanube)* | 1 hora |
   | CNAME | `www` | *(destino que te dio Tiendanube)* | 1 hora |

   Si ya existe un registro A en `@` (suele venir uno por default de GoDaddy
   "parking"), **editalo** en vez de crear uno nuevo — no puede haber dos A en el
   mismo nombre.
4. Guardá los cambios en GoDaddy.
5. Volvé al panel de Tiendanube y confirmá la conexión del dominio (botón tipo
   "Verificar" / "Ya configuré el DNS"). Tiendanube valida la propagación —
   puede tardar minutos u horas.

## Después de conectar

- En Tiendanube, marcá `jopexarg.com` (sin `www`) como **dominio principal** para
  que las URLs canónicas y el SEO queden consistentes, y que `www.jopexarg.com`
  redirija a `jopexarg.com` (o al revés, pero elegí uno solo).
- Esperá a que Tiendanube emita el **certificado SSL** automático (candado
  https://) — suele tardar hasta 24hs después de que el DNS propaga. No lo fuerces
  ni lo publiques antes: si el candado no está, avisá y esperamos.
- Verificación de propagación desde tu lado (sin tocar nada): `dig jopexarg.com`
  o https://dnschecker.org — tiene que devolver la IP/CNAME de Tiendanube en la
  mayoría de las ubicaciones.

## Lo que hacés vos (no yo)

- Login en GoDaddy y Tiendanube.
- Cargar los registros DNS reales.
- Confirmar la conexión del dominio en Tiendanube.

Si me pasás una captura de lo que te muestra la pantalla de "conectar dominio" de
Tiendanube (los valores concretos de IP/CNAME/nameservers), te dejo armada la
tabla exacta lista para copiar en GoDaddy.
