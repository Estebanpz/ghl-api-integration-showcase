/**
 * Indexa los custom fields de contacto de GHL por su NOMBRE.
 *
 * Antes esta funcion tenia una lista blanca de tres nombres —Property Name,
 * Unit Number y Move In Date— y descartaba todo lo demas. El sintoma: creas
 * un campo nuevo en GHL, lo llenas, y el webhook lo lee vacio sin dar ningun
 * error. Se ve como "no encontro al cliente" cuando en realidad el campo
 * nunca llego.
 *
 * Ahora se guardan TODOS. Un campo de mas no cuesta nada; uno de menos
 * rompe en silencio.
 */
export function verCustomFields(listCustomFields = []) {
    const porNombre = {};

    for (const cf of listCustomFields) {
        if (cf.model && cf.model !== "contact") continue;
        if (cf.name) porNombre[cf.name] = cf;
    }

    console.log(`✅ ${Object.keys(porNombre).length} custom fields de contacto indexados`);
    return porNombre;
}

/** Los nombres que el codigo espera encontrar, para avisar si falta alguno. */
export const CAMPOS_ESPERADOS = [
    "Property Name", "Unit Number", "Move In Date",
    "Property Type", "Installation Date", "Speed", "Sales"
];

/** @returns {string[]} los que no existen en GHL con ese nombre exacto */
export function camposFaltantes(cache, nombres = CAMPOS_ESPERADOS) {
    if (!cache) return [...nombres];
    return nombres.filter(n => !cache[n]);
}
