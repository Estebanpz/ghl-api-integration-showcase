import dotenv from "dotenv";
dotenv.config();

import express, { json, static as serveStatic } from "express";
import cors from "cors";
import axios from "axios";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { createRequire } from "module";

import { verCustomFields, camposFaltantes, CAMPOS_ESPERADOS } from "./utils/verCustomFields.js";
import { createContact, resolverCampos } from "./services/createContact.js";
import { sendMessage } from "./services/sendMessage.js";
import { fillTemplate } from "./services/messageTemplate.js";
import { parsearLead } from "./utils/parser.js";
import {
    inicializarProperties,
    cargarProperties,
    getPropertiesCache,
    listarProperties,
    resolverPropiedadYUnidad,
    construirAddressCompleta
} from "./services/properties.js";
import { registrarEnZionSeguro } from "./services/zionSheet.js";
import { sincronizarDireccion, extraerContactId } from "./services/syncAddress.js";
import { marcarPago } from "./services/marcarPago.js";
import { marcarProcesado, nombresProcesado, faltantesProcesado } from "./services/marcarProcesado.js";
import { marcarPendienteProcesar, marcarIntento } from "./services/marcarNotas.js";

// Para __dirname en ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// La versión sale de package.json para que no se desincronice
const { version: VERSION } = createRequire(import.meta.url)("./package.json");

const app = express();
app.use(json({ limit: "1mb" }));

// ============================================================
// SEGURIDAD
// ============================================================

/**
 * CORS restringido. Sin ALLOWED_ORIGINS definido se permite todo, que es
 * lo cómodo para desarrollo local; en Render conviene fijarlo.
 */
const ORIGENES = (process.env.ALLOWED_ORIGINS || "")
    .split(",").map(o => o.trim()).filter(Boolean);

app.use(cors(ORIGENES.length ? { origin: ORIGENES } : {}));

/**
 * Clave compartida para los endpoints que escriben.
 *
 * Sin esto, cualquiera que descubra la URL de Render puede mandar
 * POST /api/contacts/batch con 100 leads y disparar 100 SMS desde tu número.
 * El front la manda en el header X-API-Key.
 *
 * Si API_KEY no está definida, no se exige nada (modo local).
 */
const API_KEY = process.env.API_KEY || "";

function requiereApiKey(req, res, next) {
    if (!API_KEY) return next();
    if (req.get("X-API-Key") === API_KEY) return next();
    return res.status(401).json({ error: "No autorizado" });
}

/**
 * Secreto del webhook. Se acepta en la URL o en el header x-api-key
 * (ver webhookAutorizado más abajo).
 */
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";

// Solo se sirve la carpeta public/. Servir __dirname exponía por HTTP
// AGENTS.md, api.http, package.json y la llave de la service account.
app.use(serveStatic(join(__dirname, "public")));

const token = process.env.TOKEN_GHL;
const locationId = process.env.LOCATION_ID;

let cachedCustomFields = null;

// ============================================================
// INICIALIZACIÓN
// ============================================================
async function inicializarCustomFields() {
    console.log("🔍 Obteniendo custom fields de GHL...");
    const todos = await obtenerCustomFieldsDesdeGHL();
    cachedCustomFields = verCustomFields(todos);

    const faltan = camposFaltantes(cachedCustomFields);
    if (faltan.length) {
        console.warn(`⚠️ No existen en GHL con ese nombre exacto: ${faltan.join(", ")}`);
    }
}

/**
 * Recarga los custom fields si alguno de los que hacen falta no esta en la
 * cache.
 *
 * Por que: la cache se llena UNA vez al arrancar. Si creas un campo nuevo en
 * GHL, el servidor no se entera hasta el proximo deploy, y el webhook lo lee
 * vacio sin quejarse. Esto lo detecta y recarga solo, una sola vez.
 *
 * @returns {string[]} los que siguen faltando despues de recargar
 */
