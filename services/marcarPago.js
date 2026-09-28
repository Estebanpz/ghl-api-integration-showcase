import axios from "axios";
import { getSheetsClient } from "./properties.js";
import {
    normalizarTelefono, esPestanaDeMes, buscarCandidatos,
    decidir, planEscritura, letraColumna, celda
} from "../utils/pago.js";

/**
 * Marca installed / paid me / agent paid en el tracker cuando un contacto
 * recibe el tag "paid" en GHL.
 *
 * Se dispara desde el workflow "Marcar Pago", con el mismo patron ya probado
 * de "Link WhatsApp":
 *   Tag paid -> GET /health -> Wait 70s -> POST /webhook/marcar-pago
 *
 * La logica que decide DONDE escribir vive en utils/pago.js, sin llamadas de
 * red, y esta cubierta por scripts/test-pago.js con filas reales de la hoja.
 * Aqui solo esta la plomeria: leer GHL, leer las pestañas, escribir, etiquetar.
 */

const GHL_BASE = "https://services.leadconnectorhq.com";
const ZION_SHEET_ID = process.env.ZION_SHEET_ID;
const LIMITE_FILAS = 500;

// Se lee hasta AZ, no hasta Z: si alguien inserta columnas, las de pago se
// corren a la derecha y con A:Z quedarian fuera del rango leido.
const COLUMNA_FINAL = "AZ";

const TAGS_RESULTADO = {
    ok: "pago_ok",
    ambiguo: "pago_ambiguo",
    no_encontrado: "pago_no_encontrado"
};

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

/**
 * Deja UN solo tag de resultado en el contacto.
 *
 * Se usa el endpoint ADITIVO de tags, no un PUT del contacto. Con PUT hay que
 * mandar el array completo, y si el GET no trajera los tags (payload raro,
 * campo ausente) el contacto se quedaria SIN sus tags: adios "new lead",
 * adios "intento1", y el seguimiento roto sin que nadie se entere.
 *
 * Los pago_* anteriores se borran antes: si un contacto salio ambiguo, lo
 * arreglaste a mano y se vuelve a disparar, no puede quedar con pago_ambiguo
 * y pago_ok a la vez — filtrar por tag dejaria de servir.
 */
async function marcarTag(contacto, estado) {
    const nuevo = TAGS_RESULTADO[estado];
    const actuales = Array.isArray(contacto.tags) ? contacto.tags : [];
    const viejos = actuales.filter(t => String(t).startsWith("pago_") && t !== nuevo);

    if (viejos.length) {
        try {
            await axios.delete(`${GHL_BASE}/contacts/${contacto.id}/tags`, {
                headers: headersGhl(),
                data: { tags: viejos }
            });
        } catch (err) {
            // No bloquea: es mejor un tag de mas que perder el resultado.
            console.warn(`⚠️ No se pudieron quitar los tags ${viejos.join(", ")}:`, err.message);
        }
    }

    await axios.post(
        `${GHL_BASE}/contacts/${contacto.id}/tags`,
        { tags: [nuevo] },
        { headers: headersGhl() }
    );
    return nuevo;
}

/** Titulos de las pestañas que parecen de un mes. */
async function pestanasDeMes(sheets) {
    const meta = await sheets.spreadsheets.get({
        spreadsheetId: ZION_SHEET_ID,
        fields: "sheets.properties(title)"
    });
    return meta.data.sheets
        .map(s => s.properties.title)
        .filter(esPestanaDeMes);
}

/** Una sola llamada para todas las pestañas, en vez de una por pestaña. */
async function leerPestanas(sheets, titulos) {
    if (!titulos.length) return [];
    const res = await sheets.spreadsheets.values.batchGet({
        spreadsheetId: ZION_SHEET_ID,
        ranges: titulos.map(t => `'${t}'!A1:${COLUMNA_FINAL}${LIMITE_FILAS}`)
    });
    return (res.data.valueRanges || []).map((r, i) => ({
        titulo: titulos[i],
        filas: r.values || []
    }));
}

/**
 * @param {Object} opciones
 * @param {string} opciones.contactId
 * @param {boolean} opciones.dryRun - busca y decide, pero no escribe ni etiqueta
 * @returns {Object} resultado listo para devolver por HTTP
 */
export async function marcarPago({ contactId, dryRun = false }) {
    if (!ZION_SHEET_ID) throw new Error("Falta ZION_SHEET_ID en el entorno");
    if (!contactId) throw new Error("Falta contactId");

    const contacto = await getContacto(contactId);
    const nombreGhl = `${contacto.firstName || ""} ${contacto.lastName || ""}`.trim();

    // Un telefono corto no se busca: un match parcial escribiria en la fila
    // de otra persona, y eso no se detecta nunca.
    const telefono = normalizarTelefono(contacto.phone);
    if (!telefono) {
        const salida = {
            ok: false,
            estado: "no_encontrado",
            motivo: `El teléfono del contacto no sirve para buscar: "${contacto.phone || "(vacío)"}"`,
            contactId,
            cliente: nombreGhl
        };
        if (!dryRun) salida.tag = await marcarTag(contacto, "no_encontrado");
        return salida;
    }

    const sheets = getSheetsClient();
    const titulos = await pestanasDeMes(sheets);
    const pestanas = await leerPestanas(sheets, titulos);

    const { candidatos, saltadas } = buscarCandidatos(pestanas, telefono);
    const { estado, elegido, candidatos: finalistas } = decidir(candidatos);

    const base = {
        estado,
        contactId,
        cliente: nombreGhl,
        telefono,
        dryRun,
        pestañasRevisadas: titulos,
        pestañasSaltadas: saltadas,
        filasConEseTelefono: candidatos.map(c => ({
            pestaña: c.pestana, fila: c.fila, cliente: c.cliente, ventaReal: c.ventaReal
        }))
    };

    if (estado !== "ok") {
        const salida = {
            ok: false,
            ...base,
            motivo: estado === "ambiguo"
                ? `Hay ${finalistas.length} filas con venta real y el mismo teléfono. No se escribe nada: hay que resolverlo a mano.`
                : "Ninguna fila con ese teléfono tiene tipo de propiedad y venta."
        };
        if (!dryRun) salida.tag = await marcarTag(contacto, estado);
        return salida;
    }

    const { escritas, respetadas } = planEscritura(elegido);

    // Un rango por celda, no un rango contiguo P:R. Hoy son contiguas; el dia
    // que alguien inserte una columna en medio, esto sigue siendo correcto.
    if (escritas.length && !dryRun) {
        await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId: ZION_SHEET_ID,
            requestBody: {
                valueInputOption: "USER_ENTERED",
                data: escritas.map(e => ({
                    range: `'${elegido.pestana}'!${letraColumna(e.columna)}${elegido.fila}`,
                    values: [["YES"]]
                }))
            }
        });
        console.log(`💰 Pago marcado: ${elegido.cliente} → "${elegido.pestana}" fila ${elegido.fila} (${escritas.map(e => e.campo).join(", ")})`);
    }

    const salida = {
        ok: true,
        ...base,
        pestaña: elegido.pestana,
        fila: elegido.fila,
        cliente: elegido.cliente,
        agente: elegido.agente,
        installDate: elegido.installDate,
        escritas: escritas.map(e => e.campo),
        respetadas: respetadas.map(r => `${r.campo}="${r.valor}"`)
    };
    if (!dryRun) salida.tag = await marcarTag(contacto, "ok");
    return salida;
}
