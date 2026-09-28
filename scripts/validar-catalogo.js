import "dotenv/config";
import { getSheetsClient } from "../services/properties.js";

/**
 * Revisa la pestaña Catalogo y reporta filas sospechosas.
 *
 *     node scripts/validar-catalogo.js
 *
 * Correlo SIEMPRE después de editar la hoja a mano, y antes de desplegar.
 * Solo LEE: nunca modifica nada.
 *
 * El error que más se cuela: usar "Datos → Dividir el texto en columnas"
 * en Sheets. Parte la celda por espacios y PISA la celda de al lado, así que
 * "7777 Adelaide St" + "Frisco" termina como "7777" + "Adelaide St", y la
 * ciudad se pierde sin dejar rastro.
 */

const SHEET_ID = process.env.PROPERTIES_SHEET_ID;
const TAB = process.env.PROPERTIES_TABS?.split(",")[0].trim() || "Catalogo";

// Palabras que delatan una calle. Se buscan en CUALQUIER posición: la ciudad
// "Stonebrook Pkwy Frisco" no termina en sufijo de calle, pero lo lleva en medio.
const PALABRA_CALLE = /\b(st|street|rd|road|dr|drive|ln|lane|ave|avenue|blvd|boulevard|pkwy|parkway|way|ct|court|trl|trail|cir|circle|hwy|highway|expy|pl|place|unit|apt|suite|ste)\b/i;

/** Una ciudad de verdad: 1 a 3 palabras, solo letras, sin sufijos de calle. */
function pareceCiudad(texto) {
    const t = String(texto || "").trim();
    if (!t) return false;
    if (/\d/.test(t)) return false;
    if (PALABRA_CALLE.test(t)) return false;
    const palabras = t.split(/\s+/);
    return palabras.length <= 3 && /^[A-Za-z][A-Za-z .'-]*$/.test(t);
}

const revisiones = [
    {
        id: "direccion-partida",
        gravedad: "grave",
        explica: "ADDRESS es solo un número — se usó 'Dividir texto en columnas' y la ciudad se perdió",
        falla: (f) => /^\d+$/.test(f.address)
    },
    {
        id: "sin-calle",
        gravedad: "grave",
        explica: "ADDRESS no empieza con número",
        falla: (f) => f.address && !/^\d/.test(f.address)
    },
    {
        id: "ciudad-invalida",
        gravedad: "grave",
        explica: "CITY no parece una ciudad (lleva números, un sufijo de calle, o más de 3 palabras)",
        falla: (f) => f.city && !pareceCiudad(f.city)
    },
    {
        id: "ciudad-dentro-de-address",
        gravedad: "aviso",
        explica: "La ciudad aparece repetida al final de ADDRESS",
        falla: (f) => f.city && new RegExp(`\\b${f.city.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\s*$`, "i").test(f.address)
    },
    {
        id: "zip-invalido",
        gravedad: "grave",
        explica: "ZIP no tiene exactamente 5 dígitos",
        falla: (f) => !/^\d{5}$/.test(f.zip)
    },
    {
        id: "sin-ciudad",
        gravedad: "grave",
        explica: "CITY vacío",
        falla: (f) => !f.city
    },
    {
        id: "agente-es-direccion",
        gravedad: "aviso",
        explica: "AGENT parece una dirección, no un nombre",
        falla: (f) => /^\d+\s+\S/.test(f.agent)
    },
    {
        id: "sin-agente",
        gravedad: "aviso",
        explica: "Sin agente asignado",
        falla: (f) => !f.agent
    }
];

try {
    if (!SHEET_ID) throw new Error("Falta PROPERTIES_SHEET_ID en el entorno");

    const sheets = getSheetsClient();
    const res = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: `${TAB}!A:H`
    });

    const filas = res.data.values || [];
    if (filas.length < 2) throw new Error(`La pestaña "${TAB}" está vacía`);

    const registros = filas.slice(1)
        .map((f, i) => ({
            fila: i + 2,                       // +2: fila 1 es encabezado, Sheets cuenta desde 1
            name: (f[0] || "").trim(),
            address: (f[1] || "").trim(),
            city: (f[2] || "").trim(),
            state: (f[3] || "").trim(),
            zip: (f[4] || "").trim(),
            agent: (f[5] || "").trim(),
            electricity: (f[6] || "").trim()
        }))
        .filter(r => r.name);

    console.log(`\n📋 "${TAB}": ${registros.length} propiedades\n`);

    const graves = [];
    const avisos = [];

    for (const r of registros) {
        for (const chk of revisiones) {
            if (chk.falla(r)) {
                const linea = `fila ${String(r.fila).padStart(3)} · ${r.name}\n` +
                              `            ${chk.explica}\n` +
                              `            ADDRESS="${r.address}" CITY="${r.city}" ZIP="${r.zip}"`;
                (chk.gravedad === "grave" ? graves : avisos).push(linea);
            }
        }
    }

    // Duplicados por dirección: dos propiedades en el mismo sitio suele ser
    // una repetida con otro nombre.
    const porDireccion = new Map();
    for (const r of registros) {
        const clave = `${r.address}|${r.zip}`.toLowerCase();
        porDireccion.set(clave, [...(porDireccion.get(clave) || []), r.name]);
    }
    const repetidas = [...porDireccion.values()].filter(v => v.length > 1);

    if (graves.length) {
        console.log(`❌ ${graves.length} problema(s) GRAVE(S) — arréglalos antes de desplegar:\n`);
        graves.forEach(l => console.log("   " + l + "\n"));
    }

    if (avisos.length) {
        console.log(`⚠️ ${avisos.length} aviso(s) — no bloquean, pero revísalos:\n`);
        avisos.forEach(l => console.log("   " + l + "\n"));
    }

    if (repetidas.length) {
        console.log(`ℹ️ Misma dirección en varias propiedades (puede ser correcto — torres del mismo complejo):\n`);
        repetidas.forEach(nombres => console.log(`   · ${nombres.join("  ↔  ")}`));
        console.log("");
    }

    if (!graves.length && !avisos.length) {
        console.log("✅ Sin problemas. Listo para desplegar.\n");
    } else if (!graves.length) {
        console.log("✅ Sin problemas graves. Se puede desplegar.\n");
    }

    process.exit(graves.length ? 1 : 0);

} catch (err) {
    console.error("\n❌ No se pudo validar:", err.message);
    process.exit(1);
}
