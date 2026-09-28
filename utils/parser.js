/**
 * Los leads traen "M/I 8/10" sin año. Antes el año estaba fijo en 2026:
 * en diciembre, "M/I 1/5" se guardaba como enero de 2026 — siete meses en
 * el pasado. Ahora se infiere: si la fecha ya pasó hace más de un mes,
 * se asume que es del año siguiente.
 */
function inferirAnio(mes, dia) {
    const hoy = new Date();
    const anio = hoy.getFullYear();
    const candidata = new Date(anio, mes - 1, dia);

    const hace30dias = new Date(hoy);
    hace30dias.setDate(hace30dias.getDate() - 30);

    return candidata < hace30dias ? anio + 1 : anio;
}

export function parsearLead(textoCrudo) {
    const texto = textoCrudo.trim().replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // Detectar formato etiquetado: "Name: X, Phone: Y, Unit: Z, Move-In: W"
    if (tieneFormatoEtiquetado(texto)) {
        return parsearFormatoEtiquetado(texto);
    }

    const lineas = texto
        .split('|||')
        .map(l => l.trim())
        .filter(l => l.length > 0);

    const phone = extraerTelefono(texto);
    const unit = extraerUnidad(texto);
    const moveIn = extraerFecha(texto);
    const email = extraerEmail(texto);
    const { firstName, lastName } = extraerNombre(lineas, phone, unit, email);

    return { firstName, lastName, phone, unit, moveIn, email };
}

function tieneFormatoEtiquetado(texto) {
    // Solo considerar formato etiquetado si hay AL MENOS 2 etiquetas, o si la primera línea tiene "Name:"
    const tieneName = /\bName\s*[:]/i.test(texto);
    if (tieneName) return true;

    const etiquetas = texto.match(/\b(?:Phone|Unit|Apt|Move[- ]?[Ii]n|M\/I|Email|Fecha|Mudanza|Lease\s*Date|Check[- ]?[Ii]n)\s*[:]/gi);
    return etiquetas !== null && etiquetas.length >= 2;
}

function parsearFormatoEtiquetado(texto) {
    const extract = (patron) => {
        const match = texto.match(new RegExp(patron, 'i'));
        return match ? match[1].trim() : '';
    };

    const name = extract(/Name\s*:\s*([^,\n|]+)/i);
    const phoneRaw = extraerTelefono(texto);
    const unit = extraerUnidad(texto);
    const moveIn = extraerFecha(texto);
    const email = extraerEmail(texto);

    let firstName = '';
    let lastName = '';

    if (name) {
        const partes = name.split(/\s+/);
        firstName = partes[0] || '';
        lastName = partes.slice(1).join(' ') || '';
    } else if (phoneRaw) {
        // Si no hay Name: label pero hay teléfono, extraer nombre del texto
        const n = extraerNombre(
            texto.split('|||').map(l => l.trim()).filter(l => l),
            phoneRaw, unit, email
        );
        firstName = n.firstName;
        lastName = n.lastName;
    }

    return { firstName, lastName, phone: phoneRaw, unit, moveIn, email };
}

/**
 * Convierte una tira de dígitos a E.164 sin inventar nada.
 *
 * 10 dígitos            → US sin código:      +1XXXXXXXXXX
 * 11 empezando en 1     → US con código:      +1XXXXXXXXXX
 * cualquier otra cosa   → ya trae país:       +XXXXXXXXXXX
 */
function digitosAE164(digitos) {
    if (digitos.length === 10) return '+1' + digitos;
    if (digitos.length === 11 && digitos.startsWith('1')) return '+' + digitos;
    return '+' + digitos;
}

function extraerTelefono(texto) {
    // 1) Numero con codigo de pais explicito: +57 300 123 4567, +1 (214) 684-5278.
    //    Se aceptan parentesis y separadores, pero NO saltos de linea.
    const intl = texto.match(/\+\d{1,3}[ .-]?\(?\d{2,4}\)?[ .-]?\d{3}[ .-]?\d{2,4}(?!\d)/);
    if (intl) {
        return digitosAE164(intl[0].replace(/\D/g, ''));
    }

    // 2) Formato US con o sin parentesis: (214) 684-5278, 972-555-0202, 9725550202.
    //    Los lookarounds evitan morder por la mitad un numero mas largo.
    //
    //    Ojo: aqui NO se puede usar \s como separador ni quitar los separadores
    //    de todo el texto antes de buscar. Ese era el bug: "M/I 8/21" seguido
    //    del telefono quedaba como "M/I8/212146845278" y el numero salia
    //    +212146845278, con el "21" del dia de mudanza pegado adelante.
    const us = texto.match(/(?<!\d)\(?(\d{3})\)?[ .-]?(\d{3})[ .-]?(\d{4})(?!\d)/);
    if (us) {
        return '+1' + us[1] + us[2] + us[3];
    }

    // 3) Tira de digitos pegada, delimitada por no-digitos: "13184178255".
    //    Sin esto, la regla 2 agarraba los primeros 10 digitos de un numero de
    //    11 y producia +11318417825, un numero que no es el del lead.
    const pegado = texto.match(/(?<!\d)\d{10,15}(?!\d)/);
    if (pegado) {
        return digitosAE164(pegado[0]);
    }

    return '';
}

