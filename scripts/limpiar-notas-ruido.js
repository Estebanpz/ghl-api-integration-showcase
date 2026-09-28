/**
 * Limpieza única del ruido histórico en la columna "notes".
 *
 * Antes de que existiera el flujo automático, algunas filas quedaron con
 * F1/F2/F3 o "pend call" aunque el cliente YA está procesado (tiene property
 * type). Eso es ruido: el seguimiento terminó cuando se vendió. Este script
 * lo quita SIN tocar el texto libre (un nombre, "Need call", etc.).
 *
 * Por defecto es un dryRun: solo imprime qué cambiaría. Para escribir de
 * verdad:
 *
 *   node scripts/limpiar-notas-ruido.js --escribir
 */
import "dotenv/config";
import { getSheetsClient } from "../services/properties.js";
import { esPestanaDeMes, ubicarEncabezadosPago, celda, letraColumna } from "../utils/pago.js";
import { analizarNotas, construirNotas } from "../utils/notas.js";

const ZION_SHEET_ID = process.env.ZION_SHEET_ID;
const LIMITE_FILAS = 500;
const COLUMNA_FINAL = "AZ";
const ESCRIBIR = process.argv.includes("--escribir");

async function main() {
    if (!ZION_SHEET_ID) throw new Error("Falta ZION_SHEET_ID en el entorno");

    const sheets = getSheetsClient();

    const meta = await sheets.spreadsheets.get({
        spreadsheetId: ZION_SHEET_ID,
        fields: "sheets.properties(title)"
    });
    const titulos = meta.data.sheets.map(s => s.properties.title).filter(esPestanaDeMes);

    const res = await sheets.spreadsheets.values.batchGet({
        spreadsheetId: ZION_SHEET_ID,
        ranges: titulos.map(t => `'${t}'!A1:${COLUMNA_FINAL}${LIMITE_FILAS}`)
    });

    const cambios = [];

    (res.data.valueRanges || []).forEach((r, i) => {
        const titulo = titulos[i];
        const filas = r.values || [];
        const ubic = ubicarEncabezadosPago(filas);
        if (!ubic) { console.warn(`⚠️ "${titulo}" sin los encabezados esperados, se salta`); return; }

        const { filaHeader, cols } = ubic;
        if (cols.notes === -1) { console.warn(`⚠️ "${titulo}" no tiene columna "notes", se salta`); return; }

        for (let idx = filaHeader + 1; idx < filas.length; idx++) {
            const fila = filas[idx];
            const cliente = celda(fila, cols.customer);
            if (!cliente) continue;

            // Solo se limpia el ruido de filas YA procesadas: si todavía no
            // tiene property type, el F# o el "pend call" siguen siendo
            // información válida, no ruido.
            const yaProcesada = !!celda(fila, cols.propertytype);
            if (!yaProcesada) continue;

            const notaActual = celda(fila, cols.notes);
            if (!notaActual) continue;

            const n = analizarNotas(notaActual);
            if (!n.marcadorF && !n.pendCall) continue; // ya es solo texto libre

            const notaLimpia = construirNotas({ marcadorF: null, pendCall: false, libres: n.libres });
            if (notaLimpia === notaActual) continue;

            cambios.push({
                pestana: titulo, fila: idx + 1, cliente,
                antes: notaActual, despues: notaLimpia,
                rango: `'${titulo}'!${letraColumna(cols.notes)}${idx + 1}`
            });
        }
    });

    console.log(`🧹 ${cambios.length} fila(s) con ruido histórico en "notes":`);
    for (const c of cambios) {
        console.log(`  ${c.pestana} fila ${c.fila} — ${c.cliente}: "${c.antes}" → "${c.despues || "(vacío)"}"`);
    }

    if (!cambios.length) {
        console.log("Nada que limpiar.");
        return;
    }

    if (!ESCRIBIR) {
        console.log(`\n(dryRun) No se escribió nada. Corre con --escribir para aplicar estos ${cambios.length} cambios.`);
        return;
    }

    await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: ZION_SHEET_ID,
        requestBody: {
            valueInputOption: "USER_ENTERED",
            data: cambios.map(c => ({ range: c.rango, values: [[c.despues]] }))
        }
    });
    console.log(`✅ ${cambios.length} celda(s) de "notes" limpiadas.`);
}

main().catch(err => {
    console.error("❌", err.message);
    process.exit(1);
});
