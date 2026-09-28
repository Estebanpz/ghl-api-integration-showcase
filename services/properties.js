import { resolverTorre } from "./torres.js";
import { google } from "googleapis";
import { propiedadesUnicas } from "./propertiesFallback.js";

/**
 * Catálogo de propiedades leído de la hoja "Properties / Prospects" de Drive.
 *
 * Diseño:
 *  - Se lee UNA vez al arrancar y se cachea en memoria.
 *  - Si Drive falla, el servidor arranca igual y la dirección queda vacía.
 *  - La app SOLO LEE esta hoja. Nunca escribe sobre ella.
 *
 * Env:
 *  - PROPERTIES_SHEET_ID     → id de "Properties / Prospects"
 *  - PROPERTIES_TAB          → nombre de la pestaña (opcional: si no está, la detecta sola)
 *  - GOOGLE_SERVICE_ACCOUNT  → JSON de la service account en una sola línea
 */

const PROPERTIES_SHEET_ID = process.env.PROPERTIES_SHEET_ID || process.env.SHEET_ID;
const PROPERTIES_TAB = process.env.PROPERTIES_TAB || "";

let cache = null;
let cacheAt = null;
let tabUsada = null;
let fuente = null;      // "sheets" | "fallback"

/**
 * Pestañas a fusionar. La primera que exista manda en caso de conflicto,
 * pero los campos vacíos se completan con las siguientes.
 */
const TABS = (process.env.PROPERTIES_TABS || "Properties,Sara+ properties")
    .split(",").map(t => t.trim()).filter(Boolean);

// ------------------------------------------------------------------
// Auth (compartida con leadsSheet.js)
// ------------------------------------------------------------------
/**
 * Lee la credencial de la service account, tolerando cómo se pega en cada sitio.
 *
 * En el archivo .env el JSON va entre comillas simples y dotenv las quita.
 * En el panel de Render NO se ponen comillas: se guarda el texto literal. Si
 * se pegan igual, el valor queda envuelto en comillas y JSON.parse falla con
 * un "Unexpected token" que no dice nada sobre la causa real.
 *
 * Aquí se quitan las comillas envolventes y, si algo sigue mal, el error
 * explica qué revisar.
 */
export function leerCredenciales() {
    let raw = process.env.GOOGLE_SERVICE_ACCOUNT;
    if (!raw) throw new Error("Falta GOOGLE_SERVICE_ACCOUNT en el entorno");

    raw = raw.trim();

    const primera = raw[0];
    const ultima = raw[raw.length - 1];
    if ((primera === "'" && ultima === "'") || (primera === '"' && ultima === '"')) {
        raw = raw.slice(1, -1).trim();
        console.warn("⚠️ GOOGLE_SERVICE_ACCOUNT traía comillas envolventes; se quitaron. " +
                     "En el panel de Render pega el JSON SIN comillas.");
    }

    let credenciales;
    try {
        credenciales = JSON.parse(raw);
    } catch (err) {
        throw new Error(
            `GOOGLE_SERVICE_ACCOUNT no es JSON válido (${err.message}). ` +
            `Empieza con ${JSON.stringify(raw.slice(0, 22))}. ` +
            `Debe empezar con {"type":"service_account", en UNA sola línea y sin comillas envolventes.`
        );
    }

    if (!credenciales.client_email || !credenciales.private_key) {
        throw new Error("GOOGLE_SERVICE_ACCOUNT no trae client_email o private_key");
    }

    // Algunos paneles escapan los saltos de línea de la llave privada
    if (credenciales.private_key.includes("\\n")) {
        credenciales.private_key = credenciales.private_key.replace(/\\n/g, "\n");
    }

    return credenciales;
}

export function getSheetsClient() {
    const credentials = leerCredenciales();
    const auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ["https://www.googleapis.com/auth/spreadsheets"]
    });

    return google.sheets({ version: "v4", auth });
}