async function asegurarCustomFields(nombres) {
    if (!camposFaltantes(cachedCustomFields, nombres).length) return [];

    console.log("🔄 Faltan custom fields en la caché; recargando desde GHL...");
    try {
        cachedCustomFields = verCustomFields(await obtenerCustomFieldsDesdeGHL());
    } catch (err) {
        console.warn("⚠️ No se pudieron recargar los custom fields:", err.message);
    }
    return camposFaltantes(cachedCustomFields, nombres);
}

async function obtenerCustomFieldsDesdeGHL() {
    const res = await axios.get(
        `https://services.leadconnectorhq.com/locations/${locationId}/customFields/`,
        { headers: ghlHeaders() }
    );
    return res.data.customFields;
}

// ============================================================
// ENDPOINTS API
// ============================================================

// Health check.
// Se expone también en /health porque es la ruta que suelen usar los
// pings de "mantener despierto" (GHL, cron-job.org, UptimeRobot).
function health(req, res) {
    res.json({
        status: "ok",
        version: VERSION,
        customFieldsLoaded: cachedCustomFields !== null,
        properties: getPropertiesCache()
    });
}

app.get("/api/health", health);
app.get("/health", health);

/**
 * Webhook para recalcular dirección + link de WhatsApp de un contacto existente.
 *
 * Se dispara desde un Workflow de GHL cuando cambia el Unit Number.
 * Responde 200 siempre: si devuelves error, GHL reintenta en loop.
 */
/**
 * Acepta el secreto de dos formas, porque GHL permite ambas:
 *   1. En la URL:     /webhook/sync-address/<WEBHOOK_SECRET>
 *   2. En un header:  x-api-key: <WEBHOOK_SECRET>   (o el API_KEY)
 *
 * Basta con que UNA coincida.
 */
function webhookAutorizado(req) {
    if (!WEBHOOK_SECRET) return true;              // sin secreto configurado, abierto

    if (req.params.secreto === WEBHOOK_SECRET) return true;

    const header = req.get("X-API-Key");
    if (header && (header === WEBHOOK_SECRET || (API_KEY && header === API_KEY))) return true;

    return false;
}

async function manejarSyncAddress(req, res) {
    // Express 5 ya no admite parámetros opcionales (":secreto?"), así que
    // se registran dos rutas contra el mismo manejador.
    if (!webhookAutorizado(req)) {
        console.warn("⚠️ sync-address rechazado: secreto incorrecto o ausente");
        return res.status(404).json({ error: "No encontrado" });
    }

    const contactId = extraerContactId(req.body);

    if (!contactId) {
        console.warn("⚠️ sync-address sin contact id. Body:", JSON.stringify(req.body));
        return res.status(200).json({ success: false, error: "Falta contact id" });
    }

    try {
        if (!cachedCustomFields) {
            return res.status(200).json({ success: false, error: "Custom fields no cargados" });
        }
        const resultado = await sincronizarDireccion(contactId, cachedCustomFields);
        res.status(200).json({ success: true, contactId, ...resultado });
    } catch (error) {
        const detalle = error.response?.data || { message: error.message };
        console.error(`❌ sync-address falló para ${contactId}:`, JSON.stringify(detalle));
        res.status(200).json({ success: false, contactId, error: detalle });
    }
}

/**
 * Marca installed / paid me / agent paid en el tracker cuando el contacto
 * recibe el tag "paid" en GHL.
 *
 * Con ?dryRun=true busca y decide pero NO escribe ni etiqueta: sirve para
 * validar contra la hoja real, con datos reales, sin riesgo.
 */
async function manejarMarcarPago(req, res) {
    if (!webhookAutorizado(req)) {
        return res.status(401).json({ success: false, error: "No autorizado" });
    }

    const contactId = extraerContactId(req.body);
    if (!contactId) {
        return res.status(400).json({ success: false, error: "No vino contactId en el payload" });
    }

    const dryRun = req.query.dryRun === "true";

    try {
        const resultado = await marcarPago({ contactId, dryRun });
        res.json({ success: true, ...resultado });
    } catch (error) {
        console.error("❌ marcar-pago:", error.response?.data || error.message);
        res.status(500).json({
            success: false,
            contactId,
            error: error.response?.data?.message || error.message
        });
    }
}

