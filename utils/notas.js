/**
 * Logica pura de la columna "notes" del tracker.
 *
 * La celda mezcla tres cosas que no deben pisarse entre si:
 *
 *   - el marcador de seguimiento F1 / F2 / F3 (uno solo, el ultimo se
 *     reemplaza, no se acumula con F1+F2+F3 juntos)
 *   - la marca "pend call" (booleana: esta o no esta)
 *   - texto libre que Esteban escribe a mano (un nombre, "Need call", etc.)
 *
 * Sin llamadas de red, para poder probarlo con notas reales de la hoja sin
 * escribir nada.
 */

const RE_MARCADOR = /^F[123]$/i;
const RE_PENDCALL = /^pend call$/i;

function partes(texto) {
    return String(texto || "")
        .split(/[,;|]+/)
        .map(s => s.trim())
        .filter(Boolean);
}

function unir(lista) {
    return lista.filter(Boolean).join(", ");
}

/**
 * Separa una nota en sus piezas conocidas, dejando el resto como texto libre.
 * @returns {Object} { marcadorF: "F1"|"F2"|"F3"|null, pendCall: boolean, libres: string[] }
 */
export function analizarNotas(texto) {
    const trozos = partes(texto);
    let marcadorF = null;
    let pendCall = false;
    const libres = [];

    for (const trozo of trozos) {
        if (RE_MARCADOR.test(trozo)) { marcadorF = trozo.toUpperCase(); continue; }
        if (RE_PENDCALL.test(trozo)) { pendCall = true; continue; }
        libres.push(trozo);
    }

    return { marcadorF, pendCall, libres };
}

/** Reconstruye la nota: marcador, luego pend call, luego el texto libre tal cual. */
export function construirNotas({ marcadorF, pendCall, libres }) {
    return unir([marcadorF || "", pendCall ? "pend call" : "", ...(libres || [])]);
}

/**
 * Reemplaza el marcador de intento (no acumula F1+F2+F3). Si ya es el mismo
 * numero, devuelve la nota SIN TOCAR — evita una escritura y una reordenada
 * de texto libre por nada.
 */
export function conMarcadorIntento(notaActual, numero) {
    const nuevo = `F${numero}`;
    const n = analizarNotas(notaActual);
    if (n.marcadorF === nuevo) return notaActual;
    return construirNotas({ ...n, marcadorF: nuevo });
}

/**
 * Agrega "pend call" si no estaba. Idempotente: si ya estaba, devuelve la
 * nota sin tocar, para no reescribir ni reordenar el texto libre cada vez
 * que el tag se vuelve a disparar.
 */
export function conPendCall(notaActual) {
    const n = analizarNotas(notaActual);
    if (n.pendCall) return notaActual;
    return construirNotas({ ...n, pendCall: true });
}

/** Quita marcador F y "pend call", conservando solo el texto libre. Para la limpieza histórica. */
export function sinRuido(notaActual) {
    const n = analizarNotas(notaActual);
    return construirNotas({ marcadorF: null, pendCall: false, libres: n.libres });
}
