import { getSheetsClient, normalizar } from "./properties.js";

/**
 * Escribe el lead en tu tracker "Copia Zion Dealer Copia".
 *
 * Dos reglas:
 *
 *  1. La pestaña se elige por el MES DE MUDANZA del lead, con tu formato
 *     "Mes/Año" en inglés:  MI 8/10 → "August/2026",  10/6 → "October/2026".
 *
 *  2. Si esa pestaña no existe, se crea duplicando la pestaña "BASE",
 *     que ya trae encabezados y fórmulas. Nunca se construye a mano.
 *
 * Dentro de la pestaña NO agrega filas al final: busca la primera fila con
 * Customer vacío y escribe SOLO en cuatro celdas —
 * 👤Customer | 🏢Leasing Agent | Phone 📲 | Move - in Date — así las columnas
 * de Revenue/Profit conservan sus fórmulas intactas.
 *
 * Env:
 *  - ZION_SHEET_ID  → id de "Copia Zion Dealer Copia"
 *  - ZION_BASE_TAB  → nombre de la plantilla (default: "BASE")
 */

const ZION_SHEET_ID = process.env.ZION_SHEET_ID;
const ZION_BASE_TAB = process.env.ZION_BASE_TAB || "BASE";

const LIMITE_BUSQUEDA = 500;

const MESES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
];

// ------------------------------------------------------------------
// Nombre de la pestaña a partir de la fecha de mudanza
// ------------------------------------------------------------------

/**
 * El parser devuelve "09-10-2026" (MM-DD-YYYY).
 * @returns {string} "September/2026". Si no hay fecha, usa el mes actual.
 */
export function pestanaDesdeMoveIn(moveIn) {
    const m = String(moveIn || "").match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);

    if (m) {
        const mes = Number(m[1]);
        const anio = m[3];
        if (mes >= 1 && mes <= 12) return `${MESES[mes - 1]}/${anio}`;
    }

    const hoy = new Date();
    return `${MESES[hoy.getMonth()]}/${hoy.getFullYear()}`;
}

/** "09-10-2026" → "9/10/26", el formato que usas en la hoja. */
export function fechaParaZion(moveIn) {
    const m = String(moveIn || "").match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
    if (!m) return moveIn || "";
    return `${Number(m[1])}/${Number(m[2])}/${m[3].slice(2)}`;
}

// ------------------------------------------------------------------
// Utilidades de hoja
// ------------------------------------------------------------------

/**
 * "+12146845278" -> "(214) 684-5278", que es como esta el resto de la columna.
 *
 * Ademas evita que Sheets lo trate como numero: con valueInputOption
 * USER_ENTERED, un "+12146845278" se interpreta como cifra, se come el "+"
 * y queda alineado a la derecha como 12146845278.
 */
export function telefonoParaZion(phone) {
    let d = String(phone || "").replace(/\D/g, "");
    if (!d) return "";
    if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
    if (d.length !== 10) return String(phone || "");   // internacional: tal cual
    return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

/** Quita emojis para poder comparar encabezados. */
function limpiarEncabezado(texto) {
    return normalizar(
        String(texto || "")
            .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, "")
            .replace(/[-\s]+/g, " ")
    );
}

/** Índice de columna (0) → letra de Sheets (A). */
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

/**
 * Busca la fila de encabezados. Tu hoja tiene una fila de totales arriba,
 * así que no siempre es la fila 1.
 */
export function ubicarEncabezados(filas) {
    for (let i = 0; i < Math.min(filas.length, 10); i++) {
        const limpia = (filas[i] || []).map(limpiarEncabezado);

        const customer = limpia.findIndex(c => c === "customer");
        if (customer === -1) continue;

        const agent = limpia.findIndex(c => c === "leasing agent");
        const phone = limpia.findIndex(c => c === "phone");
        const moveIn = limpia.findIndex(c => c === "move in date" || c === "move in");

        if (agent > -1 && phone > -1 && moveIn > -1) {
            return { filaHeader: i, customer, agent, phone, moveIn };
        }
    }
    return null;
}

async function listarPestanas(sheets) {
    const meta = await sheets.spreadsheets.get({
        spreadsheetId: ZION_SHEET_ID,
        fields: "sheets.properties(title,sheetId,index)"
    });
    return meta.data.sheets.map(s => s.properties);
}

// ------------------------------------------------------------------
// Crear la pestaña del mes si no existe
// ------------------------------------------------------------------

/**
 * Devuelve el nombre de la pestaña del mes, creándola desde BASE si falta.
 * @returns {Object} { tab, creada:boolean }
 */
