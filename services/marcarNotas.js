import axios from "axios";
import { getSheetsClient } from "./properties.js";
import { enCola } from "./zionSheet.js";
import {
    normalizarTelefono, esPestanaDeMes, buscarCandidatos,
    letraColumna, celda
} from "../utils/pago.js";
import { elegirFilaProcesado } from "../utils/procesado.js";
import { conPendCall, conMarcadorIntento } from "../utils/notas.js";

/**
 * Los dos webhooks que escriben en la columna "notes":
 *
 *   - marcarPendienteProcesar: tag "pendiente_procesar" -> agrega "pend call"
 *   - marcarIntento:           tags "intento1/2/3"       -> escribe F1/F2/F3
 *
 * Comparten la misma fila a localizar (la que aun no tiene property type,
 * igual que marcar-procesado) y pasan TODO el ciclo leer->decidir->escribir
 * por la misma cola que usa marcar-procesado: dos de estos webhooks pueden
 * dispararse casi al mismo tiempo para el mismo cliente (un intento y un
 * pendiente_procesar), y si ambos leen la celda antes de que el otro escriba,
 * uno pisa al otro.
 */

const GHL_BASE = "https://services.leadconnectorhq.com";
const ZION_SHEET_ID = process.env.ZION_SHEET_ID;
const LIMITE_FILAS = 500;
const COLUMNA_FINAL = "AZ";

function headersGhl() {
    return {
        Authorization: `Bearer ${process.env.TOKEN_GHL}`,
        "Content-Type": "application/json",
        Version: "2023-02-21"
    };
}

async function getContacto(contactId) {
    const { data } = await axios.get(`${GHL_BASE}/contacts/${contactId}`, { headers: headersGhl() });
    return data.contact || data;
}

/** Tag aditivo de resultado, con prefijo propio para cada webhook. Nunca un PUT. */
async function marcarTagResultado(contacto, prefijo, estado) {
    const nuevo = `${prefijo}_${estado}`;
    const actuales = Array.isArray(contacto.tags) ? contacto.tags : [];
    const viejos = actuales.filter(t => String(t).startsWith(`${prefijo}_`) && t !== nuevo);

    if (viejos.length) {
        try {
            await axios.delete(`${GHL_BASE}/contacts/${contacto.id}/tags`, {
                headers: headersGhl(), data: { tags: viejos }
            });
        } catch (err) {
            console.warn(`⚠️ No se pudieron quitar ${viejos.join(", ")}:`, err.message);
        }
    }

    await axios.post(`${GHL_BASE}/contacts/${contacto.id}/tags`,
        { tags: [nuevo] }, { headers: headersGhl() });
    return nuevo;
}

async function pestanasDeMes(sheets) {
    const meta = await sheets.spreadsheets.get({
        spreadsheetId: ZION_SHEET_ID,
        fields: "sheets.properties(title)"
    });
    return meta.data.sheets.map(s => s.properties.title).filter(esPestanaDeMes);
}

async function leerPestanas(sheets, titulos) {
    if (!titulos.length) return [];
    const res = await sheets.spreadsheets.values.batchGet({
        spreadsheetId: ZION_SHEET_ID,
        ranges: titulos.map(t => `'${t}'!A1:${COLUMNA_FINAL}${LIMITE_FILAS}`)
    });
    return (res.data.valueRanges || []).map((r, i) => ({ titulo: titulos[i], filas: r.values || [] }));
}

async function localizarFila(sheets, telefono) {
    const titulos = await pestanasDeMes(sheets);
    const pestanas = await leerPestanas(sheets, titulos);
    const { candidatos, saltadas } = buscarCandidatos(pestanas, telefono);
    const decision = elegirFilaProcesado(candidatos);
    return { decision, candidatos, saltadas };
}

/**
 * Ciclo compartido: localizar telefono -> localizar fila -> calcular la
 * nota nueva -> escribir. `calcularNuevaNota` recibe la nota actual y
 * devuelve la nota nueva (o la misma, si no hay nada que cambiar).
 */