/**
 * Escribe en el tracker los datos de la venta (property type, install date,
 * internet/electricity sold, provider, speed) cuando el contacto recibe el
 * tag "procesado", y mueve la fila al mes de instalacion si hace falta.
 */
async function manejarMarcarProcesado(req, res) {
    if (!webhookAutorizado(req)) {
        return res.status(401).json({ success: false, error: "No autorizado" });
    }

    const contactId = extraerContactId(req.body);
    if (!contactId) {
        return res.status(400).json({ success: false, error: "No vino contactId en el payload" });
    }

    await asegurarCustomFields(nombresProcesado());
    const faltan = faltantesProcesado(cachedCustomFields);
    if (faltan.length) {
        return res.status(503).json({
            success: false,
            error: `Estos custom fields no existen en GHL con ese nombre exacto: ${faltan.join(", ")}`
        });
    }

    try {
        const resultado = await marcarProcesado({
            contactId,
            customFields: cachedCustomFields,
            dryRun: req.query.dryRun === "true"
        });
        res.json({ success: true, ...resultado });
    } catch (error) {
        console.error("❌ marcar-procesado:", error.response?.data || error.message);
        res.status(500).json({
            success: false, contactId,
            error: error.response?.data?.message || error.message
        });
    }
}

app.post("/webhook/marcar-procesado", manejarMarcarProcesado);
app.post("/webhook/marcar-procesado/:secreto", manejarMarcarProcesado);

app.post("/webhook/marcar-pago", manejarMarcarPago);
app.post("/webhook/marcar-pago/:secreto", manejarMarcarPago);

/**
 * Tag "pendiente_procesar" -> agrega "pend call" en notes, para que el
 * reporte de pendientes por procesar lo recoja y el jefe llame al cliente.
 */
async function manejarPendienteProcesar(req, res) {
    if (!webhookAutorizado(req)) {
        return res.status(401).json({ success: false, error: "No autorizado" });
    }

    const contactId = extraerContactId(req.body);
    if (!contactId) {
        return res.status(400).json({ success: false, error: "No vino contactId en el payload" });
    }

    try {
        const resultado = await marcarPendienteProcesar({ contactId, dryRun: req.query.dryRun === "true" });
        res.json({ success: true, ...resultado });
    } catch (error) {
        console.error("❌ pendiente-procesar:", error.response?.data || error.message);
        res.status(500).json({
            success: false, contactId,
            error: error.response?.data?.message || error.message
        });
    }
}

/**
 * Tags "intento1/2/3" -> escribe F1/F2/F3 en notes (reemplaza, no acumula),
 * según el intento más alto que tenga el contacto en ese momento.
 */
async function manejarMarcarIntento(req, res) {
    if (!webhookAutorizado(req)) {
        return res.status(401).json({ success: false, error: "No autorizado" });
    }

    const contactId = extraerContactId(req.body);
    if (!contactId) {
        return res.status(400).json({ success: false, error: "No vino contactId en el payload" });
    }

    try {
        const resultado = await marcarIntento({ contactId, dryRun: req.query.dryRun === "true" });
        res.json({ success: true, ...resultado });
    } catch (error) {
        console.error("❌ marcar-intento:", error.response?.data || error.message);
        res.status(500).json({
            success: false, contactId,
            error: error.response?.data?.message || error.message
        });
    }
}

app.post("/webhook/pendiente-procesar", manejarPendienteProcesar);
app.post("/webhook/pendiente-procesar/:secreto", manejarPendienteProcesar);

app.post("/webhook/marcar-intento", manejarMarcarIntento);
app.post("/webhook/marcar-intento/:secreto", manejarMarcarIntento);

app.post("/webhook/sync-address", manejarSyncAddress);
app.post("/webhook/sync-address/:secreto", manejarSyncAddress);