export async function asegurarPestanaMes(sheets, nombreMes) {
    let pestanas = await listarPestanas(sheets);

    const existente = pestanas.find(p => normalizar(p.title) === normalizar(nombreMes));
    if (existente) return { tab: existente.title, creada: false };

    const base = pestanas.find(p => normalizar(p.title) === normalizar(ZION_BASE_TAB));
    if (!base) {
        throw new Error(
            `Falta "${nombreMes}" y no encuentro la plantilla "${ZION_BASE_TAB}" para clonarla`
        );
    }

    try {
        await sheets.spreadsheets.batchUpdate({
            spreadsheetId: ZION_SHEET_ID,
            requestBody: {
                requests: [{
                    duplicateSheet: {
                        sourceSheetId: base.sheetId,
                        newSheetName: nombreMes,
                        insertSheetIndex: pestanas.length
                    }
                }]
            }
        });

        console.log(`🆕 Pestaña "${nombreMes}" creada desde "${base.title}"`);
        return { tab: nombreMes, creada: true };

    } catch (err) {
        // Si dos leads del mismo mes entran a la vez, el segundo choca con
        // "ya existe una hoja con ese nombre". Volvemos a mirar antes de fallar.
        pestanas = await listarPestanas(sheets);
        const ahora = pestanas.find(p => normalizar(p.title) === normalizar(nombreMes));
        if (ahora) return { tab: ahora.title, creada: false };
        throw err;
    }
}

// ------------------------------------------------------------------
// Crecer la pestaña cuando se llena
// ------------------------------------------------------------------

/** Cuántas filas se agregan de una vez, para no crecer de a una. */
const FILAS_A_AGREGAR = 30;

/**
 * Se asegura de que la fila `filaNecesaria` EXISTA en la pestaña.
 *
 * El bug que esto arregla: una pestaña de mes nace clonando BASE, que trae
 * pocas filas. Cuando se llenan, values.get deja de devolver filas vacías, el
 * codigo calcula "la siguiente" y Sheets responde:
 *
 *   Range ('September/2026'!A17) exceeds grid limits. Max rows: 16
 *
 * En marcar-procesado eso se ve como un webhook fallido. En el registro de
 * leads es peor: el error se captura y el lead simplemente no queda escrito,
 * con un aviso en los logs que nadie mira.
 *
 * Las filas nuevas NO se agregan en blanco. Se agregan y despues se les copia
 * encima una fila plantilla de BASE, para que hereden las FORMULAS (revenue,
 * pay agent, profit, paid period) y la validacion de los desplegables. Una
 * fila agregada en blanco se veria bien y calcularia mal.
 */
export async function asegurarFilasHasta(sheets, tab, filaNecesaria) {
    const meta = await sheets.spreadsheets.get({
        spreadsheetId: ZION_SHEET_ID,
        fields: "sheets.properties(title,sheetId,gridProperties(rowCount,columnCount))"
    });

    const hoja = meta.data.sheets.find(h => h.properties.title === tab);
    if (!hoja) throw new Error(`No encontré la pestaña "${tab}"`);

    const filasActuales = hoja.properties.gridProperties.rowCount;
    if (filasActuales >= filaNecesaria) return { agregadas: 0 };

    const base = meta.data.sheets.find(
        h => normalizar(h.properties.title) === normalizar(ZION_BASE_TAB)
    );
    if (!base) {
        throw new Error(
            `"${tab}" se quedó sin filas (${filasActuales}) y no encuentro "${ZION_BASE_TAB}" ` +
            `para copiar una fila con fórmulas. Agrega filas a mano.`
        );
    }

    // La fila plantilla de BASE: la primera después de sus encabezados.
    const resBase = await sheets.spreadsheets.values.get({
        spreadsheetId: ZION_SHEET_ID,
        range: `'${base.properties.title}'!A1:Z20`
    });
    const cabecerasBase = ubicarEncabezados(resBase.data.values || []);
    if (!cabecerasBase) {
        throw new Error(`No encontré los encabezados en "${ZION_BASE_TAB}"`);
    }
    const filaPlantilla = cabecerasBase.filaHeader + 1;   // 0-based

    const objetivo = filaNecesaria + FILAS_A_AGREGAR;
    const columnas = Math.min(
        hoja.properties.gridProperties.columnCount,
        base.properties.gridProperties.columnCount
    );

    await sheets.spreadsheets.batchUpdate({
        spreadsheetId: ZION_SHEET_ID,
        requestBody: {
            requests: [
                {
                    appendDimension: {
                        sheetId: hoja.properties.sheetId,
                        dimension: "ROWS",
                        length: objetivo - filasActuales
                    }
                },
                {
                    // Tilea la fila plantilla sobre todas las nuevas: fórmulas
                    // con referencias ya ajustadas a cada fila.
                    copyPaste: {
                        source: {
                            sheetId: base.properties.sheetId,
                            startRowIndex: filaPlantilla,
                            endRowIndex: filaPlantilla + 1,
                            startColumnIndex: 0,
                            endColumnIndex: columnas
                        },
                        destination: {
                            sheetId: hoja.properties.sheetId,
                            startRowIndex: filasActuales,
                            endRowIndex: objetivo,
                            startColumnIndex: 0,
                            endColumnIndex: columnas
                        },
                        pasteType: "PASTE_NORMAL"
                    }
                }
            ]
        }
    });

    console.log(`📐 "${tab}" se llenó (${filasActuales} filas); agregadas ${objetivo - filasActuales} con las fórmulas de "${base.properties.title}"`);
    return { agregadas: objetivo - filasActuales };
}

