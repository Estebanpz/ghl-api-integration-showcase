import "dotenv/config";
import { writeFileSync } from "fs";
import { cargarProperties, getPropertiesCache } from "../services/properties.js";

/**
 * Regenera services/propertiesFallback.js leyendo la hoja de Drive.
 *
 * Correlo cuando agregues o corrijas propiedades en la hoja, para que el
 * respaldo no envejezca:
 *
 *     node scripts/generar-fallback.js
 *
 * Ojo: si la hoja no se puede leer, NO escribe nada. Un respaldo viejo es
 * mejor que uno vacío.
 */

const DESTINO = new URL("../services/propertiesFallback.js", import.meta.url);

/** "Andrew, Phoenix and Bri (manager)" → ["Andrew","Phoenix","Bri"] */
function separarAgentes(texto) {
    return String(texto || "")
        .replace(/\([^)]*\)/g, "")
        .replace(/\b(manager|assistant|temp|Mg|AM)\b/gi, "")
        .split(/,| and | y /)
        .map(a => a.trim())
        .filter(a => a && a !== "?" && a !== ".");
}

const cita = (v) => JSON.stringify(v ?? "");

try {
    const mapa = await cargarProperties();
    const info = getPropertiesCache();

    const propiedades = [...mapa.values()].sort((a, b) => a.name.localeCompare(b.name));

    const bloques = [];
    for (const p of propiedades) {
        const agentes = separarAgentes(p.agent);
        for (const agente of (agentes.length ? agentes : [""])) {
            bloques.push([
                "    {",
                `        agent: ${cita(agente)},`,
                `        property: ${cita(p.name.trim())},`,
                "        address: {",
                `            street: ${cita(p.address)},`,
                `            city: ${cita(p.city)},`,
                `            state: ${cita(p.state || "TX")},`,
                `            zip: ${cita(p.zip)}`,
                "        }",
                "    }"
            ].join("\n"));
        }
    }

    const contenido = `/**
 * Catálogo de respaldo de propiedades. GENERADO AUTOMÁTICAMENTE — no lo
 * edites a mano, tus cambios se pierden en la próxima regeneración.
 *
 * Cuándo se usa: SOLO si la hoja de Google Drive no se pudo leer. La hoja
 * siempre manda; esto evita quedarte sin trabajar cuando Google falla.
 *
 * Origen: ${info.origen}
 * Regenerar:  node scripts/generar-fallback.js
 */
export const properties = [
${bloques.join(",\n")}
];

/**
 * Aplana el catálogo a una entrada por propiedad, en el mismo formato que
 * devuelve el lector de Google Sheets, para que ambas fuentes sean
 * intercambiables.
 */
export function propiedadesUnicas() {
    const mapa = new Map();

    for (const p of properties) {
        const clave = p.property.toLowerCase().replace(/\\s+/g, ' ').trim();
        const previo = mapa.get(clave);

        if (previo) {
            if (p.agent && !previo.agents.includes(p.agent)) previo.agents.push(p.agent);
            continue;
        }

        mapa.set(clave, {
            name: p.property,
            address: p.address.street,
            city: p.address.city,
            state: p.address.state,
            zip: p.address.zip,
            electricity: '',
            agent: '',
            agents: p.agent ? [p.agent] : []
        });
    }

    return [...mapa.values()].sort((a, b) => a.name.localeCompare(b.name));
}
`;

    writeFileSync(DESTINO, contenido);
    console.log(`\n✅ Respaldo regenerado: ${propiedades.length} propiedades, ${bloques.length} entradas`);
    console.log(`   Origen: ${info.origen}`);

    const incompletas = propiedades.filter(p => !p.city || !p.zip);
    if (incompletas.length) {
        console.warn(`\n⚠️ ${incompletas.length} sin ciudad o zip (revísalas en la hoja):`);
        incompletas.forEach(p => console.warn(`   · ${p.name} → ${p.address}`));
    }

} catch (err) {
    console.error("\n❌ No se regeneró nada:", err.message);
    console.error("   El respaldo anterior se conserva intacto.");
    process.exit(1);
}
