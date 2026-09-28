/**
 * Logica pura del webhook /webhook/marcar-pago.
 *
 * Aqui NO hay llamadas a Google ni a GHL a proposito: todo lo que decide en
 * que fila escribir vive en funciones que reciben datos y devuelven datos.
 * Asi la parte peligrosa —elegir la fila— se puede probar con los datos
 * reales de la hoja sin riesgo de escribir en ella.
 *
 * El riesgo de este webhook no es escribir. Es escribir en la fila
 * equivocada: no falla, no avisa, y aparece meses despues descuadrado.
 */

// ------------------------------------------------------------------
// Telefono
// ------------------------------------------------------------------

/**
 * Los ultimos 10 digitos, o null.
 *
 * Una sola funcion para el telefono que viene de GHL y para cada celda de la
 * hoja. Si el criterio cambia, cambia en un solo lugar.
 *
 * Formatos reales que tiene que aguantar:
 *   "+19034019737" -> "9034019737"   (E.164, lo que manda GHL)
 *   "(903) 401-9737" -> "9034019737"
 *   "12146426154"  -> "2146426154"   (11 con el 1 de pais)
 *   "212146845278" -> "2146845278"   (12 digitos, quedaron mal en la hoja)
 *   "639864103"    -> null           (9 digitos: no alcanza)
 *   "jenni699@gmail.com" -> null     (los digitos sueltos no son un telefono)
 *
 * Menos de 10 digitos devuelve null y esa fila se descarta. Un match parcial
 * es peor que no encontrar nada.
 */
export function normalizarTelefono(valor) {
    if (valor === null || valor === undefined) return null;
    const digitos = String(valor).replace(/\D/g, "");
    if (digitos.length < 10) return null;
    return digitos.slice(-10);
}

// ------------------------------------------------------------------
// Encabezados
// ------------------------------------------------------------------

/** "Agent Paid?" -> "agentpaid". Tolera espacios, signos y emojis. */
export function normalizarEncabezado(texto) {
    return String(texto || "")
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "");
}

/** Reconoce un YES en cualquiera de las formas que aparecen en la hoja. */
export function esSi(valor) {
    return /^(y|yes|si|sí|true|1|x)$/i.test(String(valor ?? "").trim());
}

/** Las ocho columnas sin las cuales no se puede decidir ni escribir. */
const OBLIGATORIAS = [
    "customer", "phone", "propertytype",
    "internetsold", "electricitysold",
    "installed", "paidme", "agentpaid"
];

/**
 * Ubica la fila de encabezados y mapea las columnas POR NOMBRE.
 *
 * Dos trampas que esto resuelve:
 *
 *  1. Los encabezados no estan en la fila 1. Arriba hay una fila vacia y una
 *     de totales. Por eso se escanean las primeras filas hasta encontrar la
 *     que tenga "customer" y "agentpaid".
 *
 *  2. A la derecha de algunas pestañas hay un bloque de metricas que repite
 *     el texto "Leasing Agent" en la MISMA fila de encabezados. Si un nombre
 *     aparece dos veces se usa el indice mas bajo, porque la tabla de verdad
 *     esta a la izquierda.
 *
 * Match exacto, nunca "contiene": "paid period" contiene "paid", y "agent
 * paid" y "paid me" contienen los dos "paid". Buscar por substring escribiria
 * YES en la columna equivocada.
 *
 * @returns {Object|null} { filaHeader, cols } o null si la pestaña no sirve
 */
export function ubicarEncabezadosPago(filas, maxFilas = 5) {
    for (let i = 0; i < Math.min(filas.length, maxFilas); i++) {
        const limpias = (filas[i] || []).map(normalizarEncabezado);
        if (!limpias.includes("customer") || !limpias.includes("agentpaid")) continue;

        // indexOf ya devuelve la primera aparicion: el indice mas bajo.
        const cols = {
            customer: limpias.indexOf("customer"),
            agent: limpias.indexOf("leasingagent"),
            phone: limpias.indexOf("phone"),
            moveIn: limpias.indexOf("moveindate"),
            propertytype: limpias.indexOf("propertytype"),
            installDate: limpias.indexOf("installdate"),
            internetsold: limpias.indexOf("internetsold"),
            electricitysold: limpias.indexOf("electricitysold"),
            notes: limpias.indexOf("notes"),
            provider: limpias.indexOf("provider"),
            speed: limpias.indexOf("speed"),
            installed: limpias.indexOf("installed"),
            paidme: limpias.indexOf("paidme"),
            agentpaid: limpias.indexOf("agentpaid")
        };

        if (OBLIGATORIAS.some(k => cols[k] === -1)) continue;
        return { filaHeader: i, cols };
    }
    return null;
}

