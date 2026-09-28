import axios from "axios";
import {
    resolverPropiedadYUnidad,
    propertyDesdeSource,
    construirAddress1,
    construirAddressCompleta
} from "./properties.js";
import { construirWhatsAppLink } from "./whatsappLink.js";

/**
 * Recalcula dirección y link de WhatsApp de un contacto YA EXISTENTE.
 *
 * Para qué: cuando el Leasing Agent no manda el apartamento, el contacto se
 * crea sin unit. Después tú le preguntas al lead y escribes el unit en GHL.
 * En ese momento este servicio vuelve a armar address1 y el wa.me con el
 * dato nuevo, sin que tengas que tocar nada más.
 *
 * Se dispara desde un Workflow de GHL:
 *   Trigger: Contact Field Change → Unit Number
 *   Action:  Webhook POST → https://tu-app.onrender.com/webhook/sync-address
 */

const GHL_BASE = "https://services.leadconnectorhq.com";

function headers() {
    return {
        Authorization: `Bearer ${process.env.TOKEN_GHL}`,
        "Content-Type": "application/json",
        Version: "2023-02-21"
    };
}

/** El payload del webhook de GHL trae el id con distintos nombres según el trigger. */
export function extraerContactId(body = {}) {
    return (
        body.contact_id ||
        body.contactId ||
        body.id ||
        body.contact?.id ||
        null
    );
}

async function getContacto(contactId) {
    const { data } = await axios.get(`${GHL_BASE}/contacts/${contactId}`, { headers: headers() });
    return data.contact || data;
}

/** Saca el valor de un custom field del contacto, buscando por id o por key. */
export function valorCustomField(contacto, definicion) {
    if (!definicion) return "";
    const lista = contacto.customFields || contacto.customField || [];
    const encontrado = lista.find(
        f => f.id === definicion.id || f.key === definicion.fieldKey || f.fieldKey === definicion.fieldKey
    );
    if (!encontrado) return "";
    const v = encontrado.value ?? encontrado.fieldValue ?? encontrado.field_value ?? "";
    return String(v).trim();
}

/**
 * @param {string} contactId
 * @param {Object} customFields - el cache de verCustomFields()
 * @returns {Object} { actualizado:boolean, motivo?:string, address1, waLink }
 */
export async function sincronizarDireccion(contactId, customFields) {
    const contacto = await getContacto(contactId);

    const unit = valorCustomField(contacto, customFields['Unit Number']);
    const moveIn = valorCustomField(contacto, customFields['Move In Date']);
    const propertyName =
        valorCustomField(contacto, customFields['Property Name']) ||
        propertyDesdeSource(contacto.source);

    // Misma resolucion de torre que al crear el contacto: si mas tarde le
    // pones la unidad "3456-S" a mano en GHL, el webhook mueve la direccion
    // a la torre correcta solo.
    const { propiedad, unidad, aviso } = resolverPropiedadYUnidad(propertyName, unit);
    if (!propiedad) {
        return { actualizado: false, motivo: `Propiedad no encontrada: "${propertyName}"` };
    }
    if (aviso) console.warn(`⚠️ ${aviso}`);

    const address1 = construirAddress1(propiedad, unidad);
    const addressCompleta = construirAddressCompleta(propiedad, unidad);

    // La ficha se rearma con lo que GHL tenga AHORA: por eso el workflow
    // "Link WhatsApp" dispara tanto cuando cambia la unidad como el email.
    // Telefono y source se copian tal cual vienen de GHL, sin reformatear.
    const waLink = construirWhatsAppLink({
        nombre: `${contacto.firstName || ""} ${contacto.lastName || ""}`.trim(),
        email: contacto.email,
        phone: contacto.phone,
        source: contacto.source,
        direccion: construirAddressCompleta(propiedad, ""),
        unidad: unit,
        moveIn
    });

    // Si ya está igual, no gastamos una llamada a la API.
    const igual =
        (contacto.address1 || "") === address1 &&
        (contacto.website || "") === waLink;

    if (igual) {
        return { actualizado: false, motivo: "Sin cambios", address1, waLink };
    }

    const payload = { address1, country: "US" };
    if (propiedad.city) payload.city = propiedad.city;
    if (propiedad.state) payload.state = propiedad.state;
    if (propiedad.zip) payload.postalCode = propiedad.zip;
    if (waLink) payload.website = waLink;

    await axios.put(`${GHL_BASE}/contacts/${contactId}`, payload, { headers: headers() });

    console.log(`🔄 Dirección sincronizada para ${contactId}: ${address1}`);
    return { actualizado: true, address1, waLink };
}
