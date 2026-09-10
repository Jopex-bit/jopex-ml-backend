# 2. Checklist de configuración inicial — Tiendanube

Recorré esto en orden la primera vez que entrás al panel. Marcá cada ítem a
medida que lo completás vos (yo no tengo acceso al panel).

## 2.1 Datos del negocio

`Configuración → Datos de la tienda`

- [ ] Razón social / nombre de fantasía: **JOPEX**.
- [ ] CUIT y condición frente al IVA (dato fiscal — lo cargás vos).
- [ ] Email de contacto: usar uno de la marca, no personal (ej.
      `hola@jopexarg.com` una vez que el dominio esté activo; mientras tanto el
      que uses hoy).
- [ ] Teléfono / WhatsApp de atención (el mismo que va a figurar en el pie de la
      tienda, ver sección 4 del doc de branding — "cara visible").
- [ ] Dirección: Resistencia, Chaco (aunque no sea local a la calle, sirve para
      métodos de envío locales y para el bloque de "cara visible").
- [ ] Redes sociales (Instagram al menos, si existe cuenta de JOPEX).

## 2.2 Moneda y región

`Configuración → General`

- [ ] Moneda: **ARS ($)**.
- [ ] Formato de precio: `$ 1.234,56` (formato argentino, separador de miles con
      punto).
- [ ] Zona horaria: `America/Argentina/Buenos_Aires` (o la que use Chaco, mismo
      huso).
- [ ] Idioma de la tienda: Español (Argentina).

## 2.3 Categorías

Con un catálogo chico (<50 productos) conviene arrancar con pocas categorías,
pensadas para crecer a futuro (JOPEX es multirubro, no solo mascotas):

- [ ] **Mascotas** (categoría raíz de hoy)
  - [ ] Rastreo y seguridad → acá va el **collar GPS**
  - [ ] Paseo y entrenamiento (correas, arneses, etc. si aplica)
  - [ ] Comederos y accesorios
  - [ ] Higiene y cuidado
- [ ] Dejar la estructura de categorías **plana y genérica en el nivel raíz**
      (evitar que "Mascotas" quede hardcodeada como si fuera la única categoría
      posible de la tienda) para poder sumar otro rubro después sin reordenar
      todo.

No uses nombres de categoría con diminutivos ni tono infantil ("mascotitas",
"patitas") — mismo criterio del manual de voz.

## 2.4 Métodos de pago

`Configuración → Medios de pago`

- [ ] **Mercado Pago** — conectar la cuenta (login/token: lo hacés vos). Habilitar:
  - [ ] Tarjetas de crédito/débito
  - [ ] Dinero en cuenta de Mercado Pago
  - [ ] Pago en efectivo (Rapipago/Pago Fácil) si querés cubrir ese segmento
  - [ ] Cuotas sin interés si tu costo de producto las banca (revisar margen del
        collar GPS antes de activar cuotas largas)
- [ ] Definir si además vas a aceptar transferencia bancaria directa (útil para
      ventas locales en Resistencia sin comisión de MP).

## 2.5 Métodos de envío

`Configuración → Métodos de envío`

- [ ] **Correo Argentino** — activar integración estándar de Tiendanube.
- [ ] **Andreani u OCA** — activar el que tengas acuerdo o mejor cobertura en
      Chaco (podés activar los dos y comparar costos/tiempos reales las primeras
      semanas).
- [ ] **Envío en moto (local, Resistencia)** — Tiendanube no trae "moto" como
      integración nativa; se configura como **método de envío personalizado**
      (`Envío a domicilio` / `Retiro y entrega personalizada`):
  - [ ] Nombre visible: "Entrega en moto — Resistencia" (coherente con el
        vocabulario de marca: "entrego en mano").
  - [ ] Costo fijo o por zona (definir vos el monto).
  - [ ] Restringir por código postal / radio de cobertura de Resistencia, para
        que no se ofrezca a compradores de otras provincias.
  - [ ] Plazo estimado en texto llano (ej. "mismo día o 24hs hábiles"), sin letra
        chica — el manual pide aclarar esto explícitamente.
- [ ] **Retiro en punto físico**, si en algún momento tenés local o punto de
      entrega fijo (opcional, se puede sumar después).

## 2.6 Otros ajustes antes de publicar

- [ ] Política de cambios/devoluciones y garantía como página o bloque de texto
      (ver manual: 6 meses, Ley 24.240 art. 11 — texto sugerido en
      `03-fichas-producto.md`).
- [ ] Emails transaccionales (confirmación de compra, envío) con el tono de voz
      de marca, si Tiendanube permite editarlos (revisar en
      `Configuración → Notificaciones`).
- [ ] Favicon: **isotipo versión monocroma** (por el tamaño chico, <40px — ver
      `04-diseno-branding.md`).

## Lo que hacés vos

- Login, credenciales de Mercado Pago, credenciales de Andreani/OCA/Correo.
- Datos fiscales (CUIT, condición IVA).
- Confirmar montos de envío en moto y radio de cobertura real.