/** "August2026", "August/2026". BASE y las pestañas de datos no pasan. */
export function esPestanaDeMes(titulo) {
    return /^[A-Za-z]+\s*\/?\s*20\d{2}$/.test(String(titulo || "").trim());
}

// ------------------------------------------------------------------
// Seleccion de la fila
// ------------------------------------------------------------------

export const celda = (fila, idx) =>
    idx > -1 && fila ? String(fila[idx] ?? "").trim() : "";

/**
 * Una venta de verdad: tiene tipo de propiedad Y vendio algo.
 *
 * Este filtro hace casi todo el trabajo de desambiguar. Un mismo cliente
 * aparece varias veces —una fila de cuando llego el lead, otra de cuando
 * compro— y solo la segunda tiene tipo y venta.
 *
 * Ojo con electricidad: la mitad de los pendientes son de solo electricidad.
 * Exigir internet sold = YES los perderia a todos.
 */
export function esVentaReal(fila, cols) {
    if (!celda(fila, cols.propertytype)) return false;
    return esSi(celda(fila, cols.internetsold)) || esSi(celda(fila, cols.electricitysold));
}

/**
 * Busca en TODAS las pestañas de mes, sin parar en la primera coincidencia:
 * un cliente puede tener filas en dos meses y hay que verlas todas para
 * decidir bien.
 *
 * @param {Array} pestanas - [{ titulo, filas }]
 * @param {string} telefono - ya normalizado a 10 digitos
 * @returns {Object} { candidatos, saltadas }
 */
export function buscarCandidatos(pestanas, telefono) {
    const candidatos = [];
    const saltadas = [];

    for (const { titulo, filas } of pestanas) {
        const ubic = ubicarEncabezadosPago(filas || []);
        if (!ubic) { saltadas.push(titulo); continue; }

        const { filaHeader, cols } = ubic;
        for (let i = filaHeader + 1; i < filas.length; i++) {
            const fila = filas[i];
            if (!celda(fila, cols.customer)) continue;
            if (normalizarTelefono(celda(fila, cols.phone)) !== telefono) continue;

            candidatos.push({
                pestana: titulo,
                fila: i + 1,          // 1-based, como lo ve Sheets
                indice: i,
                cols,
                datos: fila,
                cliente: celda(fila, cols.customer),
                agente: celda(fila, cols.agent),
                installDate: celda(fila, cols.installDate),
                ventaReal: esVentaReal(fila, cols)
            });
        }
    }

    return { candidatos, saltadas };
}

/**
 * @returns {Object} { estado: "ok"|"ambiguo"|"no_encontrado", elegido, candidatos }
 *
 * Con dos candidatos NO se elige. Existen dos filas distintas con el mismo
 * telefono, el mismo tipo y la misma venta —hermanos en el mismo apartamento,
 * por ejemplo—. Ninguna regla puede decidir cual pagar sin inventarse la
 * respuesta, y escribir en la equivocada es un error que nadie va a ver.
 */
export function decidir(candidatos) {
    const reales = candidatos.filter(c => c.ventaReal);
    if (reales.length === 1) return { estado: "ok", elegido: reales[0], candidatos: reales };
    if (reales.length === 0) return { estado: "no_encontrado", elegido: null, candidatos: [] };
    return { estado: "ambiguo", elegido: null, candidatos: reales };
}

// ------------------------------------------------------------------
// Escritura
// ------------------------------------------------------------------

const A_MARCAR = [
    { clave: "installed", etiqueta: "installed" },
    { clave: "paidme", etiqueta: "paid me" },
    { clave: "agentpaid", etiqueta: "agent paid" }
];

/**
 * Decide celda por celda, no las tres en bloque.
 *
 * Vacia -> YES. Con cualquier valor -> no se toca.
 *
 * No es solo evitar YES sobre YES: si una celda dice NO o "On Hold", ese
 * valor es la decision de alguien y el webhook no la pisa.
 */
export function planEscritura(candidato) {
    const { datos, cols } = candidato;
    const escritas = [];
    const respetadas = [];

    for (const { clave, etiqueta } of A_MARCAR) {
        const actual = celda(datos, cols[clave]);
        if (actual) {
            respetadas.push({ campo: etiqueta, valor: actual });
        } else {
            escritas.push({ campo: etiqueta, columna: cols[clave] });
        }
    }

    return { escritas, respetadas };
}

/** 0 -> "A", 25 -> "Z", 26 -> "AA". El bloque lateral llega hasta AI. */
export function letraColumna(indice) {
    let n = indice + 1;
    let letra = "";
    while (n > 0) {
        const resto = (n - 1) % 26;
        letra = String.fromCharCode(65 + resto) + letra;
        n = Math.floor((n - 1) / 26);
    }
    return letra;
}
