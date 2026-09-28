/**
 * Logica pura de /webhook/marcar-procesado.
 *
 * Traduce lo que hay en los custom fields de GHL a lo que espera la hoja, y
 * decide en que fila y en que pestaña va. Sin llamadas de red, para poder
 * probarlo con datos reales sin escribir nada.
 */

import { celda } from "./pago.js";

const MESES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
];

/** "1000Mbps" -> "1000". En la hoja las velocidades van sin letras. */
export function speedDesdePlan(plan) {
    const m = String(plan || "").match(/\d+/);
    return m ? m[0] : "";
}

/**
 * El multi-select "Sales" gobierna dos columnas de la hoja.
 *
 *   AT&T            -> internet YES / electricidad NO
 *   Electricity     -> internet NO  / electricidad YES
 *   los dos         -> YES / YES
 *
 * GHL manda los multi-select a veces como arreglo y a veces como texto
 * separado por comas, segun el shape del payload. Se aceptan los dos.
 */
export function ventasDesdeSales(sales) {
    const lista = Array.isArray(sales)
        ? sales
        : String(sales || "").split(/[,;|]/);

    const limpio = lista.map(v => String(v).trim().toLowerCase()).filter(Boolean);
    const internet = limpio.some(v => v.includes("at&t") || v.includes("att") || v.includes("internet"));
    const electricidad = limpio.some(v => v.includes("electric"));

    return {
        internet: internet ? "YES" : "NO",
        electricidad: electricidad ? "YES" : "NO",
        vendioAlgo: internet || electricidad
    };
}

/**
 * Saca año, mes y dia LITERALES, sin convertir a hora local.
 *
 * El bug que esto evita: el date picker de GHL puede devolver
 * "2026-10-01T00:00:00.000Z". Si eso se pasa por new Date() y se leen las
 * partes locales, en UTC-5 se convierte en el 30 de septiembre — y no solo
 * queda mal la fecha: la fila se va a la pestaña equivocada.
 *
 * @returns {Object|null} { anio, mes, dia }
 */
export function partesDeFecha(valor) {
    const t = String(valor ?? "").trim();
    if (!t) return null;

    // Epoch en milisegundos
    if (/^\d{10,}$/.test(t)) {
        const d = new Date(Number(t));
        if (Number.isNaN(d.getTime())) return null;
        return { anio: d.getUTCFullYear(), mes: d.getUTCMonth() + 1, dia: d.getUTCDate() };
    }

    // ISO o YYYY-MM-DD
    const iso = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (iso) return { anio: +iso[1], mes: +iso[2], dia: +iso[3] };

    // M/D/YYYY o M/D/YY
    const mdy = t.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
    if (mdy) {
        const anio = mdy[3].length === 2 ? 2000 + +mdy[3] : +mdy[3];
        return { anio, mes: +mdy[1], dia: +mdy[2] };
    }

    return null;
}

/** "2026-10-15" -> "10/15/26", el formato de la hoja. */
export function fechaParaHoja(valor) {
    const p = partesDeFecha(valor);
    if (!p) return "";
    return `${p.mes}/${p.dia}/${String(p.anio).slice(-2)}`;
}

/** "2026-10-15" -> "October/2026", tu formato de pestañas. */
export function pestanaDesdeFecha(valor) {
    const p = partesDeFecha(valor);
    if (!p || p.mes < 1 || p.mes > 12) return "";
    return `${MESES[p.mes - 1]}/${p.anio}`;
}

/**
 * Elige la fila a procesar.
 *
 * A diferencia de marcar-pago, aqui la fila buena es la que TODAVIA NO tiene
 * property type. Pero tambien hay que poder corregir una ya procesada, asi
 * que el orden es:
 *
 *   1. exactamente una sin procesar -> esa
 *   2. ninguna sin procesar pero una sola en total -> esa (correccion)
 *   3. ninguna fila -> se crea desde cero
 *   4. cualquier otro caso -> ambiguo, no se toca nada
 *
 * @returns {Object} { estado: "ok"|"crear"|"ambiguo", elegido, candidatos }
 */
export function elegirFilaProcesado(candidatos) {
    const sinProcesar = candidatos.filter(c => !celda(c.datos, c.cols.propertytype));

    if (sinProcesar.length === 1) return { estado: "ok", elegido: sinProcesar[0], candidatos };
    if (sinProcesar.length === 0 && candidatos.length === 1) {
        return { estado: "ok", elegido: candidatos[0], correccion: true, candidatos };
    }
    if (candidatos.length === 0) return { estado: "crear", elegido: null, candidatos };
    return { estado: "ambiguo", elegido: null, candidatos };
}

/** Los seis valores que se escriben en la hoja. */
export function valoresParaHoja({ propertyType, installDate, sales, provider, plan }) {
    const ventas = ventasDesdeSales(sales);
    return {
        propertytype: String(propertyType || "").trim(),
        installDate: fechaParaHoja(installDate),
        internetsold: ventas.internet,
        electricitysold: ventas.electricidad,
        // Sin internet no hay proveedor ni velocidad: la electricidad solo se
        // vende o no se vende, no tiene compañia asociada en la hoja.
        provider: ventas.internet === "YES" ? String(provider || "").trim() : "",
        speed: ventas.internet === "YES" ? speedDesdePlan(plan) : ""
    };
}
