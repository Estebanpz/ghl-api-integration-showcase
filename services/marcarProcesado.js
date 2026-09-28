import axios from "axios";
import { getSheetsClient } from "./properties.js";
import { asegurarPestanaMes, enCola, asegurarFilasHasta } from "./zionSheet.js";
import { valorCustomField } from "./syncAddress.js";
import {
    normalizarTelefono, buscarCandidatos, letraColumna, celda, esPestanaDeMes,
    ubicarEncabezadosPago
} from "../utils/pago.js";
import {
    elegirFilaProcesado, valoresParaHoja, pestanaDesdeFecha, fechaParaHoja
} from "../utils/procesado.js";

/**
 * Escribe en el tracker los datos de la venta cuando el contacto recibe el
 * tag "procesado" en GHL, y si la instalacion cae en otro mes, mueve la fila
 * a la pestaña de ese mes (creandola desde BASE si no existe).
 *
 * Los montos NO se escriben: la hoja los calcula sola a partir de property
 * type, las ventas, el provider y la velocidad.
 */

const GHL_BASE = "https://services.leadconnectorhq.com";
const ZION_SHEET_ID = process.env.ZION_SHEET_ID;
const LIMITE_FILAS = 500;
const COLUMNA_FINAL = "AZ";

const TAGS_RESULTADO = {
    ok: "procesado_ok",
    ambiguo: "procesado_ambiguo",
    no_encontrado: "procesado_no_encontrado"
};

/**
 * Nombres de los custom fields en GHL.
 *
 * Con alias a proposito: el campo del plan nacio como "A&T PLAN" y despues
 * se renombro a "Speed". Un nombre que cambia en la interfaz no deberia
 * tumbar un webhook — se aceptan los dos y gana el que exista.
 *
 * `requerido: false` significa que si no esta, se sigue sin ese dato en vez
 * de rechazar la peticion completa.
 */
export const CF_ALIAS = {
    propertyType: { nombres: ["Property Type"], requerido: true },
    installDate:  { nombres: ["Installation Date"], requerido: true },
    plan:         { nombres: ["Speed", "A&T PLAN"], requerido: true },
    sales:        { nombres: ["Sales"], requerido: true },
    provider:     { nombres: ["Provider", "Proveedor"], requerido: false },
    moveIn:       { nombres: ["Move In Date"], requerido: false }
};

/** Todos los nombres posibles, para pedirle a GHL que recargue la cache. */
export function nombresProcesado() {
    return Object.values(CF_ALIAS).flatMap(c => c.nombres);
}

/** La definicion del primer alias que exista en la cache. */
function definicion(customFields, clave) {
    for (const n of CF_ALIAS[clave].nombres) {
        if (customFields[n]) return customFields[n];
    }
    return null;
}

/** Solo los REQUERIDOS que no existen con ninguno de sus nombres. */
export function faltantesProcesado(customFields) {
    if (!customFields) return Object.keys(CF_ALIAS);
    return Object.entries(CF_ALIAS)
        .filter(([clave, cfg]) => cfg.requerido && !definicion(customFields, clave))
        .map(([, cfg]) => cfg.nombres[0]);
}

// Las columnas que el webhook maneja. Todo lo demas —internet revenue,
// electricity revenue, pay agent, profit, paid period, t revenue— son
// FORMULAS y no se tocan nunca, ni al escribir ni al vaciar.
const COLUMNAS_DATOS = [
    "customer", "agent", "phone", "moveIn", "propertytype", "installDate",
    "notes", "internetsold", "electricitysold", "provider", "speed",
    "installed", "paidme", "agentpaid"
];

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
 * Quita "pendiente_procesar" cuando la venta ya quedó escrita.
 *
 * Solo se llama en el camino de éxito: si salió ambiguo o no encontrado no se
 * escribió nada, así que el pedido sigue pendiente y el jefe lo debe seguir
 * viendo para llamar.
 */
async function quitarTagPendienteProcesar(contacto) {
    const actuales = Array.isArray(contacto.tags) ? contacto.tags : [];
    if (!actuales.includes("pendiente_procesar")) return;
    try {
        await axios.delete(`${GHL_BASE}/contacts/${contacto.id}/tags`, {
            headers: headersGhl(), data: { tags: ["pendiente_procesar"] }
        });
    } catch (err) {
        console.warn(`⚠️ No se pudo quitar pendiente_procesar de ${contacto.id}:`, err.message);
    }
}

