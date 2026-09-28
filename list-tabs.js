import "dotenv/config";
import { getSheetsClient } from "./services/properties.js";
import { ubicarEncabezados, letraColumna } from "./services/zionSheet.js";

/**
 * Lista las pestañas de un archivo de Sheets y, en las que parecen tracker,
 * muestra dónde están las columnas Customer / Leasing Agent / Phone / Move-in
 * y cuál sería la primera fila libre.
 *
 * Uso:  node list-tabs.js            (usa ZION_SHEET_ID)
 *       node list-tabs.js <sheetId>
 */

const sheetId = process.argv[2] || process.env.ZION_SHEET_ID;
if (!sheetId) {
    console.error("Falta el id. Pásalo como argumento o define ZION_SHEET_ID en .env");
    process.exit(1);
}

const sheets = getSheetsClient();
const meta = await sheets.spreadsheets.get({
    spreadsheetId: sheetId,
    fields: "properties.title,sheets.properties.title"
});

console.log(`\n📄 ${meta.data.properties.title}\n`);

for (const s of meta.data.sheets) {
    const tab = s.properties.title;
    let detalle = "";

    try {
        const r = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: `${tab}!A1:Z200`
        });
        const filas = r.data.values || [];
        const cols = ubicarEncabezados(filas);

        if (cols) {
            let libre = -1;
            for (let i = cols.filaHeader + 1; i < 200; i++) {
                if (!((filas[i] || [])[cols.customer] || "").trim()) { libre = i + 1; break; }
            }
            detalle =
                `  ← header en fila ${cols.filaHeader + 1} | ` +
                `Customer=${letraColumna(cols.customer)} ` +
                `Agent=${letraColumna(cols.agent)} ` +
                `Phone=${letraColumna(cols.phone)} ` +
                `MoveIn=${letraColumna(cols.moveIn)} | ` +
                `primera fila libre: ${libre > -1 ? libre : "ninguna"}`;
        }
    } catch { /* pestaña ilegible, la listamos igual */ }

    console.log(`  • ${tab}${detalle}`);
}

console.log(`\nPon la que uses en .env como  ZION_TAB=nombre exacto\n`);