async function manejarNota({ contactId, dryRun, prefijoTag, calcularNuevaNota, contactoPrevio }) {
    if (!ZION_SHEET_ID) throw new Error("Falta ZION_SHEET_ID en el entorno");
    if (!contactId) throw new Error("Falta contactId");

    const contacto = contactoPrevio || await getContacto(contactId);
    const nombre = `${contacto.firstName || ""} ${contacto.lastName || ""}`.trim();
    const base = { contactId, cliente: nombre, dryRun };

    const telefono = normalizarTelefono(contacto.phone);
    if (!telefono) {
        const salida = {
            ok: false, estado: "no_encontrado", ...base,
            motivo: `El teléfono del contacto no sirve para buscar: "${contacto.phone || "(vacío)"}"`
        };
        if (!dryRun) salida.tag = await marcarTagResultado(contacto, prefijoTag, "no_encontrado");
        return salida;
    }

    return enCola(async () => {
        const sheets = getSheetsClient();
        const { decision, candidatos, saltadas } = await localizarFila(sheets, telefono);

        const contexto = {
            ...base, telefono,
            pestañasSaltadas: saltadas,
            filasConEseTelefono: candidatos.map(c => ({
                pestaña: c.pestana, fila: c.fila, cliente: c.cliente,
                yaProcesada: !!celda(c.datos, c.cols.propertytype)
            }))
        };

        if (decision.estado === "ambiguo") {
            const salida = {
                ok: false, estado: "ambiguo", ...contexto,
                motivo: `Hay ${candidatos.length} filas con ese teléfono y no puedo decidir en cuál anotar. Resuélvelo a mano.`
            };
            if (!dryRun) salida.tag = await marcarTagResultado(contacto, prefijoTag, "ambiguo");
            return salida;
        }

        if (decision.estado === "crear" || !decision.elegido) {
            const salida = {
                ok: false, estado: "no_encontrado", ...contexto,
                motivo: "No hay ninguna fila con ese teléfono en el tracker."
            };
            if (!dryRun) salida.tag = await marcarTagResultado(contacto, prefijoTag, "no_encontrado");
            return salida;
        }

        const fila = decision.elegido;

        if (fila.cols.notes === -1) {
            const salida = {
                ok: false, estado: "sin_columna_notes", ...contexto,
                pestaña: fila.pestana, fila: fila.fila,
                motivo: `La pestaña "${fila.pestana}" no tiene columna "notes".`
            };
            if (!dryRun) salida.tag = await marcarTagResultado(contacto, prefijoTag, "no_encontrado");
            return salida;
        }

        const notaActual = celda(fila.datos, fila.cols.notes);
        const notaNueva = calcularNuevaNota(notaActual);

        if (notaNueva === notaActual) {
            const salida = {
                ok: true, estado: "sin_cambios", ...contexto,
                pestaña: fila.pestana, fila: fila.fila, cliente: fila.cliente, nota: notaActual
            };
            if (!dryRun) salida.tag = await marcarTagResultado(contacto, prefijoTag, "ok");
            return salida;
        }

        if (!dryRun) {
            await sheets.spreadsheets.values.update({
                spreadsheetId: ZION_SHEET_ID,
                range: `'${fila.pestana}'!${letraColumna(fila.cols.notes)}${fila.fila}`,
                valueInputOption: "USER_ENTERED",
                requestBody: { values: [[notaNueva]] }
            });
            console.log(`📝 Nota: ${fila.cliente} → "${fila.pestana}" fila ${fila.fila}: "${notaActual}" → "${notaNueva}"`);
        }

        const salida = {
            ok: true, estado: "ok", ...contexto,
            pestaña: fila.pestana, fila: fila.fila, cliente: fila.cliente,
            notaAntes: notaActual, notaDespues: notaNueva
        };
        if (!dryRun) salida.tag = await marcarTagResultado(contacto, prefijoTag, "ok");
        return salida;
    });
}

/** Tag "pendiente_procesar" -> agrega "pend call" en notes (idempotente). */
export async function marcarPendienteProcesar({ contactId, dryRun = false }) {
    return manejarNota({
        contactId, dryRun, prefijoTag: "notapendcall",
        calcularNuevaNota: conPendCall
    });
}

/** Numero del intento mas alto que tenga el contacto ahora mismo. 0 si ninguno. */
function numeroIntentoMasAlto(tags) {
    let max = 0;
    for (const t of tags) {
        const m = String(t).match(/^intento([123])$/i);
        if (m) max = Math.max(max, Number(m[1]));
    }
    return max;
}

/** Tags "intento1/2/3" -> escribe F1/F2/F3 en notes (reemplaza, no acumula). */
export async function marcarIntento({ contactId, dryRun = false }) {
    if (!contactId) throw new Error("Falta contactId");

    const contacto = await getContacto(contactId);
    const nombre = `${contacto.firstName || ""} ${contacto.lastName || ""}`.trim();
    const numero = numeroIntentoMasAlto(Array.isArray(contacto.tags) ? contacto.tags : []);

    if (!numero) {
        return {
            ok: false, estado: "sin_tag_intento", contactId, cliente: nombre, dryRun,
            motivo: "El contacto no tiene ningún tag intento1/intento2/intento3."
        };
    }

    return manejarNota({
        contactId, dryRun, prefijoTag: "notaintento", contactoPrevio: contacto,
        calcularNuevaNota: (notaActual) => conMarcadorIntento(notaActual, numero)
    });
}