/** Tag aditivo, quitando antes los procesado_* viejos. Nunca un PUT. */
async function marcarTag(contacto, estado) {
    const nuevo = TAGS_RESULTADO[estado];
    const actuales = Array.isArray(contacto.tags) ? contacto.tags : [];
    const viejos = actuales.filter(t => String(t).startsWith("procesado_") && t !== nuevo);

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

/** Lee una pestaña sola, para ubicar sus encabezados y su primera fila libre. */
async function leerUna(sheets, titulo) {
    const res = await sheets.spreadsheets.values.get({
        spreadsheetId: ZION_SHEET_ID,
        range: `'${titulo}'!A1:${COLUMNA_FINAL}${LIMITE_FILAS}`
    });
    return res.data.values || [];
}

/** Un rango por celda: nunca un rango contiguo que pueda abarcar formulas. */
function celdasDe(pestana, fila, cols, pares) {
    return Object.entries(pares)
        .filter(([clave]) => cols[clave] > -1)
        .map(([clave, valor]) => ({
            range: `'${pestana}'!${letraColumna(cols[clave])}${fila}`,
            values: [[valor ?? ""]]
        }));
}

/**
 * @param {Object} opciones - { contactId, customFields, dryRun }
 */
export async function marcarProcesado({ contactId, customFields, dryRun = false }) {
    if (!ZION_SHEET_ID) throw new Error("Falta ZION_SHEET_ID en el entorno");
    if (!contactId) throw new Error("Falta contactId");
    if (!customFields) throw new Error("Los custom fields de GHL no están cargados");

    const contacto = await getContacto(contactId);
    const nombre = `${contacto.firstName || ""} ${contacto.lastName || ""}`.trim();

    const leer = (clave) => valorCustomField(contacto, definicion(customFields, clave));
    const datosGhl = {
        propertyType: leer("propertyType"),
        installDate: leer("installDate"),
        plan: leer("plan"),
        sales: leer("sales"),
        provider: leer("provider"),
        moveIn: leer("moveIn")
    };

    // El provider no bloquea, pero si falta hay que decirlo: la hoja se queda
    // sin proveedor y eso se nota despues, cuando ya nadie recuerda por que.
    const avisos = [];
    if (!definicion(customFields, "provider")) {
        avisos.push('No existe el custom field "Provider" en GHL: esa columna se deja vacía.');
    }

    const base = { contactId, cliente: nombre, dryRun, datosGhl, avisos };

    // Sin fecha de instalacion no hay pestaña destino posible.
    const pestanaDestino = pestanaDesdeFecha(datosGhl.installDate);
    if (!pestanaDestino) {
        const salida = {
            ok: false, estado: "no_encontrado", ...base,
            motivo: `Falta o no se entiende la Installation Date: "${datosGhl.installDate || "(vacía)"}"`
        };
        if (!dryRun) salida.tag = await marcarTag(contacto, "no_encontrado");
        return salida;
    }

    const telefono = normalizarTelefono(contacto.phone);
    if (!telefono) {
        const salida = {
            ok: false, estado: "no_encontrado", ...base,
            motivo: `El teléfono del contacto no sirve para buscar: "${contacto.phone || "(vacío)"}"`
        };
        if (!dryRun) salida.tag = await marcarTag(contacto, "no_encontrado");
        return salida;
    }

    const sheets = getSheetsClient();
    const titulos = await pestanasDeMes(sheets);
    const { candidatos, saltadas } = buscarCandidatos(await leerPestanas(sheets, titulos), telefono);
    const decision = elegirFilaProcesado(candidatos);

    const valores = valoresParaHoja(datosGhl);
    const contexto = {
        ...base, telefono, pestanaDestino, valores,
        pestañasSaltadas: saltadas,
        filasConEseTelefono: candidatos.map(c => ({
            pestaña: c.pestana, fila: c.fila, cliente: c.cliente,
            yaProcesada: !!celda(c.datos, c.cols.propertytype)
        }))
    };

    if (decision.estado === "ambiguo") {
        const salida = {
            ok: false, estado: "ambiguo", ...contexto,
            motivo: `Hay ${candidatos.length} filas con ese teléfono y no puedo decidir cuál procesar. Resuélvelo a mano.`
        };
        if (!dryRun) salida.tag = await marcarTag(contacto, "ambiguo");
        return salida;
    }

    const origen = decision.elegido;
    const mismaPestana = origen && origen.pestana === pestanaDestino;

    // ── Caso simple: la fila ya está en el mes correcto ────────────
    if (mismaPestana) {
        if (!dryRun) {
            // Al procesar se vacía notes siempre, sin importar qué tenía —
            // si el cliente quedó a nombre de otra persona, eso lo anota
            // Esteban a mano en la hoja.
            await sheets.spreadsheets.values.batchUpdate({
                spreadsheetId: ZION_SHEET_ID,
                requestBody: {
                    valueInputOption: "USER_ENTERED",
                    data: celdasDe(origen.pestana, origen.fila, origen.cols, { ...valores, notes: "" })
                }
            });
            console.log(`🧾 Procesado: ${origen.cliente} → "${origen.pestana}" fila ${origen.fila}`);
        }
        const salida = {
            ok: true, estado: "ok", ...contexto,
            movida: false, correccion: !!decision.correccion,
            destino: { pestaña: origen.pestana, fila: origen.fila, pestañaCreada: false }
        };
        if (!dryRun) {
            salida.tag = await marcarTag(contacto, "ok");
            await quitarTagPendienteProcesar(contacto);
        }
        return salida;
    }

    // ── Casos que CREAN fila: mover, o crear desde cero ────────────
    //
    // Buscar la primera fila libre y escribir en ella tiene que pasar por la
    // misma cola que usa el registro de leads. Si no, un lead nuevo y este
    // webhook eligen la misma fila y uno pisa al otro — es exactamente la
    // condicion de carrera que ya nos mordio una vez.
    // En dryRun se corta ANTES de asegurarPestanaMes: esa funcion clona BASE,
    // o sea que crearia la pestaña de verdad. Un dryRun que escribe no es un
    // dryRun.
    const destinoExiste = titulos.includes(pestanaDestino);
    if (dryRun) {
        return {
            ok: true, estado: "ok", ...contexto,
            movida: !!origen,
            origen: origen ? { pestaña: origen.pestana, fila: origen.fila, vaciada: false } : null,
            destino: {
                pestaña: pestanaDestino,
                fila: destinoExiste ? "(la primera libre)" : "(la primera libre de la pestaña nueva)",
                pestañaCreada: !destinoExiste
            }
        };
    }

    const trabajo = async () => {
        const { tab, creada } = await asegurarPestanaMes(sheets, pestanaDestino);
        const filasDestino = await leerUna(sheets, tab);

        const ubic = ubicarEncabezadosPago(filasDestino);
        if (!ubic) throw new Error(`La pestaña "${tab}" no tiene los encabezados esperados`);

        let libre = -1;
        for (let i = ubic.filaHeader + 1; i < LIMITE_FILAS; i++) {
            if (!celda(filasDestino[i] || [], ubic.cols.customer)) { libre = i + 1; break; }
        }
        if (libre === -1) throw new Error(`No hay filas libres en "${tab}"`);

        // La fila puede no existir todavia: una pestaña clonada de BASE trae
        // pocas filas y al llenarse Sheets responde "exceeds grid limits".
        await asegurarFilasHasta(sheets, tab, libre);

        // Los datos base salen de la fila origen si existe; si no, de GHL.
        // notes SIEMPRE arranca vacía en el destino: al procesar se limpia,
        // no se arrastra (ver quitarTagPendienteProcesar más abajo).
        const baseFila = origen ? {
            customer: celda(origen.datos, origen.cols.customer),
            agent: celda(origen.datos, origen.cols.agent),
            phone: celda(origen.datos, origen.cols.phone),
            moveIn: celda(origen.datos, origen.cols.moveIn),
            notes: ""
        } : {
            customer: nombre,
            agent: contacto.source || "",
            phone: contacto.phone || "",
            moveIn: fechaParaHoja(datosGhl.moveIn),
            notes: ""
        };

        {
            await sheets.spreadsheets.values.batchUpdate({
                spreadsheetId: ZION_SHEET_ID,
                requestBody: {
                    valueInputOption: "USER_ENTERED",
                    data: celdasDe(tab, libre, ubic.cols, { ...baseFila, ...valores })
                }
            });

            // Vaciar el origen SOLO en las columnas de datos. Las de formula
            // se quedan: borrarlas dejaria esa fila rota para siempre.
            if (origen) {
                const vacias = {};
                for (const c of COLUMNAS_DATOS) vacias[c] = "";
                await sheets.spreadsheets.values.batchUpdate({
                    spreadsheetId: ZION_SHEET_ID,
                    requestBody: {
                        valueInputOption: "USER_ENTERED",
                        data: celdasDe(origen.pestana, origen.fila, origen.cols, vacias)
                    }
                });
            }

            console.log(`🚚 Procesado: ${baseFila.customer} → "${tab}" fila ${libre}` +
                        (origen ? ` (movido desde "${origen.pestana}" fila ${origen.fila})` : " (fila nueva)"));
        }

        return { tab, libre, creada, baseFila };
    };

    const { tab, libre, creada, baseFila } = await enCola(trabajo);

    const salida = {
        ok: true,
        estado: "ok",
        ...contexto,
        cliente: baseFila.customer || nombre,
        movida: !!origen,
        origen: origen ? { pestaña: origen.pestana, fila: origen.fila, vaciada: true } : null,
        destino: { pestaña: tab, fila: libre, pestañaCreada: creada }
    };
    if (!dryRun) {
        salida.tag = await marcarTag(contacto, "ok");
        await quitarTagPendienteProcesar(contacto);
    }
    return salida;
}