/**
 * Catálogo de propiedades para el <select> del front.
 *
 * Antes el desplegable se llenaba con el picklist del custom field de GHL,
 * pero la dirección se busca en la hoja Properties. Si un nombre estaba
 * escrito distinto en los dos lados, el contacto se creaba sin dirección
 * y sin link de WhatsApp, en silencio. Ahora ambos leen de la hoja.
 */
app.get("/api/properties", (req, res) => {
    const cache = getPropertiesCache();
    res.json({
        ...cache,
        properties: listarProperties().map(p => ({
            name: p.name,
            address: p.address,
            city: p.city,
            state: p.state,
            zip: p.zip,
            electricity: p.electricity
        }))
    });
});

// Recargar el catálogo de Properties sin reiniciar el servidor
app.post("/api/properties/reload", requiereApiKey, async (req, res) => {
    try {
        await cargarProperties();
        res.json({ success: true, ...getPropertiesCache() });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Ver custom fields (para que el HTML cargue el select)
app.get("/api/custom-fields", (req, res) => {
    if (!cachedCustomFields) {
        return res.status(503).json({ error: "Custom fields no cargados aún" });
    }
    res.json(cachedCustomFields);
});

// Verificar si contacto existe (anti-duplicados)
app.get("/api/contacts/check", async (req, res) => {
    try {
        const { phone } = req.query;
        if (!phone) {
            return res.status(400).json({ error: "Falta parámetro phone" });
        }

        const phoneFormateado = aE164(phone);

        const response = await axios.get(
            `https://services.leadconnectorhq.com/contacts/`,
            {
                headers: ghlHeaders(),
                params: {
                    locationId,
                    phone: phoneFormateado
                }
            }
        );

        const contactos = response.data.contacts || [];
        res.json({
            exists: contactos.length > 0,
            contacts: contactos.map(c => ({
                id: c.id,
                name: `${c.firstName} ${c.lastName}`,
                phone: c.phone
            }))
        });

    } catch (error) {
        res.status(500).json({
            error: error.response?.data?.message || error.message
        });
    }
});

// Crear contacto (JSON con \n explícitos - usado por el HTML)
app.post("/api/contacts", requiereApiKey, async (req, res) => {
    try {
        if (!cachedCustomFields) {
            return res.status(503).json({ error: "Custom fields no cargados" });
        }

        const { raw, source, property, campos } = req.body;

        if (typeof raw !== 'string' || !raw.trim() || !source || !property) {
            return res.status(400).json({
                error: "Faltan campos requeridos: raw (texto), source, property"
            });
        }

        // Se resuelve una sola vez, con las correcciones manuales aplicadas
        const p = resolverCampos({ raw, campos });

        const duplicado = await verificarDuplicado(p.phone);
        if (duplicado) {
            return res.status(409).json({
                success: false,
                error: "duplicate",
                message: "Contacto ya existe con este teléfono"
            });
        }

        const resultado = await createContact(
            { raw, source, property, campos },
            cachedCustomFields
        );
        const contactId = resultado.contact?.id;

        let smsSent = false;
        let smsError = null;
        try {
            const msg = fillTemplate(p, { raw, source, property });
            await sendMessage(contactId, msg);
            smsSent = true;
        } catch (err) {
            smsError = err.message;
        }

        // Llena Customer / Leasing Agent / Phone / Move-in en el tracker.
        // No bloquea: si Sheets falla, el lead ya quedó en GHL.
        const zion = await registrarEnZionSeguro({
            firstName: p.firstName,
            lastName: p.lastName,
            phone: p.phone,
            moveIn: p.moveIn,
            source
        });

        res.status(201).json({
            success: true,
            contactId,
            message: "Contacto creado",
            smsSent,
            smsError,
            address: resultado._address,
            waLink: resultado._waLink,
            zionRow: zion.ok ? `${zion.tab}!${zion.fila}` : null,
            zionTabCreada: zion.ok ? zion.pestanaCreada : false,
            zionError: zion.ok ? null : zion.error
        });

    } catch (error) {
        console.error("Error creando contacto:", error.message);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ============================================================
// PARSE ENDPOINT (delega parseo al servidor)
// ============================================================

app.post("/api/contacts/parse", (req, res) => {
    try {
        const { text, source, property } = req.body;

        if (!text) {
            return res.status(400).json({ error: "Falta campo 'text'" });
        }

        const bloques = text.split(/\n\s*\n/).map(b => b.trim()).filter(b => b);

        if (bloques.length === 0) {
            return res.status(400).json({ error: "No se encontraron bloques de texto" });
        }

        const leads = bloques.map((bloque, index) => {
            const parseado = parsearLead(bloque);

            // Se resuelve la torre YA en el preview, no al enviar: asi ves en
            // pantalla a que edificio va a parar el lead antes de que salga
            // el SMS, no despues.
            const r = resolverPropiedadYUnidad(property || "", parseado.unit);
            const direccion = r.propiedad
                ? construirAddressCompleta(r.propiedad, r.unidad)
                : "";

            if (!parseado.firstName || !parseado.phone) {
                return {
                    index,
                    raw: bloque,
                    firstName: parseado.firstName,
                    lastName: parseado.lastName,
                    phone: parseado.phone,
                    unit: parseado.unit,
                    moveIn: parseado.moveIn,
                    email: parseado.email,
                    source: source || '',
                    property: property || '',
                    torre: r.torre,
                    avisoTorre: r.aviso,
                    direccion,
                    error: `No se pudo extraer nombre o teléfono del bloque ${index + 1}`
                };
            }

            return {
                index,
                raw: bloque,
                firstName: parseado.firstName,
                lastName: parseado.lastName,
                phone: parseado.phone,
                unit: parseado.unit,
                moveIn: parseado.moveIn,
                email: parseado.email,
                source: source || '',
                property: property || '',
                torre: r.torre,
                avisoTorre: r.aviso,
                direccion,
                error: null
            };
        });

        res.json({ leads });

    } catch (error) {
        console.error("Error en parse:", error.message);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// BATCH ENDPOINT
// ============================================================

app.post("/api/contacts/batch", requiereApiKey, async (req, res) => {
    try {
        if (!cachedCustomFields) {
            return res.status(503).json({ error: "Custom fields no cargados" });
        }

        const { leads } = req.body;

        if (!Array.isArray(leads) || leads.length === 0) {
            return res.status(400).json({
                error: "Se requiere un array 'leads' con al menos un elemento"
            });
        }

        if (leads.length > 100) {
            return res.status(400).json({
                error: "Máximo 100 leads por batch"
            });
        }

        const results = {
            created: [],
            duplicates: [],
            errors: []
        };

        const BATCH_SIZE = 5;
        const DELAY_MS = 300;

        async function procesarLead(lead, index) {
            const { raw, source, property, campos } = lead;
            if (typeof raw !== 'string' || !raw.trim() || !source || !property) {
                results.errors.push({
                    index,
                    name: '(lead inválido)',
                    error: 'Faltan campos: raw (texto), source, property'
                });
                return;
            }

            // Se resuelve UNA vez, con las correcciones manuales aplicadas,
            // y se reusa. Antes se re-parseaba en cada paso y las ediciones
            // de la preview se perdían.
            let p;
            try {
                p = resolverCampos({ raw, campos });
            } catch (err) {
                results.errors.push({ index, name: '(ilegible)', error: err.message });
                return;
            }

            const nombreLead = `${p.firstName || ''} ${p.lastName || ''}`.trim() || '(desconocido)';

            try {
                const duplicado = await verificarDuplicado(p.phone);
                if (duplicado) {
                    results.duplicates.push({
                        index,
                        name: nombreLead,
                        phone: p.phone
                    });
                    return;
                }

                const resultado = await createContact(
                    { raw, source, property, campos },
                    cachedCustomFields
                );
                const contactId = resultado.contact?.id;

                let smsSent = false;
                let smsError = null;
                try {
                    const msg = fillTemplate(p, { raw, source, property });
                    await sendMessage(contactId, msg);
                    smsSent = true;
                } catch (err) {
                    smsError = err.message;
                }

                const zion = await registrarEnZionSeguro({
                    firstName: p.firstName,
                    lastName: p.lastName,
                    phone: p.phone,
                    moveIn: p.moveIn,
                    source
                });

                results.created.push({
                    index,
                    name: nombreLead,
                    phone: p.phone,
                    contactId,
                    smsSent,
                    smsError,
                    address: resultado._address,
                    waLink: resultado._waLink,
                    zionRow: zion.ok ? `${zion.tab}!${zion.fila}` : null,
                    zionTabCreada: zion.ok ? zion.pestanaCreada : false,
                    zionError: zion.ok ? null : zion.error
                });

            } catch (error) {
                results.errors.push({
                    index,
                    name: nombreLead,
                    phone: p.phone,
                    error: error.message
                });
            }
        }

        for (let i = 0; i < leads.length; i += BATCH_SIZE) {
            const batch = leads.slice(i, i + BATCH_SIZE);
            await Promise.allSettled(
                batch.map((lead, idx) => procesarLead(lead, i + idx))
            );
            if (i + BATCH_SIZE < leads.length) {
                await new Promise(r => setTimeout(r, DELAY_MS));
            }
        }

        res.json({
            success: true,
            results,
            summary: {
                total: leads.length,
                created: results.created.length,
                duplicates: results.duplicates.length,
                errors: results.errors.length
            }
        });

    } catch (error) {
        console.error("Error en batch:", error.message);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ============================================================
// HELPERS
// ============================================================

/**
 * Normaliza a E.164. Solo antepone +1 cuando el número REALMENTE parece de
 * US (10 dígitos, u 11 empezando en 1). Antes, un número colombiano de 12
 * dígitos se convertía en "+1573..." → la búsqueda no encontraba nada → el
 * contacto se duplicaba y se le mandaba otro SMS en cada reenvío.
 */
export function aE164(phone) {
    const crudo = String(phone || "").trim();
    if (!crudo) return "";
    if (crudo.startsWith("+")) return `+${crudo.replace(/\D/g, "")}`;

    const d = crudo.replace(/\D/g, "");
    if (!d) return "";
    if (d.length === 10) return `+1${d}`;
    if (d.length === 11 && d.startsWith("1")) return `+${d}`;
    return `+${d}`;   // ya trae código de país
}

async function verificarDuplicado(phone) {
    const phoneFormateado = aE164(phone);
    if (!phoneFormateado) return false;

    try {
        const checkRes = await axios.get(
            `https://services.leadconnectorhq.com/contacts/`,
            {
                headers: ghlHeaders(),
                params: { locationId, phone: phoneFormateado }
            }
        );
        return (checkRes.data.contacts || []).length > 0;
    } catch (err) {
        const status = err.response?.status;
        if (status === 401 || status === 403) {
            console.warn("⚠️ verificarDuplicado: sin permiso contacts.readonly. Se omite el check.");
        } else {
            // Un 429/500 no significa "no existe". Se avisa para que el
            // duplicado que se cree después tenga una explicación en el log.
            console.warn(`⚠️ verificarDuplicado falló (${status || err.message}). Se asume que no existe.`);
        }
        return false;
    }
}

function ghlHeaders() {
    return {
        Authorization: `Bearer ${token}`,
        Version: "2023-02-21"
    };
}

// ============================================================
// ARRANCAR SERVIDOR
// ============================================================
// El arranque NO debe morir si GHL o Google fallan momentáneamente.
// Antes, un 429 de GHL durante un deploy tumbaba el proceso antes del
// listen y Render marcaba el deploy como fallido.
try {
    await inicializarCustomFields();
} catch (err) {
    console.warn("⚠️ No se pudieron cargar los custom fields:", err.message);
    console.warn("   El servidor arranca igual; /api/custom-fields responderá 503.");
}
await inicializarProperties();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    if (!API_KEY) console.warn("⚠️ API_KEY sin definir: los endpoints de escritura están abiertos.");
    if (!WEBHOOK_SECRET) console.warn("⚠️ WEBHOOK_SECRET sin definir: /webhook/sync-address está abierto.");
});