export function normalizar(nombre) {
    return String(nombre || "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** De "Anju@The Maxwell" saca "The Maxwell". Sin @, devuelve el string completo. */
export function propertyDesdeSource(source) {
    const s = String(source || "");
    const i = s.indexOf("@");
    return i === -1 ? s.trim() : s.slice(i + 1).trim();
}

// ------------------------------------------------------------------
// Parseo de la dirección
// ------------------------------------------------------------------

/**
 * La columna ADDRESS viene mezclada:
 *   "7201 Custer Rd, McKinney, TX 75070"  → trae ciudad/estado/zip adentro
 *   "7777 Adelaide St"                    → solo la calle
 *
 * Esta función separa lo que se pueda. Lo que falte lo completan
 * las columnas sueltas de ciudad/zip de la hoja.
 */
export function partirAddress(raw) {
    const texto = String(raw || "").trim().replace(/\.$/, "");
    if (!texto) return { street: "", city: "", state: "", zip: "" };

    // "..., McKinney, TX 75070"  |  "... McKinney TX 75070"
    const m = texto.match(/^(.*?)[,\s]+([A-Za-z .'-]+?)[,\s]+([A-Z]{2})\.?[,\s]+(\d{5})(?:-\d{4})?$/);
    if (m) {
        return {
            street: m[1].trim().replace(/,$/, ""),
            city: m[2].trim(),
            state: m[3].toUpperCase(),
            zip: m[4]
        };
    }

    // Solo calle
    return { street: texto, city: "", state: "", zip: "" };
}

// ------------------------------------------------------------------
// Detección de columnas
// ------------------------------------------------------------------
function mapearColumnas(headerRow) {
    const idx = {};
    headerRow.forEach((h, i) => {
        const k = normalizar(h);
        if (k && !(k in idx)) idx[k] = i;
    });

    const pick = (...opciones) => {
        for (const o of opciones) {
            const k = normalizar(o);
            if (k in idx) return idx[k];
        }
        return -1;
    };

    return {
        // Tu hoja usa "COMPLEX"; otras pestañas usan "Property Name"
        name: pick("complex", "property name", "property", "propiedad", "name"),
        address: pick("address", "street address", "direccion", "dirección"),
        city: pick("city", "ciudad"),
        zip: pick("postal code", "zip", "zipcode", "zip code", "postalcode"),
        electricity: pick("electricity", "electricidad"),
        agent: pick("agent", "agents", "leasing agent")
    };
}

/**
 * Tu hoja tiene columnas de ciudad y zip SIN encabezado, y el orden de las
 * columnas cambia cada tanto. Adivinarlas por posición fija se rompe: cuando
 * ADDRESS pasó de la columna C a la B, "dirección + 2" dejó de apuntar a la
 * ciudad y empezó a apuntar al AGENTE — y The Maxwell quedó con la ciudad
 * "Anju", que es el nombre de la agente.
 *
 * Ahora se detectan por CONTENIDO, mirando solo las columnas que no están ya
 * asignadas a otra cosa:
 *   · zip    → mayoría de valores son exactamente 5 dígitos
 *   · ciudad → texto corto, sin números y sin comas (descarta agentes y URLs)
 */
function detectarPorContenido(col, filas) {
    const datos = filas.slice(1, 40);
    const anchura = Math.max(...filas.map(f => f.length), 0);

    const ocupadas = new Set(
        [col.name, col.address, col.agent, col.electricity].filter(i => i > -1)
    );

    const valores = (c) => datos.map(f => (f[c] || "").trim()).filter(Boolean);

    if (col.zip === -1) {
        let mejor = -1, mejorPuntaje = 0;
        for (let c = 0; c < anchura; c++) {
            if (ocupadas.has(c)) continue;
            const v = valores(c);
            if (v.length < 3) continue;
            const puntaje = v.filter(x => /^\d{5}$/.test(x)).length / v.length;
            if (puntaje > 0.7 && puntaje > mejorPuntaje) { mejorPuntaje = puntaje; mejor = c; }
        }
        if (mejor > -1) { col.zip = mejor; ocupadas.add(mejor); }
    }

    if (col.city === -1) {
        let mejor = -1, mejorPuntaje = 0;
        for (let c = 0; c < anchura; c++) {
            if (ocupadas.has(c)) continue;
            const v = valores(c);
            if (v.length < 3) continue;
            // Nombre de ciudad: letras y espacios, corto, sin comas ni dígitos
            const puntaje = v.filter(x =>
                /^[A-Za-z][A-Za-z .'-]{2,24}$/.test(x) && !x.includes(",")
            ).length / v.length;
            if (puntaje > 0.7 && puntaje > mejorPuntaje) { mejorPuntaje = puntaje; mejor = c; }
        }
        if (mejor > -1) col.city = mejor;
    }

    return col;
}

// ------------------------------------------------------------------
// Lectura de una pestaña
// ------------------------------------------------------------------

/**
 * Algunas pestañas no tienen fila de encabezados — "Sara+ properties"
 * arranca directo con datos (1, Emerson at Ford Park, 301 S Jupiter Rd...).
 *
 * Cuando no hay encabezados, se deduce: se busca la columna donde la mayoría
 * de valores parecen una dirección (empiezan con número), y se asume que el
 * nombre de la propiedad está en la columna inmediatamente a su izquierda.
 */
function deducirColumnas(filas) {
    const muestra = filas.slice(0, 20);
    const anchura = Math.max(...muestra.map(f => f.length), 0);

    let mejorCol = -1, mejorPuntaje = 0;
    for (let c = 0; c < anchura; c++) {
        const puntaje = muestra.filter(f => /^\s*\d+\s+\S/.test(f[c] || "")).length;
        if (puntaje > mejorPuntaje) { mejorPuntaje = puntaje; mejorCol = c; }
    }

    // Al menos un tercio de las filas tiene que parecer dirección
    if (mejorCol < 1 || mejorPuntaje < Math.max(3, muestra.length / 3)) return null;

    return { name: mejorCol - 1, address: mejorCol, city: -1, zip: -1,
             electricity: -1, agent: mejorCol + 2, sinEncabezados: true };
}

async function leerTab(sheets, tab) {
    const res = await sheets.spreadsheets.values.get({
        spreadsheetId: PROPERTIES_SHEET_ID,
        range: `${tab}!A:Z`
    });

    const filas = (res.data.values || []).filter(f => f.some(c => (c || "").trim()));
    if (!filas.length) return [];

    let col = detectarPorContenido(mapearColumnas(filas[0]), filas);
    let datos = filas.slice(1);

    if (col.name === -1 || col.address === -1) {
        col = deducirColumnas(filas);
        if (!col) {
            console.warn(`⚠️ "${tab}": no pude identificar las columnas, se omite`);
            return [];
        }
        datos = filas;              // sin encabezados, la fila 1 ya es dato
    }

    const salida = [];
    for (const fila of datos) {
        const nombre = (fila[col.name] || "").trim();
        const rawAddress = (fila[col.address] || "").trim();
        if (!nombre || !rawAddress) continue;

        const partes = partirAddress(rawAddress);
        const celdaCity = col.city > -1 ? (fila[col.city] || "").trim() : "";
        const celdaZip = col.zip > -1 ? (fila[col.zip] || "").trim() : "";

        salida.push({
            name: nombre,
            address: partes.street,
            city: partes.city || celdaCity,
            state: partes.state || "TX",
            zip: partes.zip || (/^\d{5}$/.test(celdaZip) ? celdaZip : ""),
            electricity: col.electricity > -1 ? (fila[col.electricity] || "").trim() : "",
            agent: col.agent > -1 ? (fila[col.agent] || "").trim() : ""
        });
    }

    console.log(`   · "${tab}": ${salida.length} filas`);
    return salida;
}

// ------------------------------------------------------------------
// Carga y fusión
// ------------------------------------------------------------------

/** Mete un registro en el mapa, completando huecos en vez de pisar. */
function fusionar(mapa, reg) {
    const clave = normalizar(reg.name);
    if (!clave) return;

    const previo = mapa.get(clave);
    if (!previo) { mapa.set(clave, { ...reg }); return; }

    for (const campo of ["address", "city", "zip", "electricity", "agent"]) {
        if (!previo[campo] && reg[campo]) previo[campo] = reg[campo];
    }
}

export async function cargarProperties() {
    if (!PROPERTIES_SHEET_ID) throw new Error("Falta PROPERTIES_SHEET_ID en el entorno");

    const sheets = getSheetsClient();

    const meta = await sheets.spreadsheets.get({
        spreadsheetId: PROPERTIES_SHEET_ID,
        fields: "sheets.properties.title"
    });
    const existentes = meta.data.sheets.map(s => s.properties.title);

    const aLeer = TABS.filter(t => existentes.some(e => normalizar(e) === normalizar(t)))
                      .map(t => existentes.find(e => normalizar(e) === normalizar(t)));

    if (!aLeer.length) {
        throw new Error(
            `Ninguna de las pestañas [${TABS.join(", ")}] existe. Hay: ${existentes.join(", ")}`
        );
    }

    const mapa = new Map();
    for (const tab of aLeer) {
        try {
            for (const reg of await leerTab(sheets, tab)) fusionar(mapa, reg);
        } catch (err) {
            console.warn(`⚠️ Error leyendo "${tab}": ${err.message}`);
        }
    }

    if (!mapa.size) throw new Error("Las pestañas se leyeron pero no salió ninguna propiedad");

    cache = mapa;
    cacheAt = new Date().toISOString();
    tabUsada = aLeer.join(" + ");
    fuente = "sheets";

    console.log(`🏢 Properties: ${mapa.size} propiedades desde ${tabUsada} (${cacheAt})`);
    return mapa;
}

/**
 * Carga el catálogo estático. Es la red de seguridad: si Google no responde
 * o el permiso se cae, la app sigue armando direcciones y links de WhatsApp
 * con datos de la última vez que se generó el archivo.
 */
export function cargarFallback() {
    const mapa = new Map();
    for (const p of propiedadesUnicas()) fusionar(mapa, p);

    cache = mapa;
    cacheAt = new Date().toISOString();
    tabUsada = "propertiesFallback.js";
    fuente = "fallback";

    console.warn(`📦 Usando el catálogo de RESPALDO: ${mapa.size} propiedades (puede estar desactualizado)`);
    return mapa;
}

export async function inicializarProperties() {
    try {
        await cargarProperties();
    } catch (err) {
        console.warn("⚠️ No se pudo leer la hoja de Drive:", err.message);
        try {
            cargarFallback();
        } catch (err2) {
            console.error("❌ El respaldo también falló:", err2.message);
            cache = cache || new Map();
            fuente = "ninguna";
        }
    }
}

export function getPropertiesCache() {
    return {
        cargadas: cache ? cache.size : 0,
        fuente,                       // "sheets" | "fallback" | "ninguna"
        origen: tabUsada,
        actualizado: cacheAt
    };
}

/** Lista plana del catálogo, para alimentar el <select> del front. */
export function listarProperties() {
    if (!cache) return [];
    return [...cache.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Busca una propiedad. Primero exacta; si no, por coincidencia parcial
 * (la hoja escribe "Trails At Creekside" y GHL manda "Trails at Creekside ").
 *
 * Importante: entre varios parciales gana el MÁS LARGO, no el primero de la
 * hoja. Si devolviéramos el primero, "The Villas at Frisco" podría resolver
 * a "The Villas" y el cliente recibiría por WhatsApp la dirección de otra
 * propiedad.
 */
export function buscarProperty(nombre) {
    if (!cache) return null;
    const clave = normalizar(nombre);
    if (!clave) return null;

    const exacta = cache.get(clave);
    if (exacta) return exacta;

    let mejor = null;
    let mejorLargo = -1;

    for (const [k, v] of cache) {
        if (k.includes(clave) || clave.includes(k)) {
            // El candidato más específico es el de nombre más largo
            const largo = Math.min(k.length, clave.length);
            if (largo > mejorLargo) { mejor = v; mejorLargo = largo; }
        }
    }

    if (mejor) {
        console.warn(`⚠️ "${nombre}" no coincide exacto; se usó "${mejor.name}"`);
    }
    return mejor;
}

// ------------------------------------------------------------------
// Construcción de la dirección
// ------------------------------------------------------------------

/** address1 para GHL: "7777 Adelaide St #4308" */
export function construirAddress1(property, unit) {
    if (!property || !property.address) return "";
    const u = String(unit || "").trim().replace(/^#/, "");
    return u ? `${property.address} #${u}` : property.address;
}

/** Una línea para el mensaje: "7777 Adelaide St #4308, Frisco, TX 75034" */
/**
 * Punto UNICO donde se decide que propiedad y que unidad se usan.
 *
 * Lo llaman los dos flujos que arman direcciones (crear contacto y el webhook
 * sync-address). Tenerlo en un solo sitio evita el clasico bug de arreglar
 * una regla en un lado y olvidarla en el otro.
 *
 * @returns {Object} { propiedad, unidad, torre, aviso }
 */
export function resolverPropiedadYUnidad(nombreProperty, unidad) {
    const r = resolverTorre(nombreProperty, unidad);

    let propiedad = buscarProperty(r.nombreProperty);

    // Si la torre resuelta no esta en el catalogo, no se pierde el lead:
    // se cae al nombre original y se avisa.
    if (!propiedad && r.nombreProperty !== nombreProperty) {
        propiedad = buscarProperty(nombreProperty);
        return {
            propiedad,
            unidad: String(unidad || "").trim(),
            torre: "",
            aviso: `No encontré "${r.nombreProperty}" en el catálogo; se usó "${nombreProperty}".`
        };
    }

    return { propiedad, unidad: r.unidad, torre: r.torre, aviso: r.aviso };
}

export function construirAddressCompleta(property, unit) {
    if (!property) return "";
    const linea1 = construirAddress1(property, unit);
    const cityState = [property.city, property.state].filter(Boolean).join(", ");
    const cola = [cityState, property.zip].filter(Boolean).join(" ");
    return [linea1, cola].filter(Boolean).join(", ");
}
