import "dotenv/config";
import { getSheetsClient, cargarProperties, normalizar } from "../services/properties.js";

/**
 * Fusiona "Properties" + "Sara+ properties" y escribe el resultado limpio y
 * ordenado alfabéticamente en una pestaña nueva llamada "Catalogo".
 *
 *     node scripts/fusionar-hoja.js
 *
 * Qué hace distinto a las pestañas actuales:
 *   · Una fila por propiedad, sin duplicados.
 *   · Dirección partida en columnas (ADDRESS / CITY / STATE / ZIP), en vez
 *     de mezclada dentro de una sola celda.
 *   · Encabezados de verdad, así ya no hay que adivinar columnas por posición.
 *
 * Seguridad:
 *   · NUNCA toca "Properties" ni "Sara+ properties". Solo escribe en "Catalogo".
 *   · Si "Catalogo" ya existe, borra su contenido y lo reescribe.
 *   · Si la lectura falla, no escribe nada.
 */

const SHEET_ID = process.env.PROPERTIES_SHEET_ID;
const DESTINO = process.env.CATALOGO_TAB || "Catalogo";

const ENCABEZADOS = [
    "COMPLEX", "ADDRESS", "CITY", "STATE", "ZIP",
    "AGENT", "ELECTRICITY", "FUENTE"
];

/** Coserv - https://... → "Coserv"  |  Compare Power - https://... → "ComparePower" */
function proveedor(texto) {
    const t = String(texto || "").trim();
    if (!t) return "";
    if (/compare\s*power/i.test(t)) return "ComparePower";
    if (/coserv/i.test(t)) return "Coserv";
    if (/spectrum/i.test(t)) return "Spectrum";
    if (/at\s*&?\s*t/i.test(t)) return "AT&T";
    return t.split(" - ")[0].trim();
}

/** Limpia el listado de agentes: quita notas entre paréntesis y roles. */
function limpiarAgentes(texto) {
    return String(texto || "")
        .replace(/\([^)]*\)/g, "")
        .replace(/\b(manager|assistant|temp|Mg|AM)\b/gi, "")
        .split(/,| and | y /)
        .map(a => a.trim())
        .filter(Boolean)
        .filter(a => a !== "?" && a !== ".")
        .join(", ");
}

try {
    if (!SHEET_ID) throw new Error("Falta PROPERTIES_SHEET_ID en el entorno");

    console.log("📖 Leyendo y fusionando las pestañas...\n");
    const mapa = await cargarProperties();

    const propiedades = [...mapa.values()]
        .sort((a, b) => a.name.trim().localeCompare(b.name.trim(), "es"));

    // ── Avisos de calidad ─────────────────────────────────────────
    const sospechosas = propiedades.filter(p => !/^\s*\d/.test(p.address));
    const incompletas = propiedades.filter(p => !p.city || !p.zip);

    if (sospechosas.length) {
        console.warn(`⚠️ ${sospechosas.length} con dirección que no empieza con número (revisa esas filas en la hoja):`);
        sospechosas.forEach(p => console.warn(`   · ${p.name} → "${p.address}"`));
        console.warn("");
    }
    if (incompletas.length) {
        console.warn(`⚠️ ${incompletas.length} sin ciudad o sin zip:`);
        incompletas.forEach(p => console.warn(`   · ${p.name} → ${p.address} | ${p.city || "—"} | ${p.zip || "—"}`));
        console.warn("");
    }

    // ── Preparar la pestaña destino ───────────────────────────────
    const sheets = getSheetsClient();
    const meta = await sheets.spreadsheets.get({
        spreadsheetId: SHEET_ID,
        fields: "sheets.properties(title,sheetId)"
    });

    const existente = meta.data.sheets.find(
        s => normalizar(s.properties.title) === normalizar(DESTINO)
    );

    if (existente) {
        await sheets.spreadsheets.values.clear({
            spreadsheetId: SHEET_ID,
            range: `${existente.properties.title}!A:Z`
        });
        console.log(`🧹 Pestaña "${existente.properties.title}" limpiada`);
    } else {
        await sheets.spreadsheets.batchUpdate({
            spreadsheetId: SHEET_ID,
            requestBody: {
                requests: [{ addSheet: { properties: { title: DESTINO } } }]
            }
        });
        console.log(`🆕 Pestaña "${DESTINO}" creada`);
    }

    const tab = existente ? existente.properties.title : DESTINO;

    // ── Escribir ──────────────────────────────────────────────────
    const filas = [ENCABEZADOS];
    for (const p of propiedades) {
        filas.push([
            p.name.trim(),
            p.address,
            p.city,
            p.state || "TX",
            p.zip,
            limpiarAgentes(p.agent),
            proveedor(p.electricity),
            "Properties + Sara+ properties"
        ]);
    }

    await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${tab}!A1`,
        valueInputOption: "RAW",
        requestBody: { values: filas }
    });

    // Encabezado en negrita y congelado, para que se vea como tus otras hojas
    const hoja = (await sheets.spreadsheets.get({
        spreadsheetId: SHEET_ID,
        fields: "sheets.properties(title,sheetId)"
    })).data.sheets.find(s => s.properties.title === tab);

    await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: {
            requests: [
                {
                    repeatCell: {
                        range: { sheetId: hoja.properties.sheetId, startRowIndex: 0, endRowIndex: 1 },
                        cell: { userEnteredFormat: { textFormat: { bold: true } } },
                        fields: "userEnteredFormat.textFormat.bold"
                    }
                },
                {
                    updateSheetProperties: {
                        properties: {
                            sheetId: hoja.properties.sheetId,
                            gridProperties: { frozenRowCount: 1 }
                        },
                        fields: "gridProperties.frozenRowCount"
                    }
                },
                {
                    autoResizeDimensions: {
                        dimensions: {
                            sheetId: hoja.properties.sheetId,
                            dimension: "COLUMNS",
                            startIndex: 0,
                            endIndex: ENCABEZADOS.length
                        }
                    }
                }
            ]
        }
    });

    console.log(`\n✅ "${tab}": ${propiedades.length} propiedades, ordenadas alfabéticamente`);
    console.log(`\n   Revisa la pestaña y, si te convence, pon esto en .env y en Render:`);
    console.log(`       PROPERTIES_TABS=${tab}`);
    console.log(`   Así la app lee una sola pestaña limpia en vez de fusionar en cada arranque.`);

} catch (err) {
    console.error("\n❌ No se escribió nada:", err.message);
    process.exit(1);
}
