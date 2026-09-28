/**
 * Complejos que tienen varias torres en la misma direccion.
 *
 * El caso: Luxia Gallery House son dos edificios con direcciones distintas.
 * El agente no manda el nombre de la torre; lo manda pegado a la unidad:
 *
 *     1344-N  ->  North Tower, 14175 Dallas Pkwy
 *     3456-S  ->  South Tower, 14155 Dallas Pkwy
 *
 * Esto es una TABLA DE DATOS, no logica. Si manana otro complejo hace lo
 * mismo (East/West, Torre 1/2), se agrega una entrada aqui y no se toca
 * ninguna otra linea de codigo.
 *
 * `property` tiene que coincidir con el nombre tal cual esta en la pestana
 * Catalogo de la hoja de Properties.
 */
export const COMPLEJOS_CON_TORRE = [
    {
        base: "Luxia Gallery House",
        porDefecto: "N",
        torres: {
            N: { etiqueta: "North Tower", property: "Luxia Gallery House North Tower" },
            S: { etiqueta: "South Tower", property: "Luxia Gallery House South Tower" }
        }
    }
];

/** Copia local para no crear una dependencia circular con properties.js */
function norm(t) {
    return String(t || "").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * "3456-S" -> { numero: "3456", sufijo: "S" }
 * "4308"   -> { numero: "4308", sufijo: "" }
 */
export function partirUnidad(unidad) {
    const t = String(unidad || "").trim().replace(/^#/, "");
    const m = t.match(/^(\d{1,6})\s*-\s*([A-Za-z])$/);
    if (!m) return { numero: t, sufijo: "" };
    return { numero: m[1], sufijo: m[2].toUpperCase() };
}

/**
 * Decide que torre corresponde. Prioridad:
 *   1. El sufijo de la unidad ("3456-S" manda sobre todo lo demas)
 *   2. La torre que el usuario ya eligio en el selector de propiedad
 *   3. La torre por defecto del complejo (North, para Luxia)
 *
 * @returns {Object} { nombreProperty, unidad, torre, aviso }
 *   unidad sale SIN el sufijo: ya cumplio su funcion de elegir la torre y
 *   el numero de la calle es el que distingue el edificio en la direccion.
 */
export function resolverTorre(nombreProperty, unidad) {
    const original = String(unidad || "").trim();
    const { numero, sufijo } = partirUnidad(original);
    const nombre = norm(nombreProperty);

    const cfg = COMPLEJOS_CON_TORRE.find(c => nombre.startsWith(norm(c.base)));
    if (!cfg) {
        // Propiedad normal: no se toca nada, ni siquiera si trae sufijo.
        return { nombreProperty: String(nombreProperty || ""), unidad: original, torre: "", aviso: "" };
    }

    let letra = "";
    let aviso = "";

    // 2. torre ya explicita en el nombre elegido
    for (const [k, v] of Object.entries(cfg.torres)) {
        if (norm(v.property) === nombre) letra = k;
    }

    // 1. el sufijo manda
    if (sufijo) {
        if (cfg.torres[sufijo]) {
            letra = sufijo;
        } else {
            aviso = `La unidad "${original}" termina en "-${sufijo}", que no es una torre de ${cfg.base}.`;
        }
    }

    // 3. por defecto
    if (!letra) {
        letra = cfg.porDefecto;
        if (!aviso) {
            aviso = `Unidad sin torre: se usó ${cfg.torres[letra].etiqueta} por defecto.`;
        }
    }

    return {
        nombreProperty: cfg.torres[letra].property,
        unidad: numero,
        torre: cfg.torres[letra].etiqueta,
        aviso
    };
}
