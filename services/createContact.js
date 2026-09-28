import axios from "axios";
import { parsearLead } from "../utils/parser.js";
import {
    propertyDesdeSource,
    resolverPropiedadYUnidad,
    construirAddress1,
    construirAddressCompleta
} from "./properties.js";
import { construirWhatsAppLink } from "./whatsappLink.js";

const CONFIG = {
    get TOKEN() { return process.env.TOKEN_GHL; },
    get LOCATION_ID() { return process.env.LOCATION_ID; },
    YEAR: 2026
};

/**
 * Aplica sobre el parseo automático las correcciones que el usuario hizo
 * a mano en la tabla de preview.
 *
 * Antes esas ediciones se perdían: el front las guardaba pero mandaba solo
 * `raw`, y el servidor volvía a parsear desde cero. Si corregías un teléfono
 * mal leído, GHL guardaba igual el equivocado y el SMS salía a ese número.
 */
export function resolverCampos(lead) {
    const auto = parsearLead(lead.raw);
    const manual = lead.campos || {};

    const usar = (clave) => {
        const v = manual[clave];
        return typeof v === "string" && v.trim() ? v.trim() : auto[clave];
    };

    return {
        firstName: usar("firstName"),
        lastName: usar("lastName"),
        phone: usar("phone"),
        unit: usar("unit"),
        moveIn: usar("moveIn"),
        email: usar("email")
    };
}

/**
 * Crea un contacto en GHL.
 *
 * @param {Object} lead - { raw, source, property, campos? }
 *   raw: string con el texto desestructurado
 *   source: string, quién envió el lead (ej: "Anju@The Maxwell")
 *   property: string, nombre de la propiedad (ej: "The Maxwell")
 *   campos: correcciones manuales de la preview; ganan sobre el parseo
 *
 * @param {Object} customFields - Objeto devuelto por verCustomFields()
 *
 * @returns {Object} - { ...respuesta de GHL, _parseado, _address, _waLink }
 */
export async function createContact(lead, customFields) {

    // ─── PASO 1: Extraer IDs y keys de custom fields ───
    const cf = {
        propertyName: customFields['Property Name'],
        unitNumber: customFields['Unit Number'],
        moveInDate: customFields['Move In Date']
    };

    if (!cf.propertyName || !cf.unitNumber || !cf.moveInDate) {
        throw new Error("Faltan IDs de custom fields. Verifica que existan en GHL.");
    }

    // ─── PASO 2: Resolver campos (parseo + correcciones manuales) ───
    const parseado = resolverCampos(lead);

    if (!parseado.firstName || !parseado.phone) {
        throw new Error("No se pudo parsear: falta nombre o teléfono.");
    }

    // Solo el nombre en el log: el teléfono y la dirección son datos del
    // cliente y los logs de Render no son efímeros.
    console.log(`🔍 Lead resuelto: ${parseado.firstName} ${parseado.lastName}`.trim());

    // ─── PASO 3: Custom fields para GHL ───
    // OJO: Unit Number se queda con el número pelado (ej. "4308").
    // El webhook de process_order → SSRE lee este campo. No lo contamines
    // con la dirección completa o rompes esa automatización.
    const customFieldsArray = [];

    if (parseado.moveIn) {
        customFieldsArray.push({
            id: cf.moveInDate.id,
            key: cf.moveInDate.fieldKey,
            field_value: parseado.moveIn
        });
    }

    if (lead.property) {
        customFieldsArray.push({
            id: cf.propertyName.id,
            key: cf.propertyName.fieldKey,
            field_value: lead.property
        });
    }

    if (parseado.unit) {
        customFieldsArray.push({
            id: cf.unitNumber.id,
            key: cf.unitNumber.fieldKey,
            field_value: parseado.unit
        });
    }

    // ─── PASO 4: Dirección desde la hoja Properties ───
    // El nombre de la propiedad viene del selector; si no, se saca del
    // source con formato "Agente@Propiedad".
    const nombreProperty = lead.property || propertyDesdeSource(lead.source);

    // La unidad puede traer la torre pegada ("3456-S"). resolverPropiedadYUnidad
    // la usa para elegir el edificio correcto y devuelve la unidad ya limpia.
    // El "3456-S" completo se guarda igual en el custom field Unit Number.
    const { propiedad, unidad, torre, aviso } = resolverPropiedadYUnidad(nombreProperty, parseado.unit);

    if (!propiedad) {
        console.warn(`⚠️ Propiedad no encontrada en Properties: "${nombreProperty}". El contacto se crea sin dirección.`);
    }
    if (aviso) console.warn(`⚠️ ${aviso}`);

    const address1 = construirAddress1(propiedad, unidad);            // "14155 Dallas Pkwy #3456"
    const addressCompleta = construirAddressCompleta(propiedad, unidad); // "... , Dallas, TX 75254"

    // ─── PASO 5: Ficha para el jefe, lista para un tap ───
    // El campo `website` guarda un wa.me hacia el WhatsApp del jefe con los
    // datos del cliente ya escritos. La direccion va SIN la unidad porque la
    // unidad tiene su propia linea en la ficha.
    const direccionFicha = construirAddressCompleta(propiedad, "");
    const waLink = construirWhatsAppLink({
        nombre: `${parseado.firstName || ""} ${parseado.lastName || ""}`.trim(),
        email: parseado.email,
        phone: parseado.phone,
        source: lead.source,
        direccion: direccionFicha,
        unidad: parseado.unit,
        moveIn: parseado.moveIn
    });

    // ─── PASO 6: Tags ───
    const tags = ['New Lead'];

    // ─── PASO 7: Payload final ───
    const nombreCompleto = `${parseado.firstName} ${parseado.lastName}`.trim();
    const payload = {
        locationId: CONFIG.LOCATION_ID,
        firstName: parseado.firstName,
        lastName: parseado.lastName,
        name: nombreCompleto,
        phone: parseado.phone,
        source: lead.source,
        tags: tags,
        customFields: customFieldsArray
    };

    if (parseado.email) payload.email = parseado.email;

    // Campos nativos de GHL (Contact Details → General Info)
    if (address1) payload.address1 = address1;
    if (propiedad?.city) payload.city = propiedad.city;
    if (propiedad?.state) payload.state = propiedad.state;
    if (propiedad?.zip) payload.postalCode = propiedad.zip;
    if (address1) payload.country = "US";

    // `website` se renderiza como link clickeable en Contact Details.
    // Ahí guardamos el wa.me: un tap y WhatsApp abre con el mensaje escrito.
    if (waLink) payload.website = waLink;

    // No logueamos el payload completo: lleva nombre, teléfono y dirección.
    console.log(`📦 Enviando a GHL: ${nombreCompleto} @ ${nombreProperty || "(sin propiedad)"}`);

    // ─── PASO 8: Enviar a GHL ───
    try {
        const response = await axios.post(
            'https://services.leadconnectorhq.com/contacts/',
            payload,
            {
                headers: {
                    'Authorization': `Bearer ${CONFIG.TOKEN}`,
                    'Content-Type': 'application/json',
                    'Version': '2023-02-21'
                }
            }
        );

        console.log("✅ Contacto creado! ID:", response.data.contact?.id);

        return {
            ...response.data,
            _parseado: parseado,
            _address: addressCompleta,
            _waLink: waLink
        };

    } catch (error) {
        const detalle = error.response?.data || { message: error.message };
        console.error("❌ Error de GHL:", JSON.stringify(detalle, null, 2));
        throw new Error(`GHL Error ${error.response?.status}: ${JSON.stringify(detalle)}`);
    }
}
