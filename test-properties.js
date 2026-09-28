import "dotenv/config";
import {
    cargarProperties,
    buscarProperty,
    construirAddressCompleta,
    getPropertiesCache
} from "./services/properties.js";

/**
 * Prueba de conexión con Google Sheets.
 * Uso:  node test-properties.js "The Maxwell" 4308
 */

const nombre = process.argv[2];
const unit = process.argv[3] || "1234";

try {
    const mapa = await cargarProperties();
    console.log(`\n✅ Conexión OK. ${mapa.size} propiedades leídas.`);
    const c = getPropertiesCache();
    console.log(`   Fuente: ${c.fuente} | Origen: ${c.origen}\n`);

    console.log("Primeras 5 propiedades:");
    [...mapa.values()].slice(0, 5).forEach(p => {
        console.log(`  • ${p.name} → ${p.address} | ${p.city} ${p.state} ${p.zip}`);
    });

    if (nombre) {
        const p = buscarProperty(nombre);
        if (!p) {
            console.log(`\n❌ No encontré "${nombre}". Revisa cómo está escrita en la hoja.`);
        } else {
            console.log(`\n🔎 "${nombre}" con unit ${unit}:`);
            console.log(`   ${construirAddressCompleta(p, unit)}`);
        }
    } else {
        console.log("\n(Pásale un nombre de propiedad para probar la dirección: node test-properties.js \"The Maxwell\" 4308)");
    }
} catch (err) {
    console.error("\n❌ Falló:", err.message);
    console.error("\nRevisa:");
    console.error("  1. ¿PROPERTIES_SHEET_ID correcto en .env?");
    console.error("  2. ¿Compartiste la hoja con el client_email de la service account?");
    console.error("  3. ¿Habilitaste la Google Sheets API en el proyecto?");
    console.error("  4. ¿El JSON de GOOGLE_SERVICE_ACCOUNT está en UNA sola línea y entre comillas simples?");
    process.exit(1);
}
