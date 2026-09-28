/**
 * Arma el link wa.me que se guarda en el campo `website` del contacto de GHL.
 *
 * Que es esto realmente: NO es un mensaje para el cliente. Es la FICHA del
 * cliente para el jefe, que es quien procesa el pedido. Un tap en el campo
 * Website abre el chat de WhatsApp del jefe con los datos ya escritos, tal
 * cual como Esteban los escribia a mano:
 *
 *     Cecilia Mack
 *     ccmack@aol.com
 *     +12146845278
 *     D'Andrea@Waterview Crossing
 *     1220 S Powell Pkwy, Anna, TX 75409
 *     5309
 *     8/22/2026
 *
 * Reglas:
 *   · Las lineas que no tengan dato se omiten enteras, sin marcador. Para la
 *     API solo hacen falta nombre, telefono y fecha de mudanza; el correo y
 *     la unidad suelen llegar despues, cuando el cliente contesta.
 *   · El telefono y el source van TAL CUAL vienen de GHL, sin reformatear.
 *   · La direccion va sin la unidad: la unidad tiene su propia linea.
 *
 * A donde apunta el link:
 *   A WHATSAPP_DESTINO (el numero del jefe). Si algun dia se deja vacio en
 *   el entorno, el link abre el chat con el telefono del propio lead.
 */

const WHATSAPP_DESTINO = process.env.WHATSAPP_DESTINO ?? "+1 (214) 916-1001";

/** Deja el teléfono como lo quiere wa.me: solo dígitos con código de país. */
export function telefonoParaWa(phone) {
    const d = String(phone || "").replace(/\D/g, "");
    if (!d) return "";
    if (d.length === 10) return `1${d}`;          // US sin código
    return d;                                      // ya trae código de país
}

/**
 * La fecha llega en formatos distintos segun de donde salga: "08-22-2026" del
 * parser, o un ISO del custom field de GHL. Se muestra siempre igual.
 */
export function fechaLegible(moveIn) {
    const t = String(moveIn || "").trim();
    if (!t) return "";

    const mdy = t.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
    if (mdy) return `${Number(mdy[1])}/${Number(mdy[2])}/${mdy[3]}`;

    const iso = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (iso) return `${Number(iso[2])}/${Number(iso[3])}/${iso[1]}`;

    return t;   // formato desconocido: se manda tal cual, sin inventar
}

/**
 * Arma el texto de la ficha. Una linea por dato, en el orden en que el jefe
 * los espera. Lo que falte, no ocupa linea.
 *
 * @param {Object} datos - { nombre, email, phone, source, direccion, unidad, moveIn }
 */
export function construirFicha(datos = {}) {
    return [
        datos.nombre,
        datos.email,
        datos.phone,
        datos.source,
        datos.direccion,
        datos.unidad,
        fechaLegible(datos.moveIn)
    ]
        .map(v => String(v || "").trim())
        .filter(Boolean)
        .join("\n");
}

/**
 * @param {Object} datos - lo mismo que construirFicha, mas `phone` que se usa
 *                         de respaldo como destino si no hay WHATSAPP_DESTINO
 * @returns {string} URL wa.me lista, o "" si no hay a quien escribirle
 */
export function construirWhatsAppLink(datos = {}) {
    const numero = telefonoParaWa(WHATSAPP_DESTINO || datos.phone);
    if (!numero) return "";

    const ficha = construirFicha(datos);
    if (!ficha) return "";

    return `https://wa.me/${numero}?text=${encodeURIComponent(ficha)}`;
}