function extraerUnidad(texto) {
    // El sufijo "-N" / "-S" identifica la torre en complejos como Luxia
    // Gallery House. Por eso la unidad es un STRING y no un numero: "3456-S"
    // no se puede guardar como 3456 sin perder de que torre es.
    const patterns = [
        // Con etiqueta y sufijo: "Unit 1344-N", "Apt: 3456 - S"
        /(?:Unit|Apt|Apartment|Suite|Unidad)\s*[:#]?\s*(\d{1,6}\s*-\s*[A-Za-z])(?![\w-])/i,
        // Con almohadilla y sufijo: "#1344-N"
        /#\s*(\d{1,6}\s*-\s*[A-Za-z])(?![\w-])/,
        // Suelto, sin etiqueta ni almohadilla: "3456-S" en su propia linea
        /(?<![\w-])(\d{3,6}\s*-\s*[A-Za-z])(?![\w-])/,
        // Sin sufijo, como siempre
        /#(\d+[A-Za-z]?)/,
        /Unit\s*[:#]?\s*(\d+)/i,
        /Apt\s*[:#]?\s*(\d+)/i,
        /Apartment\s*[:#]?\s*(\d+)/i,
        /Suite\s*[:#]?\s*(\d+)/i,
        /Unidad\s*[:#]?\s*(\d+)/i,
    ];
    for (const pattern of patterns) {
        const match = texto.match(pattern);
        // "3456 - s" -> "3456-S": se guarda siempre igual, venga como venga.
        if (match) return match[1].replace(/\s+/g, '').toUpperCase();
    }
    return '';
}

function extraerFecha(texto) {
    const patterns = [
        /M\/I\s*(\d{1,2})[\/'-](\d{1,2})/i,
        /Move\s*[Ii]n\s*[:#]?\s*(\d{1,2})[\/'-](\d{1,2})/i,
        /Move\s*[-]?\s*[Ii]n\s*[:#]?\s*(\d{1,2})[\/'-](\d{1,2})/i,
        /Lease\s*Date\s*[:#]?\s*(\d{1,2})[\/'-](\d{1,2})/i,
        /Mudanza\s*[:#]?\s*(\d{1,2})[\/'-](\d{1,2})/i,
        /Check\s*[Ii]n\s*[:#]?\s*(\d{1,2})[\/'-](\d{1,2})/i,
    ];
    for (const pattern of patterns) {
        const match = texto.match(pattern);
        if (match) {
            const mes = match[1].padStart(2, '0');
            const dia = match[2].padStart(2, '0');
            return `${mes}-${dia}-${inferirAnio(Number(mes), Number(dia))}`;
        }
    }

    const regexDateOnly = /(?<!\d)(\d{1,2})[\/'-](\d{1,2})(?!\d)/;
    const matchDate = texto.match(regexDateOnly);
    if (matchDate) {
        const mes = matchDate[1].padStart(2, '0');
        const dia = matchDate[2].padStart(2, '0');
        return `${mes}-${dia}-${inferirAnio(Number(mes), Number(dia))}`;
    }

    // Fechas completas YYYY-MM-DD o similares
    const regexFull = /(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})/;
    const matchFull = texto.match(regexFull);
    if (matchFull) {
        const mes = matchFull[2].padStart(2, '0');
        const dia = matchFull[3].padStart(2, '0');
        return `${mes}-${dia}-${matchFull[1]}`;
    }

    return '';
}

function extraerEmail(texto) {
    const match = texto.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    return match ? match[0] : '';
}

function extraerNombre(lineas, phone, unit, email) {
    const rawPhone = phone.replace(/\D/g, '');

    const todasLasLineas = lineas.flatMap(b =>
        b.split('\n').map(l => l.trim()).filter(l => l)
    );

    for (const linea of todasLasLineas) {
        const limpia = linea.trim();

        if (esSoloTelefono(limpia, rawPhone)) continue;
        if (esSoloUnidad(limpia)) continue;
        if (esSoloFecha(limpia)) continue;
        if (esSoloEmail(limpia)) continue;
        if (esSoloNumero(limpia)) continue;

        const sinCamposConocidos = stripKnownFields(limpia);
        if (!sinCamposConocidos) continue;

        const palabras = sinCamposConocidos.split(/\s+/);
        const firstName = palabras[0];
        const lastName = palabras.slice(1).join(' ');

        if (firstName && !/^\d+$/.test(firstName) && !/^\d/.test(firstName)) {
            return { firstName, lastName };
        }

        // Si la linea completa tiene comas, probar dividir por comas
        if (limpia.includes(',') && !linea.includes('\n')) {
            const partes = limpia.split(',').map(p => p.trim()).filter(p => p);
            for (const parte of partes) {
                if (esSoloTelefono(parte, rawPhone)) continue;
                if (esSoloUnidad(parte)) continue;
                if (esSoloFecha(parte)) continue;
                if (esSoloEmail(parte)) continue;
                if (esSoloNumero(parte)) continue;
                const sinFld = stripKnownFields(parte);
                if (!sinFld) continue;
                const p = sinFld.split(/\s+/);
                if (p[0] && !/^\d+$/.test(p[0]) && !/^\d/.test(p[0])) {
                    return { firstName: p[0], lastName: p.slice(1).join(' ') };
                }
            }
        }
    }

    return { firstName: '', lastName: '' };
}

function stripKnownFields(texto) {
    let result = texto
        // Unit/Apt con número (debe ir ANTES de #\d+ para capturar "unit #88" completo)
        .replace(/(?:Unit|Apt|Suite|Unidad)\s*[:#]?\s*\d+/gi, '')
        .replace(/#\d+[A-Za-z]?/g, '')
        .replace(/Phone\s*[:]?\s*[\d\s\-().+]+/gi, '')
        .replace(/M\/I\s*\d+[\/'-]\d+/gi, '')
        .replace(/Move\s*[-]?\s*[Ii]n\s*[:#]?\s*\d+[\/'-]\d+/gi, '')
        .replace(/Move[-][Ii]n\s*[:]?\s*\d+[\/'-]\d+/gi, '')
        .replace(/Lease\s*Date\s*[:#]?\s*\d+[\/'-]\d+/gi, '')
        .replace(/Mudanza\s*[:#]?\s*\d+[\/'-]\d+/gi, '')
        .replace(/Check\s*[Ii]n\s*[:#]?\s*\d+[\/'-]\d+/gi, '')
        .replace(/\b\d{1,2}[\/'-]\d{1,2}([\/'-]\d{4})?\b/g, '')
        .replace(/^Name\s*[:]?\s*/i, '')
        .replace(/^Email\s*[:]?\s*\S+@\S+/gi, '')
        // Eliminar números telefónicos sueltos: +1XXX-XXX-XXXX, (XXX) XXX-XXXX, etc.
        .replace(/\+?\d{1,3}[-.\s]?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g, '')
        .replace(/\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    result = result.replace(/^[,.\s]+$/, '').trim();

    // Limpiar comas residuales y espacios múltiples
    result = result
        .replace(/,+/g, ',')
        .replace(/,\s*,/g, ',')
        .replace(/^[,.\s]+/, '')
        .replace(/[,.\s]+$/, '')
        .replace(/\s{2,}/g, ' ')
        .trim();

    return result;
}

function esSoloTelefono(limpia, rawPhone) {
    if (!rawPhone) return false;
    const soloNumeros = limpia.replace(/\D/g, '');
    if (!soloNumeros) return false;

    // La línea debe contener SOLO caracteres de teléfono: dígitos, +, -, ., espacios, ()
    return /^[\d\s\-().+]+$/.test(limpia);
}

function esSoloUnidad(limpia) {
    return /^(#\d+|Unit\s*\d+|Apt\s*\d+|Suite\s*\d+|Unidad\s*\d+)$/i.test(limpia);
}

function esSoloFecha(limpia) {
    return /^(M\/I\s*\d{1,2}[\/'-]\d{1,2}|Move\s*[Ii]n\s*\d{1,2}[\/'-]\d{1,2}|\d{1,2}[\/'-]\d{1,2}([\/'-]\d{4})?)$/i.test(limpia);
}

function esSoloEmail(limpia) {
    return /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(limpia);
}

function esSoloNumero(limpia) {
    return /^\d+(\.\d+)?$/.test(limpia);
}