// ------------------------------------------------------------------
// Escritura del lead
// ------------------------------------------------------------------

// ------------------------------------------------------------------
// Cola de escritura
// ------------------------------------------------------------------

/**
 * Todas las escrituras pasan de a una.
 *
 * Sin esto: el batch procesa 5 leads en paralelo, los 5 leen la hoja casi
 * al mismo tiempo, los 5 ven la misma fila vacía y los 5 escriben ahí.
 * Resultado: 5 contactos en GHL pero UNA sola fila en el tracker, y el
 * usuario no se entera porque los 5 reportan éxito.
 *
 * Encadenar promesas es suficiente: Node es de un solo hilo y esta es la
 * única ruta que escribe en la hoja.
 */
let colaEscritura = Promise.resolve();

export function enCola(tarea) {
    const resultado = colaEscritura.then(tarea, tarea);
    // La cola nunca se rompe: un fallo no debe bloquear los siguientes leads
    colaEscritura = resultado.then(() => {}, () => {});
    return resultado;
}

/**
 * @param {Object} lead - { firstName, lastName, phone, moveIn, source }
 * @returns {Object} { ok, tab, fila, pestanaCreada }
 */
export function registrarEnZion(lead) {
    return enCola(() => escribirLead(lead));
}

async function escribirLead(lead) {
    if (!ZION_SHEET_ID) throw new Error("Falta ZION_SHEET_ID en el entorno");

    const sheets = getSheetsClient();

    const nombreMes = pestanaDesdeMoveIn(lead.moveIn);
    const { tab, creada } = await asegurarPestanaMes(sheets, nombreMes);

    const res = await sheets.spreadsheets.values.get({
        spreadsheetId: ZION_SHEET_ID,
        range: `${tab}!A1:Z${LIMITE_BUSQUEDA}`
    });
    const filas = res.data.values || [];

    const cols = ubicarEncabezados(filas);
    if (!cols) {
        throw new Error(
            `No encontré los encabezados (Customer / Leasing Agent / Phone / Move-in) en "${tab}". ` +
            `Revisa que "${ZION_BASE_TAB}" los tenga.`
        );
    }

    // Primera fila después del header con Customer vacío
    let destino = -1;
    for (let i = cols.filaHeader + 1; i < LIMITE_BUSQUEDA; i++) {
        if (!(((filas[i] || [])[cols.customer]) || "").trim()) { destino = i; break; }
    }
    if (destino === -1) {
        throw new Error(`No hay filas libres en "${tab}" dentro de las primeras ${LIMITE_BUSQUEDA}`);
    }

    const numeroFila = destino + 1;
    await asegurarFilasHasta(sheets, tab, numeroFila);

    const nombre = `${lead.firstName || ""} ${lead.lastName || ""}`.trim();

    // Una celda por columna: nunca tocamos rangos que abarquen fórmulas
    const data = [
        { col: cols.customer, valor: nombre },
        { col: cols.agent, valor: lead.source || "" },
        { col: cols.phone, valor: telefonoParaZion(lead.phone) },
        { col: cols.moveIn, valor: fechaParaZion(lead.moveIn) }
    ].map(({ col, valor }) => ({
        range: `${tab}!${letraColumna(col)}${numeroFila}`,
        values: [[valor]]
    }));

    await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: ZION_SHEET_ID,
        requestBody: { valueInputOption: "USER_ENTERED", data }
    });

    console.log(`📊 Zion Dealer: "${nombre}" → "${tab}" fila ${numeroFila}`);
    return { ok: true, tab, fila: numeroFila, pestanaCreada: creada };
}

/** Versión que nunca lanza: si Sheets falla, el lead ya quedó en GHL igual. */
export async function registrarEnZionSeguro(lead) {
    try {
        return await registrarEnZion(lead);
    } catch (err) {
        console.warn("⚠️ No se pudo escribir en Zion Dealer:", err.message);
        return { ok: false, error: err.message };
    }
}
